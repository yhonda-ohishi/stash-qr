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

// 偽の Gemini。次に返す判定を決めておき、受け取ったリクエストを残す。
// responseSchema に stock があればコンテナ判定 (container)、無ければラベル判定 (next) を返す。
const GEMINI_KEY = "gk-test";
const gemini = { requests: [], next: null, container: null, fail: false };

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
  if (req.method === "POST" && /^\/v1beta\/models\/[^/]+:generateContent$/.test(url.pathname)) {
    const reqBody = JSON.parse(body.toString());
    gemini.requests.push({ path: url.pathname, key: req.headers["x-goog-api-key"], search: url.search, body: reqBody });
    if (req.headers["x-goog-api-key"] !== GEMINI_KEY) return res.writeHead(403).end("bad key");
    if (gemini.fail) return res.writeHead(503).end("overloaded");
    res.writeHead(200, { "content-type": "application/json" });
    const answer = reqBody.generationConfig?.responseSchema?.properties?.stock ? gemini.container : gemini.next;
    return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }));
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
    GEMINI_ENDPOINT: `${flickrOrigin}/v1beta`,
    GEMINI_API_KEY: GEMINI_KEY,
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

// sql() は 1 回ごとに wrangler を起こす (約 1 秒)。続けて呼ぶと keep-alive の接続が
// サーバー側で閉じられ、次の fetch が使い回したソケットで "other side closed" になる。
// 応答を 1 バイトも受け取らずに切れたときだけ、新しい接続で 1 回投げ直す。
async function fetchFresh(url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (e.cause?.code !== "UND_ERR_SOCKET") throw e;
    return fetch(url, init);
  }
}

