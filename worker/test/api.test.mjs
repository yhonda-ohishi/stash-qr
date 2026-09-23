// API の結合テスト。空のローカル D1 に migration を当て、wrangler dev を立てて叩く。
// Cloudflare Access の代わりに、テスト内で RSA 鍵を作って偽の JWKS を立て、
// 自分で署名した JWT を Cf-Access-Jwt-Assertion に載せる (署名検証は本物の WebCrypto)。
// 実行: npm test (先に cargo test、続けてこれ)。
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const WRANGLER = join(import.meta.dirname, "..", "node_modules", ".bin", "wrangler");
const CWD = join(import.meta.dirname, "..");
const AUD = "test-aud";
const EMAIL = "me@example.com";

let base; // Access 設定あり
let bareBase; // Access 設定なし (fail closed の確認用)
let issuer;
let state;
let jwks;
let flickrSrv;
const devs = [];

// 偽の Flickr。受け取ったアップロードと、署名の検証結果をここに残す。
const FLICKR = { consumerKey: "ck-test", consumerSecret: "cs-test", token: "at-test", tokenSecret: "ats-test" };
const flickr = { uploads: [], photos: new Map(), failUploads: false, nextId: 9000, badSignatures: 0 };

function pct(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
function oauthSignature(method, url, params) {
  const norm = Object.entries(params)
    .filter(([k]) => k !== "oauth_signature")
    .map(([k, v]) => [pct(k), pct(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [method, pct(url), pct(norm)].join("&");
  const key = `${pct(FLICKR.consumerSecret)}&${pct(FLICKR.tokenSecret)}`;
  return createHmac("sha1", key).update(base).digest("base64");
}

async function flickrHandler(req, res, origin) {
  const url = new URL(req.url, origin);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (req.method === "POST" && url.pathname === "/services/upload/") {
    if (flickr.failUploads) return res.writeHead(500).end("down");
    const form = await new Request(url, { method: "POST", headers: req.headers, body }).formData();
    const params = {};
    for (const [k, v] of form) if (k !== "photo") params[k] = v;
    const photo = form.get("photo");
    if (params.oauth_signature !== oauthSignature("POST", `${origin}/services/upload/`, params)) {
      flickr.badSignatures++;
      return res.writeHead(200).end('<rsp stat="fail"><err code="96" msg="Invalid signature" /></rsp>');
    }
    const id = String(flickr.nextId++);
    const bytes = Buffer.from(await photo.arrayBuffer());
    flickr.uploads.push({ id, params, type: photo.type, bytes });
    flickr.photos.set(id, { server: "65535", secret: `sec${id}`, bytes });
    return res.writeHead(200).end(`<?xml version="1.0"?><rsp stat="ok"><photoid>${id}</photoid></rsp>`);
  }
  if (req.method === "GET" && url.pathname === "/services/rest/") {
    const params = Object.fromEntries(url.searchParams);
    for (const m of (req.headers.authorization ?? "").matchAll(/(\w+)="([^"]*)"/g)) params[m[1]] = decodeURIComponent(m[2]);
    if (params.oauth_signature !== oauthSignature("GET", `${origin}/services/rest/`, params)) {
      flickr.badSignatures++;
      return res.writeHead(200).end(JSON.stringify({ stat: "fail", code: 96, message: "Invalid signature" }));
    }
    const p = flickr.photos.get(params.photo_id);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(p ? { stat: "ok", photo: { id: params.photo_id, server: p.server, secret: p.secret } } : { stat: "fail", code: 1, message: "Photo not found" }));
  }
  const m = url.pathname.match(/^\/static\/(\w+)\/(\d+)_(\w+)_(\w)\.jpg$/);
  if (req.method === "GET" && m) {
    const p = flickr.photos.get(m[2]);
    if (!p || p.server !== m[1] || p.secret !== m[3]) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "image/jpeg", "x-size": m[4] });
    return res.end(p.bytes);
  }
  res.writeHead(404).end();
}

// JWKS に載せる鍵と、載せない鍵 (なりすまし用)
const good = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rogue = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid";

async function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function jwt(claims = {}, { key = good.privateKey, kid = KID, alg = "RS256" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iss: issuer, aud: [AUD], iat: now, exp: now + 600, email: EMAIL, ...claims }),
  );
  const sig = sign("sha256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${b64url(sig)}`;
}

