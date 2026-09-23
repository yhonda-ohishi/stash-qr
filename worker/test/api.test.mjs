// API の結合テスト。空のローカル D1 に migration を当て、wrangler dev を立てて叩く。
// 実行: npm test (先に cargo test、続けてこれ)。
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const WRANGLER = join(import.meta.dirname, "..", "node_modules", ".bin", "wrangler");
const CWD = join(import.meta.dirname, "..");

let base;
let dev;
let state;

async function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

before(async () => {
  state = mkdtempSync(join(tmpdir(), "stash-qr-test-"));
  execFileSync(WRANGLER, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", state], {
    cwd: CWD,
    stdio: "ignore",
  });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // 自分で起こしたプロセスグループだけを後で止める (名前で kill しない)。
  dev = spawn(WRANGLER, ["dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", state], {
    cwd: CWD,
    detached: true,
    stdio: "ignore",
  });
  for (let i = 0; i < 600; i++) {
    try {
      await fetch(`${base}/api/item-types`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("wrangler dev did not come up");
});

after(() => {
  if (dev?.pid) process.kill(-dev.pid, "SIGTERM");
  if (state) rmSync(state, { recursive: true, force: true });
});

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const post = (p, b) => call("POST", p, b);

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
      sql(`SELECT container_id, from_id, to_id FROM movements WHERE kind = 'container_move' AND container_id IN ('${a.body.id}', '${b.body.id}') ORDER BY at`),
      [
        { container_id: b.body.id, from_id: a.body.id, to_id: other.body.id },
        { container_id: b.body.id, from_id: other.body.id, to_id: null },
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