async function call(method, path, body, { token = jwt(), url = base } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token !== null) headers["cf-access-jwt-assertion"] = token;
  const res = await fetchFresh(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const post = (p, b, opts) => call("POST", p, b, opts);

// HTML ページ (/c/:id, /a/:id) は JSON ではないので、本文をそのまま返す。
async function getHtml(path, { token = jwt(), url = base } = {}) {
  const headers = {};
  if (token !== null) headers["cf-access-jwt-assertion"] = token;
  const res = await fetchFresh(`${url}${path}`, { method: "GET", headers });
  return { status: res.status, contentType: res.headers.get("content-type"), text: await res.text() };
}

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
    const res = await fetchFresh(`${base}${path}${query}`, {
      method,
      headers: { "content-type": type, "cf-access-jwt-assertion": jwt() },
      body: bytes,
    });
    return { status: res.status, body: await res.json() };
  }

  async function image(id, size) {
    const q = size ? `?size=${size}` : "";
    return fetchFresh(`${base}/api/photos/${id}${q}`, { headers: { "cf-access-jwt-assertion": jwt() } });
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

describe("assets (ラベル判定・個体)", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 0xff, 0xd9]);
  const judgeLabel = async () => {
    const res = await fetchFresh(`${base}/api/assets/judge-label`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", "cf-access-jwt-assertion": jwt() },
      body: JPEG,
    });
    return { status: res.status, body: await res.json() };
  };

  test("ラベル判定: Gemini に画像と schema を送り、写真は Flickr に残る", async () => {
    gemini.next = { maker: "EPSON", model: "TM-L100", serial: "X4ZL000001", other_text: null, confidence: 0.93 };
    const r = await judgeLabel();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.proposal.model, "TM-L100");
    assert.equal(r.body.model, "gemini-3.8-flash");
    assert.equal(r.body.photo.status, "uploaded");
    assert.deepEqual(r.body.matches, { serial: [], model: [] });

    const sent = gemini.requests.at(-1);
    assert.equal(sent.path, "/v1beta/models/gemini-3.8-flash:generateContent");
    assert.equal(sent.search, "", "キーは URL に載せない");
    assert.equal(sent.body.contents[0].parts[0].inlineData.data, JPEG.toString("base64"));
    assert.equal(sent.body.generationConfig.responseSchema.properties.serial.nullable, true);
    assert.equal(flickr.uploads.at(-1).params.tags.includes("stashqr:kind=label"), true);

    // 提案と写真の結び付きが D1 に残る
    const [j] = sql(`SELECT kind, model, proposal_json, final_json FROM ai_judgements WHERE id = '${r.body.judgement_id}'`);
    assert.equal(j.kind, "label");
    assert.equal(JSON.parse(j.proposal_json).serial, "X4ZL000001");
    assert.equal(j.final_json, null);
    assert.deepEqual(sql(`SELECT judgement_id FROM photos WHERE id = '${r.body.photo.id}'`), [{ judgement_id: r.body.judgement_id }]);
  });

  test("確定で個体ができ、提案と確定の両方が残る。同じシリアルは次の判定で一致する", async () => {
    gemini.next = { maker: "EPSON", model: "TM-L100", serial: "X4ZL000002", other_text: null, confidence: 0.9 };
    const j = await judgeLabel();
    const shelf = await post("/api/containers", { kind: "shelf" });
    // ユーザーがシリアルを直してから確定する
    const created = await post("/api/assets", {
      maker: "EPSON", model: "TM-L100", serial: "X4ZL000003",
      container_id: shelf.body.id, judgement_id: j.body.judgement_id, photo_id: j.body.photo.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const a = created.body.asset;
    assert.equal(a.item_name, "TM-L100", "品目は型番で自動作成");
    assert.equal(a.container_id, shelf.body.id);

    const [row] = sql(`SELECT proposal_json, final_json, asset_id FROM ai_judgements WHERE id = '${j.body.judgement_id}'`);
    assert.equal(JSON.parse(row.proposal_json).serial, "X4ZL000002");
    assert.equal(JSON.parse(row.final_json).serial, "X4ZL000003");
    assert.equal(row.asset_id, a.id);
    assert.deepEqual(sql(`SELECT asset_id FROM photos WHERE id = '${j.body.photo.id}'`), [{ asset_id: a.id }]);
    assert.deepEqual(sql(`SELECT kind, to_id, actor FROM movements WHERE asset_id = '${a.id}'`), [
      { kind: "asset_move", to_id: shelf.body.id, actor: EMAIL },
    ]);

    // 同じ判定は二度確定できない・同じ (maker, model, serial) は作れない
    assert.equal((await post("/api/assets", { model: "TM-L100", judgement_id: j.body.judgement_id })).status, 409);
    const dup = await post("/api/assets", { maker: "EPSON", model: "TM-L100", serial: "X4ZL000003" });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.asset.id, a.id);

    // 次のラベル判定: シリアル一致 (大文字小文字・前後空白は無視) と型番一致が返る
    gemini.next = { maker: "EPSON", model: "tm-l100", serial: " x4zl000003 ", confidence: 0.8 };
    const again = await judgeLabel();
    assert.deepEqual(again.body.matches.serial.map((x) => x.id), [a.id]);
    assert.ok(again.body.matches.model.some((x) => x.id === a.id));

    // コンテナの画面にも個体が出る
    const view = await call("GET", `/api/containers/${shelf.body.id}`);
    assert.deepEqual(view.body.assets.map((x) => x.id), [a.id]);
    assert.equal(view.body.totals.asset_count, 1);
  });

  test("取得・状態変更・移動", async () => {
    const box = await post("/api/containers", { kind: "box" });
    const a = (await post("/api/assets", { model: "A2338", serial: "SN-1", category: "device" })).body.asset;

    const moved = await post(`/api/assets/${a.id}/move`, { container_id: box.body.id });
    assert.equal(moved.status, 200);
    const got = await call("GET", `/api/assets/${a.id}`);
    assert.deepEqual(got.body.breadcrumb.map((c) => c.id), [box.body.id]);

    const lent = await call("PATCH", `/api/assets/${a.id}`, { status: "lent", memo: "貸出中" });
    assert.equal(lent.body.asset.status, "lent");
    const out = await post(`/api/assets/${a.id}/move`, { container_id: null });
    assert.equal(out.body.asset.container_id, null);
    assert.deepEqual(
      sql(`SELECT kind, from_id, to_id, note FROM movements WHERE asset_id = '${a.id}' ORDER BY at`),
      [
        { kind: "asset_move", from_id: null, to_id: box.body.id, note: null },
        { kind: "asset_status", from_id: null, to_id: null, note: "in_stock -> lent" },
        { kind: "asset_move", from_id: box.body.id, to_id: null, note: null },
      ],
    );

    assert.equal((await call("PATCH", `/api/assets/${a.id}`, { status: "gone" })).status, 400);
    assert.equal((await call("PATCH", `/api/assets/${a.id}`, { container_id: null })).status, 400);
    assert.equal((await post(`/api/assets/${a.id}/move`, { container_id: "ZZZZZZ" })).status, 404);
    assert.equal((await post("/api/assets/nope/move", { container_id: null })).status, 404);
    assert.equal((await call("GET", "/api/assets/nope")).status, 404);
  });

  test("入力の検証と数量品目との区別", async () => {
    assert.equal((await post("/api/assets", {})).status, 400, "品目が決まらない");
    assert.equal((await post("/api/assets", { model: "X", status: "gone" })).status, 400);
    assert.equal((await post("/api/assets", { model: "X", container_id: "ZZZZZZ" })).status, 404);
    const cable = await post("/api/item-types", { category: "cable", name: "USB-A-C", tracking: "quantity" });
    assert.equal((await post("/api/assets", { item_type_id: cable.body.id })).status, 422);
  });

  test("Gemini が落ちても写真は残り、502 で写真を返す", async () => {
    gemini.fail = true;
    const r = await judgeLabel();
    gemini.fail = false;
    assert.equal(r.status, 502);
    assert.equal(r.body.photo.status, "uploaded");
  });
});