async function startDev(vars) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const varArgs = Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
  // 自分で起こしたプロセスグループだけを後で止める (名前で kill しない)。
  const dev = spawn(
    WRANGLER,
    ["dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", state, ...varArgs],
    { cwd: CWD, detached: true, stdio: "ignore" },
  );
  devs.push(dev);
  for (let i = 0; i < 600; i++) {
    try {
      await fetch(`${url}/api/item-types`);
      return url;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("wrangler dev did not come up");
}

before(async () => {
  const pub = good.publicKey.export({ format: "jwk" });
  const jwksPort = await freePort();
  issuer = `http://127.0.0.1:${jwksPort}`;
  jwks = createHttpServer((req, res) => {
    if (req.url !== "/cdn-cgi/access/certs") return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [{ ...pub, kid: KID, alg: "RS256", use: "sig" }] }));
  }).listen(jwksPort, "127.0.0.1");

  const flickrPort = await freePort();
  const flickrOrigin = `http://127.0.0.1:${flickrPort}`;
  flickrSrv = createHttpServer((req, res) => {
    flickrHandler(req, res, flickrOrigin).catch((e) => res.writeHead(500).end(String(e)));
  }).listen(flickrPort, "127.0.0.1");

  state = mkdtempSync(join(tmpdir(), "stash-qr-test-"));
  execFileSync(WRANGLER, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", state], {
    cwd: CWD,
    stdio: "ignore",
  });
  base = await startDev({
    ACCESS_ISSUER: issuer,
    ACCESS_AUD: AUD,
    FLICKR_UPLOAD_URL: `${flickrOrigin}/services/upload/`,
    FLICKR_REST_URL: `${flickrOrigin}/services/rest/`,
    FLICKR_STATIC_BASE: `${flickrOrigin}/static`,
    // 本番では Worker secret。ローカルでは --var で同じ名前の文字列として渡す
    FLICKR_CONSUMER_KEY: FLICKR.consumerKey,
    FLICKR_CONSUMER_SECRET: FLICKR.consumerSecret,
    FLICKR_ACCESS_TOKEN_JSON: JSON.stringify({ token: FLICKR.token, secret: FLICKR.tokenSecret, userNsid: "1@N00", username: "t" }),
  });
  // wrangler.toml の [vars] には本番の値が入っているので、空で上書きして未設定を作る
  bareBase = await startDev({ ACCESS_ISSUER: "", ACCESS_AUD: "" });
});

after(() => {
  for (const d of devs) if (d.pid) process.kill(-d.pid, "SIGTERM");
  jwks?.close();
  flickrSrv?.close();
  if (state) rmSync(state, { recursive: true, force: true });
});

async function call(method, path, body, { token = jwt(), url = base } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token !== null) headers["cf-access-jwt-assertion"] = token;
  const res = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const post = (p, b, opts) => call("POST", p, b, opts);