describe("閲覧ページ (/c, /a) と検索", () => {
  test("/c/:id: パンくず・子・在庫・個体、名前は HTML エスケープされる", async () => {
    const room = await post("/api/containers", { kind: "room", name: "<script>alert(1)</script>" });
    const box = await post("/api/containers", { kind: "box", name: "箱", parent_id: room.body.id });
    const it = await post("/api/item-types", { category: "cable", name: "USB-ViewTest", tracking: "quantity" });
    await post(`/api/containers/${box.body.id}/stock`, { item_type_id: it.body.id, delta: 3 });
    const asset = (
      await post("/api/assets", { model: "ViewTestModel", serial: "ViewTestSerial", container_id: box.body.id })
    ).body.asset;

    const page = await getHtml(`/c/${box.body.id}`);
    assert.equal(page.status, 200);
    assert.match(page.contentType, /text\/html; charset=utf-8/);
    assert.ok(page.text.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "コンテナ名がエスケープされる");
    assert.ok(!page.text.includes("<script>alert(1)</script>"), "生の <script> は出さない");
    assert.ok(page.text.includes(`href="/c/${room.body.id}"`), "パンくずが親へリンクする");
    assert.ok(page.text.includes("USB-ViewTest"), "在庫の品目名が出る");
    assert.ok(page.text.includes(`href="/a/${asset.id}"`), "個体が /a/:id へリンクする");

    assert.equal((await getHtml("/c/ZZZZZZ")).status, 404);
  });

  test("/a/:id: 200・404・持ち出し中の表示", async () => {
    const asset = (await post("/api/assets", { model: "SoloViewModel", serial: "SoloViewSerial" })).body.asset;
    const page = await getHtml(`/a/${asset.id}`);
    assert.equal(page.status, 200);
    assert.match(page.contentType, /text\/html; charset=utf-8/);
    assert.ok(page.text.includes("SoloViewModel"));
    assert.ok(page.text.includes("持ち出し中"), "container_id が無ければ持ち出し中と出す");

    const box = await post("/api/containers", { kind: "box" });
    const placed = (await post("/api/assets", { model: "PlacedViewModel", container_id: box.body.id })).body.asset;
    assert.ok((await getHtml(`/a/${placed.id}`)).text.includes(`href="/c/${box.body.id}"`));

    assert.equal((await getHtml("/a/nope")).status, 404);
  });

  test("/c/:id と /a/:id: アプリ (PWA) で開くリンク /app/c/:id・/app/a/:id", async () => {
    const box = await post("/api/containers", { kind: "box", name: "アプリリンク箱" });
    const asset = (await post("/api/assets", { model: "AppLinkModel", serial: "AppLinkSerial" })).body.asset;
    assert.ok((await getHtml(`/c/${box.body.id}`)).text.includes(`href="/app/c/${box.body.id}"`));
    // 小文字で開いても正規化した ID でリンクする
    assert.ok((await getHtml(`/c/${box.body.id.toLowerCase()}`)).text.includes(`href="/app/c/${box.body.id}"`));
    assert.ok((await getHtml(`/a/${asset.id}`)).text.includes(`href="/app/a/${asset.id}"`));
  });

  test("検索: 品目名・型番・シリアルのヒットとパンくずのフルパス", async () => {
    const room = await post("/api/containers", { kind: "room", name: "検索部屋" });
    const box = await post("/api/containers", { kind: "box", name: "検索箱", parent_id: room.body.id });
    const it = await post("/api/item-types", { category: "cable", name: "SearchCableName", tracking: "quantity" });
    await post(`/api/containers/${box.body.id}/stock`, { item_type_id: it.body.id, delta: 5 });
    const asset = (
      await post("/api/assets", { model: "SearchModelXYZ", serial: "SearchSerialXYZ", container_id: box.body.id })
    ).body.asset;

    const byName = await call("GET", "/api/search?q=SearchCableName");
    assert.equal(byName.status, 200);
    assert.equal(byName.body.stock.length, 1);
    assert.equal(byName.body.stock[0].qty, 5);
    assert.deepEqual(byName.body.stock[0].breadcrumb.map((c) => c.id), [room.body.id, box.body.id]);

    const byModel = await call("GET", "/api/search?q=SearchModelXYZ");
    assert.equal(byModel.body.assets.length, 1);
    assert.equal(byModel.body.assets[0].id, asset.id);
    assert.deepEqual(byModel.body.assets[0].breadcrumb.map((c) => c.id), [room.body.id, box.body.id]);

    const bySerial = await call("GET", "/api/search?q=SearchSerialXYZ");
    assert.equal(bySerial.body.assets.length, 1);
    assert.equal(bySerial.body.assets[0].id, asset.id);

    const taken = await post("/api/assets", { model: "SearchNoContainerModel", serial: "SearchNoContainerSerial" });
    const noContainer = await call("GET", "/api/search?q=SearchNoContainerModel");
    assert.equal(noContainer.body.assets.length, 1);
    assert.equal(noContainer.body.assets[0].id, taken.body.asset.id);
    assert.deepEqual(noContainer.body.assets[0].breadcrumb, [], "container_id が無ければ breadcrumb は空配列");
  });

  test("% を含む q が誤ヒットしない", async () => {
    const box = await post("/api/containers", { kind: "box" });
    const exact = await post("/api/item-types", { category: "cable", name: "Percent%Weird", tracking: "quantity" });
    await post(`/api/containers/${box.body.id}/stock`, { item_type_id: exact.body.id, delta: 1 });
    const decoy = await post("/api/item-types", { category: "cable", name: "PercentXWeird", tracking: "quantity" });
    await post(`/api/containers/${box.body.id}/stock`, { item_type_id: decoy.body.id, delta: 1 });

    const r = await call("GET", `/api/search?q=${encodeURIComponent("Percent%Weird")}`);
    assert.deepEqual(r.body.stock.map((s) => s.item_type_name), ["Percent%Weird"]);
  });

  test("空の q は 400、上限は 50 件", async () => {
    assert.equal((await call("GET", "/api/search?q=")).status, 400);
    assert.equal((await call("GET", "/api/search?q=%20")).status, 400);
    assert.equal((await call("GET", "/api/search")).status, 400);
  });

  test("未認証の /c/:id と /api/search は 401", async () => {
    const box = await post("/api/containers", { kind: "box" });
    assert.equal((await getHtml(`/c/${box.body.id}`, { token: null })).status, 401);
    assert.equal((await call("GET", "/api/search?q=x", undefined, { token: null })).status, 401);
  });
});

describe("static assets (PWA)", () => {
  // web/dist は run_worker_first で常に Worker (Access) を通ってから配られる (worker/wrangler.toml)。
  // レスポンス本文は HTML/JSON ではなく text/html なので、call() (JSON 前提) ではなく素の fetch を使う。
  async function getRaw(path, { token = jwt(), url = base } = {}) {
    const headers = token === null ? {} : { "cf-access-jwt-assertion": token };
    return fetchFresh(`${url}${path}`, { headers });
  }

  test("認証ありの GET / は 200 で text/html", async () => {
    const res = await getRaw("/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  });

  test("認証ありの GET /some/route は index.html (SPA フォールバック)", async () => {
    const index = await (await getRaw("/")).text();
    const res = await getRaw("/some/route");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await res.text(), index);
  });

  test("未認証の GET / と GET /manifest.webmanifest (実在するファイル) は 401", async () => {
    assert.equal((await getRaw("/", { token: null })).status, 401);
    assert.equal((await getRaw("/manifest.webmanifest", { token: null })).status, 401);
  });

  test("GET /api/nope は 404 で JSON", async () => {
    const res = await call("GET", "/api/nope");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "not found" });
  });
});

describe("コンテナ判定と確定", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7, 0xff, 0xd9]);
  const judge = async (id, { token = jwt() } = {}) => {
    const headers = { "content-type": "image/jpeg" };
    if (token !== null) headers["cf-access-jwt-assertion"] = token;
    const res = await fetchFresh(`${base}/api/containers/${id}/judge`, { method: "POST", headers, body: JPEG });
    return { status: res.status, body: await res.json() };
  };
  const confirm = (jid, final, opts) => post(`/api/judgements/${jid}/confirm`, { final }, opts);
  const stockOf = (cid) =>
    sql(`SELECT t.category, t.name, s.qty FROM stock s JOIN item_types t ON t.id = s.item_type_id WHERE s.container_id = '${cid}' ORDER BY t.name`);
  const line = (category, name, qty) => ({ category, name, qty, attrs: { end1: null, end2: null, length: null, color: null, braided: null }, confidence: 0.9 });

  test("判定: 指示文に登録済みの数量品目を渡し、品目・個体を照合して今の中身と返す", async () => {
    const box = await post("/api/containers", { kind: "box" });
    const shelf = await post("/api/containers", { kind: "shelf" });
    const ac = await post("/api/item-types", { category: "cable", name: "J-A-C", tracking: "quantity" });
    await post(`/api/containers/${box.body.id}/stock`, { item_type_id: ac.body.id, delta: 2 });
    const serialHit = (await post("/api/assets", { maker: "EPSON", model: "J-TM1", serial: "J-SN-1", container_id: shelf.body.id })).body.asset;
    const m1 = (await post("/api/assets", { model: "J-TM2", serial: "J-SN-2" })).body.asset;
    await post("/api/assets", { model: "J-TM3", serial: "J-SN-3" });
    await post("/api/assets", { model: "J-TM3", serial: "J-SN-4" });

    gemini.container = {
      stock: [line("cable", "j-a-c", 3), line("other", "J-不明", 1)],
      assets: [
        { maker: null, model: "J-TM9", serial: "j-sn-1", description: "プリンタ", confidence: 0.8 },
        { maker: null, model: "J-TM2", serial: null, description: "箱", confidence: 0.5 },
        { maker: null, model: "J-TM3", serial: null, description: "箱", confidence: 0.5 },
        { maker: null, model: null, serial: null, description: "謎", confidence: 0.2 },
      ],
    };
    const r = await judge(box.body.id.toLowerCase());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.container_id, box.body.id);
    assert.deepEqual(r.body.stock.map((s) => s.item_type_id), [ac.body.id, null], "大文字小文字を無視して照合");
    assert.deepEqual(r.body.assets.map((a) => a.match), ["high", "medium", "choose", "new"]);
    assert.deepEqual(r.body.assets[0].candidates.map((a) => a.id), [serialHit.id]);
    assert.deepEqual(r.body.assets[1].candidates.map((a) => a.id), [m1.id]);
    assert.equal(r.body.assets[2].candidates.length, 2);
    assert.deepEqual(r.body.current.stock.map((s) => [s.item_type_id, s.qty]), [[ac.body.id, 2]]);
    assert.deepEqual(r.body.current.assets, []);
    assert.equal(r.body.photo.status, "uploaded");
    assert.equal(r.body.photo.container_id, box.body.id);

    const sent = gemini.requests.at(-1).body;
    assert.equal(sent.generationConfig.responseSchema.properties.stock.items.properties.qty.type, "INTEGER");
    assert.ok(sent.contents[0].parts[1].text.includes("- cable / J-A-C"), "登録済みの品目を指示文に渡す");
    assert.ok(sent.contents[0].parts[1].text.includes("不明"));

    const [j] = sql(`SELECT kind, container_id, asset_id, final_json FROM ai_judgements WHERE id = '${r.body.judgement_id}'`);
    assert.deepEqual(j, { kind: "container", container_id: box.body.id, asset_id: null, final_json: null });
    assert.deepEqual(sql(`SELECT judgement_id FROM photos WHERE id = '${r.body.photo.id}'`), [{ judgement_id: r.body.judgement_id }]);
  });

  test("確定: 本数をぴったり合わせ、差分と個体の移動が movements に残る。二重確定は 409", async () => {
    const box = await post("/api/containers", { kind: "box" });
    const other = await post("/api/containers", { kind: "box" });
    const cc = await post("/api/item-types", { category: "cable", name: "K-C-C", tracking: "quantity" });
    const gone = await post("/api/item-types", { category: "cable", name: "K-GONE", tracking: "quantity" });
    const same = await post("/api/item-types", { category: "cable", name: "K-SAME", tracking: "quantity" });
    const existing = await post("/api/item-types", { category: "power", name: "K-65W", tracking: "quantity" });
    for (const [t, n] of [[cc, 2], [gone, 4], [same, 1]]) {
      await post(`/api/containers/${box.body.id}/stock`, { item_type_id: t.body.id, delta: n });
    }
    const moving = (await post("/api/assets", { model: "K-DEV", serial: "K-1", container_id: other.body.id })).body.asset;
    const staying = (await post("/api/assets", { model: "K-DEV", serial: "K-2", container_id: box.body.id })).body.asset;
    const untouched = (await post("/api/assets", { model: "K-DEV", serial: "K-3", container_id: box.body.id })).body.asset;

    gemini.container = { stock: [line("cable", "K-C-C", 5)], assets: [] };
    const r = await judge(box.body.id);
    const final = {
      stock: [
        { item_type_id: cc.body.id, qty: 5 },
        { item_type_id: same.body.id, qty: 1 },
        { category: "Power", name: "k-65w", qty: 1 }, // 大文字小文字違いの既存品目 → 作らない
        { category: "cable", name: "K-NEW", qty: 2, attrs: { end1: "A", end2: "C" } },
      ],
      assets: [moving.id, staying.id],
    };
    const ok = await confirm(r.body.judgement_id, final);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    // 二重確定は 409 で何も変わらない (中身は下でまとめて確かめる)
    const movesAfterFirst = sql(`SELECT COUNT(*) AS n FROM movements`)[0].n;
    const again = await confirm(r.body.judgement_id, { stock: [], assets: [] });
    assert.equal(again.status, 409);

    assert.deepEqual(stockOf(box.body.id), [
      { category: "power", name: "K-65W", qty: 1 },
      { category: "cable", name: "K-C-C", qty: 5 },
      { category: "cable", name: "K-NEW", qty: 2 },
      { category: "cable", name: "K-SAME", qty: 1 },
    ], "K-GONE の行は消える");
    assert.deepEqual(ok.body.stock.map((s) => s.name).sort(), ["K-65W", "K-C-C", "K-NEW", "K-SAME"]);
    assert.deepEqual(ok.body.assets.map((a) => a.id).sort(), [moving.id, staying.id, untouched.id].sort());
    assert.deepEqual(sql(`SELECT tracking, attrs_json FROM item_types WHERE name = 'K-NEW'`), [{ tracking: "quantity", attrs_json: '{"end1":"A","end2":"C"}' }]);
    assert.equal(sql(`SELECT COUNT(*) AS n FROM item_types WHERE lower(name) = 'k-65w'`)[0].n, 1, "大文字小文字違いでは作らない");

    const adj = sql(`SELECT t.name, m.qty_delta, m.actor FROM movements m JOIN item_types t ON t.id = m.item_type_id WHERE m.kind = 'stock_adjust' AND m.container_id = '${box.body.id}' ORDER BY t.name`);
    assert.deepEqual(adj, [
      { name: "K-65W", qty_delta: 1, actor: EMAIL },
      { name: "K-C-C", qty_delta: 3, actor: EMAIL },
      { name: "K-GONE", qty_delta: -4, actor: EMAIL },
      { name: "K-NEW", qty_delta: 2, actor: EMAIL },
    ], "差 0 の K-SAME は記録しない");
    assert.deepEqual(sql(`SELECT asset_id, from_id, to_id FROM movements WHERE kind = 'asset_move' AND note = 'judgement ${r.body.judgement_id}'`), [
      { asset_id: moving.id, from_id: other.body.id, to_id: box.body.id },
    ], "既にこのコンテナにある個体は記録しない");
    assert.equal(sql(`SELECT container_id FROM assets WHERE id = '${moving.id}'`)[0].container_id, box.body.id);

    const [j] = sql(`SELECT proposal_json, final_json FROM ai_judgements WHERE id = '${r.body.judgement_id}'`);
    assert.equal(JSON.parse(j.proposal_json).stock[0].qty, 5);
    const fin = JSON.parse(j.final_json);
    assert.match(fin.confirm_id, /^[0-9A-Z]{16}$/);
    assert.deepEqual(fin.assets, [moving.id, staying.id]);

    assert.equal(fin.stock.length, 4, "二重確定で上書きされていない");
    assert.equal(sql(`SELECT COUNT(*) AS n FROM movements`)[0].n, movesAfterFirst, "二重確定は movements も増やさない");
  });

  test("確定の拒否: 個体管理の品目・無い品目・無い個体は 422 で何も変わらない", async () => {
    const box = await post("/api/containers", { kind: "box" });
    const cable = await post("/api/item-types", { category: "cable", name: "L-A-C", tracking: "quantity" });
    const dev = await post("/api/item-types", { category: "device", name: "L-DEV", tracking: "individual" });
    await post(`/api/containers/${box.body.id}/stock`, { item_type_id: cable.body.id, delta: 3 });
    gemini.container = { stock: [], assets: [] };
    const r = await judge(box.body.id);
    const jid = r.body.judgement_id;
    const movesBefore = sql(`SELECT COUNT(*) AS n FROM movements`)[0].n;
    const unchanged = () => {
      assert.deepEqual(stockOf(box.body.id), [{ category: "cable", name: "L-A-C", qty: 3 }]);
      assert.equal(sql(`SELECT final_json FROM ai_judgements WHERE id = '${jid}'`)[0].final_json, null);
      assert.equal(sql(`SELECT COUNT(*) AS n FROM movements`)[0].n, movesBefore);
    };

    for (const final of [
      { stock: [{ item_type_id: dev.body.id, qty: 1 }], assets: [] },
      { stock: [{ category: "Device", name: "l-dev", qty: 1 }], assets: [] },
      { stock: [{ item_type_id: "nope", qty: 1 }], assets: [] },
      { stock: [{ item_type_id: cable.body.id, qty: 1 }, { category: "CABLE", name: "l-a-c", qty: 2 }], assets: [] },
      { stock: [{ category: "cable", name: "L-NEW", qty: 1 }], assets: ["nope"] },
    ]) {
      const res = await confirm(jid, final);
      assert.equal(res.status, 422, JSON.stringify({ final, body: res.body }));
      unchanged();
    }
    assert.equal(sql(`SELECT COUNT(*) AS n FROM item_types WHERE name = 'L-NEW'`)[0].n, 0, "失敗した確定では品目も作らない");

    // 入力の形は DB の前に 400
    for (const final of [
      { stock: [{ item_type_id: cable.body.id, qty: -1 }], assets: [] },
      { stock: [{ item_type_id: cable.body.id, qty: 1.5 }], assets: [] },
      { stock: [{ qty: 1 }], assets: [] },
      { stock: [{ item_type_id: cable.body.id, qty: 1 }, { item_type_id: cable.body.id, qty: 2 }], assets: [] },
      { stock: [{ category: "cable", name: "X", qty: 1 }, { category: "Cable", name: "x", qty: 2 }], assets: [] },
      { stock: [], assets: ["A", "A"] },
      { stock: [] },
    ]) {
      assert.equal((await confirm(jid, final)).status, 400, JSON.stringify(final));
    }
    unchanged();

    // 無い判定は 404、ラベル判定は 422 (相互に取り違えない)
    assert.equal((await confirm("nope", { stock: [], assets: [] })).status, 404);
    gemini.next = { maker: null, model: "L-LBL", serial: null, other_text: null, confidence: 0.5 };
    const lbl = await fetchFresh(`${base}/api/assets/judge-label`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", "cf-access-jwt-assertion": jwt() },
      body: JPEG,
    }).then((x) => x.json());
    assert.equal((await confirm(lbl.judgement_id, { stock: [], assets: [] })).status, 422);
    assert.equal((await post("/api/assets", { model: "L-LBL", judgement_id: jid })).status, 422, "コンテナ判定で個体は作れない");

    // 空の一覧で確定すると中身の本数が 0 になる
    const empty = await confirm(jid, { stock: [], assets: [] });
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(stockOf(box.body.id), []);
  });

  test("無いコンテナの判定は 404 で Gemini を呼ばない・未認証は 401", async () => {
    const before = gemini.requests.length;
    assert.equal((await judge("ZZZZZZ")).status, 404);
    assert.equal((await judge("not-an-id")).status, 404);
    assert.equal(gemini.requests.length, before);

    const box = await post("/api/containers", { kind: "box" });
    assert.equal((await judge(box.body.id, { token: null })).status, 401);
    assert.equal((await confirm("nope", { stock: [], assets: [] }, { token: null })).status, 401);
    assert.equal(gemini.requests.length, before);
  });
});