// API に出していない表 (movements) を確かめるため、ローカル D1 を直接読む。
function sql(query) {
  const out = execFileSync(
    WRANGLER,
    ["d1", "execute", "DB", "--local", "--persist-to", state, "--json", "--command", query],
    { cwd: CWD, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return JSON.parse(out)[0].results;
}

describe("containers", () => {
  test("作成・取得・パンくず・子の一覧", async () => {
    const room = await post("/api/containers", { kind: "room", name: "倉庫" });
    assert.equal(room.status, 201);
    assert.match(room.body.id, /^[0-9A-HJKMNP-TV-Z]{6}$/);
    const box = await post("/api/containers", { kind: "box", name: "ケーブル箱", parent_id: room.body.id });
    const bag = await post("/api/containers", { kind: "bag", parent_id: box.body.id.toLowerCase() });
    assert.equal(bag.status, 201, "小文字の parent_id も正規化して受ける");

    const got = await call("GET", `/api/containers/${bag.body.id}`);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.breadcrumb.map((c) => c.id), [room.body.id, box.body.id, bag.body.id]);

    const boxView = await call("GET", `/api/containers/${box.body.id}`);
    assert.deepEqual(boxView.body.children.map((c) => c.id), [bag.body.id]);
  });

  test("存在しない親・不正な入力", async () => {
    assert.equal((await post("/api/containers", { kind: "bag", parent_id: "ZZZZZZ" })).status, 404);
    assert.equal((await post("/api/containers", { kind: "" })).status, 400);
    assert.equal((await post("/api/containers", { kind: "bag", parent_id: "U!" })).status, 400);
    assert.equal((await call("GET", "/api/containers/ZZZZZZ")).status, 404);
    assert.equal((await call("GET", "/api/containers/not-an-id")).status, 404);
  });

  test("PATCH は名前・種別・メモだけ", async () => {
    const c = await post("/api/containers", { kind: "bag", name: "a" });
    const p = await call("PATCH", `/api/containers/${c.body.id}`, { name: "b", memo: null });
    assert.equal(p.status, 200);
    assert.equal(p.body.name, "b");
    assert.equal(p.body.kind, "bag");
    assert.equal((await call("PATCH", `/api/containers/${c.body.id}`, { parent_id: null })).status, 400);
    assert.equal((await call("PATCH", `/api/containers/${c.body.id}`, { kind: "" })).status, 400);
    assert.equal((await call("PATCH", "/api/containers/ZZZZZZ", { name: "x" })).status, 404);
  });

  test("移動: 循環は 409、正常な移動は movements に残る", async () => {
    const a = await post("/api/containers", { kind: "shelf" });
    const b = await post("/api/containers", { kind: "box", parent_id: a.body.id });
    const c = await post("/api/containers", { kind: "bag", parent_id: b.body.id });
    const other = await post("/api/containers", { kind: "shelf" });

    assert.equal((await post(`/api/containers/${a.body.id}/move`, { parent_id: a.body.id })).status, 409, "自分自身へ");
    assert.equal((await post(`/api/containers/${a.body.id}/move`, { parent_id: c.body.id })).status, 409, "孫へ");
    assert.equal((await post(`/api/containers/${a.body.id}/move`, { parent_id: "ZZZZZZ" })).status, 404);
    assert.equal((await post(`/api/containers/${a.body.id}/move`, {})).status, 400);

    const moved = await post(`/api/containers/${b.body.id}/move`, { parent_id: other.body.id });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.parent_id, other.body.id);
    const crumbs = (await call("GET", `/api/containers/${c.body.id}`)).body.breadcrumb.map((x) => x.id);
    assert.deepEqual(crumbs, [other.body.id, b.body.id, c.body.id]);

    const toRoot = await post(`/api/containers/${b.body.id}/move`, { parent_id: null });
    assert.equal(toRoot.body.parent_id, null);

    // 失敗した 3 回は何も残さず、成功した 2 回だけが移動元・移動先付きで残る
    assert.deepEqual(
      sql(`SELECT actor, container_id, from_id, to_id FROM movements WHERE kind = 'container_move' AND container_id IN ('${a.body.id}', '${b.body.id}') ORDER BY at`),
      [
        { actor: EMAIL, container_id: b.body.id, from_id: a.body.id, to_id: other.body.id },
        { actor: EMAIL, container_id: b.body.id, from_id: other.body.id, to_id: null },
      ],
    );
  });

  test("削除は空のときだけ", async () => {
    const p = await post("/api/containers", { kind: "box" });
    const ch = await post("/api/containers", { kind: "bag", parent_id: p.body.id });
    assert.equal((await call("DELETE", `/api/containers/${p.body.id}`)).status, 409);
    assert.equal((await call("DELETE", `/api/containers/${ch.body.id}`)).status, 204);
    assert.equal((await call("DELETE", `/api/containers/${p.body.id}`)).status, 204);
    assert.equal((await call("DELETE", `/api/containers/${p.body.id}`)).status, 404);
  });
});

describe("stock", () => {
  test("出し入れ・負にならない・子孫込みの合計・0 本で消える", async () => {
    const it = await post("/api/item-types", { category: "cable", name: "A-C", tracking: "quantity", attrs: { end1: "A", end2: "C" } });
    assert.equal(it.status, 201);
    assert.deepEqual(it.body.attrs, { end1: "A", end2: "C" });
    const box = await post("/api/containers", { kind: "box" });
    const bag = await post("/api/containers", { kind: "bag", parent_id: box.body.id });

    const in1 = await post(`/api/containers/${bag.body.id}/stock`, { item_type_id: it.body.id, delta: 3, note: "初回" });
    assert.equal(in1.status, 200);
    assert.equal(in1.body.qty, 3);
    await post(`/api/containers/${box.body.id}/stock`, { item_type_id: it.body.id, delta: 2 });

    const over = await post(`/api/containers/${bag.body.id}/stock`, { item_type_id: it.body.id, delta: -4 });
    assert.equal(over.status, 409);
    assert.deepEqual(
      sql(`SELECT kind, qty_delta, note FROM movements WHERE container_id = '${bag.body.id}' ORDER BY at`),
      [{ kind: "stock_in", qty_delta: 3, note: "初回" }],
      "足りない出庫は記録されない",
    );

    const view = await call("GET", `/api/containers/${box.body.id}`);
    assert.deepEqual(view.body.stock.map((s) => s.qty), [2], "直下は箱の 2 本だけ");
    assert.deepEqual(view.body.totals.stock.map((s) => s.qty), [5], "子孫込みで 5 本");

    const out = await post(`/api/containers/${bag.body.id}/stock`, { item_type_id: it.body.id, delta: -3 });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.qty, 0);
    assert.deepEqual((await call("GET", `/api/containers/${bag.body.id}`)).body.stock, []);
    // 0 本の行は消えているので、袋は空として削除できる
    assert.equal((await call("DELETE", `/api/containers/${bag.body.id}`)).status, 204);
  });

  test("入力の検証と理由の出し分け", async () => {
    const box = await post("/api/containers", { kind: "box" });
    const dev = await post("/api/item-types", { category: "device", name: "TM-L100", tracking: "individual" });
    assert.equal((await post(`/api/containers/${box.body.id}/stock`, { item_type_id: dev.body.id, delta: 1 })).status, 422);
    assert.equal((await post(`/api/containers/${box.body.id}/stock`, { item_type_id: "nope", delta: 1 })).status, 404);
    assert.equal((await post(`/api/containers/ZZZZZZ/stock`, { item_type_id: dev.body.id, delta: 1 })).status, 404);
    assert.equal((await post(`/api/containers/${box.body.id}/stock`, { item_type_id: dev.body.id, delta: 0 })).status, 400);
    assert.equal((await post(`/api/containers/${box.body.id}/stock`, { item_type_id: dev.body.id, delta: 1.5 })).status, 400);
  });
});

describe("item types", () => {
  test("重複は 409 で既存を返す・検索", async () => {
    const a = await post("/api/item-types", { category: "cable", name: "C-C", tracking: "quantity" });
    const dup = await post("/api/item-types", { category: "cable", name: "C-C", tracking: "quantity" });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.item_type.id, a.body.id);
    assert.equal((await post("/api/item-types", { category: "cable", name: "x", tracking: "bulk" })).status, 400);

    const found = await call("GET", "/api/item-types?q=C-C");
    assert.ok(found.body.item_types.some((t) => t.id === a.body.id));
    const pct = await call("GET", "/api/item-types?q=%25");
    assert.deepEqual(pct.body.item_types, [], "% は文字として扱う");
  });
});

describe("Cloudflare Access", () => {
  const status = async (token, url) => (await call("GET", "/api/item-types", undefined, { token, url })).status;

  test("正しいトークンだけ通す", async () => {
    assert.equal(await status(jwt()), 200);
    assert.equal(await status(jwt({ aud: AUD })), 200, "aud は文字列でもよい");
  });

  test("ヘッダ無し・壊れたトークンは 401", async () => {
    assert.equal(await status(null), 401);
    assert.equal(await status("garbage"), 401);
    assert.equal(await status("a.b.c"), 401);
  });

  test("署名・鍵・アルゴリズムが違えば 401", async () => {
    assert.equal(await status(jwt({}, { key: rogue.privateKey })), 401, "JWKS に無い鍵で kid だけ詐称");
    assert.equal(await status(jwt({}, { kid: "unknown" })), 401, "知らない kid");
    const t = jwt();
    const [h, p] = t.split(".");
    assert.equal(await status(`${h}.${p}.`), 401, "署名を空に");
    const none = `${b64url(JSON.stringify({ alg: "none", kid: KID }))}.${p}.`;
    assert.equal(await status(none), 401, "alg=none");
    const tampered = b64url(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url")), email: "evil@example.com" }));
    assert.equal(await status(`${h}.${tampered}.${t.split(".")[2]}`), 401, "中身の書き換え");
  });

  test("claim が合わなければ 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal(await status(jwt({ iss: "https://other.cloudflareaccess.com" })), 401);
    assert.equal(await status(jwt({ aud: ["other-aud"] })), 401);
    assert.equal(await status(jwt({ exp: now - 120 })), 401, "期限切れ");
    assert.equal(await status(jwt({ nbf: now + 600 })), 401, "まだ有効でない");
    assert.equal(await status(jwt({ email: "" })), 401, "持ち主が無い");
  });

  test("サービストークン (Android) は common_name を actor に残す", async () => {
    const token = jwt({ email: undefined, common_name: "android.access" });
    const box = await post("/api/containers", { kind: "box" }, { token });
    assert.equal(box.status, 201);
    const it = await post("/api/item-types", { category: "cable", name: "svc", tracking: "quantity" }, { token });
    await post(`/api/containers/${box.body.id}/stock`, { item_type_id: it.body.id, delta: 1 }, { token });
    assert.deepEqual(sql(`SELECT actor FROM movements WHERE container_id = '${box.body.id}'`), [{ actor: "android.access" }]);
  });

  test("ACCESS_* が未設定なら正しいトークンでも 503 (fail closed)", async () => {
    assert.equal(await status(jwt(), bareBase), 503);
    assert.equal(await status(null, bareBase), 503);
  });
});

describe("photos (Flickr)", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

  async function upload(query, { bytes = JPEG, type = "image/jpeg", method = "POST", path = "/api/photos" } = {}) {
    const res = await fetch(`${base}${path}${query}`, {
      method,
      headers: { "content-type": type, "cf-access-jwt-assertion": jwt() },
      body: bytes,
    });
    return { status: res.status, body: await res.json() };
  }

  async function image(id, size) {
    const q = size ? `?size=${size}` : "";
    return fetch(`${base}/api/photos/${id}${q}`, { headers: { "cf-access-jwt-assertion": jwt() } });
  }

  test("非公開・マシンタグ付きで Flickr に上がり、署名が正しい", async () => {
    const box = await post("/api/containers", { kind: "box" });
    const r = await upload(`?kind=container&container_id=${box.body.id.toLowerCase()}`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.photo.status, "uploaded");
    assert.equal(r.body.photo.container_id, box.body.id);
    assert.equal(flickr.badSignatures, 0);

    const up = flickr.uploads.at(-1);
    assert.deepEqual(up.bytes, JPEG);
    assert.equal(up.type, "image/jpeg");
    assert.equal(up.params.is_public, "0");
    assert.equal(up.params.is_friend, "0");
    assert.equal(up.params.is_family, "0");
    assert.equal(up.params.hidden, "2");
    assert.deepEqual(up.params.tags.split(" ").sort(), [
      `stashqr:container=${box.body.id}`,
      "stashqr:kind=container",
      `stashqr:photo=${r.body.photo.id}`,
    ]);
    // Flickr 側の識別子はクライアントに返さない
    assert.ok(!JSON.stringify(r.body).includes(up.id));
  });

  test("画像は Worker が中身を返す (静的 URL を渡さない)", async () => {
    const r = await upload("?kind=label");
    const res = await image(r.body.photo.id, "z");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.match(res.headers.get("cache-control"), /private/);
    assert.equal(res.headers.get("location"), null);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);
    // 2 回目は D1 に残した server/secret を使う (getInfo を引き直さなくても取れる)
    assert.equal((await image(r.body.photo.id)).status, 200);
    assert.equal((await image(r.body.photo.id, "o")).status, 400, "原寸は出さない");
    assert.equal((await image("nope")).status, 404);
  });

  test("Flickr が落ちていても 201 で送信待ちに残り、送り直せる", async () => {
    flickr.failUploads = true;
    const r = await upload("?kind=asset");
    flickr.failUploads = false;
    assert.equal(r.status, 201);
    assert.equal(r.body.photo.status, "pending");
    assert.match(r.body.photo.upload_error, /HTTP 500/);
    assert.equal((await image(r.body.photo.id)).status, 409);

    const pending = await call("GET", "/api/photos?status=pending");
    assert.ok(pending.body.photos.some((p) => p.id === r.body.photo.id));

    const before = flickr.uploads.length;
    const retry = await upload("", { method: "PUT", path: `/api/photos/${r.body.photo.id}/image` });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.photo.status, "uploaded");
    assert.equal(retry.body.photo.upload_error, null);
    assert.equal(flickr.uploads.length, before + 1);

    // 送信済みの送り直しは何もしない (二重に上げない)
    const again = await upload("", { method: "PUT", path: `/api/photos/${r.body.photo.id}/image` });
    assert.equal(again.status, 200);
    assert.equal(flickr.uploads.length, before + 1);
    const after = await call("GET", "/api/photos?status=pending");
    assert.ok(!after.body.photos.some((p) => p.id === r.body.photo.id));
  });

  test("入力の検証", async () => {
    assert.equal((await upload("?kind=other")).status, 400);
    assert.equal((await upload("?kind=label", { type: "application/json" })).status, 415);
    assert.equal((await upload("?kind=label", { bytes: Buffer.alloc(0) })).status, 400);
    assert.equal((await upload("?kind=container&container_id=ZZZZZZ")).status, 404);
    assert.equal((await upload("?kind=asset&asset_id=nope")).status, 404);
    assert.equal((await upload("", { method: "PUT", path: "/api/photos/nope/image" })).status, 404);
    assert.equal((await call("GET", "/api/photos")).status, 400);
  });
});
