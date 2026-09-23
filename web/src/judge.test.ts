import { describe, expect, test } from "vitest";
import type { Asset, JudgeResult } from "./api";
import { buildFinal, initialRows, proposalContainer, zeroedItems, type EditState, type StockRow } from "./judge";

function asset(id: string, container_id: string | null = null): Asset {
  return {
    id,
    item_type_id: "T-PC",
    item_name: "PC",
    container_id,
    maker: "M",
    model: "X1",
    serial: `S-${id}`,
    status: "in_stock",
    memo: null,
    created_at: "",
    updated_at: "",
  };
}

function result(over: Partial<JudgeResult> = {}): JudgeResult {
  return {
    judgement_id: "J1",
    model: "m",
    container_id: "C1",
    proposal: {},
    stock: [],
    assets: [],
    current: { stock: [], assets: [] },
    photo: { id: "P1", kind: "container", container_id: "C1", asset_id: null, taken_at: "", status: "uploaded", upload_error: null },
    ...over,
  };
}

const row = (over: Partial<StockRow>): StockRow => ({
  key: over.key ?? Math.random().toString(),
  itemTypeId: null,
  category: "cable",
  name: "USB-C",
  attrs: null,
  qty: 1,
  currentQty: 0,
  confidence: null,
  source: "added",
  ...over,
});

describe("initialRows", () => {
  test("提案の行: 既存品目は登録名と今の本数、新しい品目は AI の名前で今 0 本", () => {
    const s = initialRows(
      result({
        stock: [
          { category: "cable", name: "usb-c", qty: 3, attrs: null, confidence: 0.9, item_type_id: "T1" },
          { category: "power", name: "65W", qty: 1, attrs: { color: "white" }, confidence: 0.5, item_type_id: null },
        ],
        current: { stock: [{ item_type_id: "T1", category: "cable", name: "USB-C", qty: 2 }], assets: [] },
      }),
    );
    expect(s.stock).toHaveLength(2);
    expect(s.stock[0]).toMatchObject({ itemTypeId: "T1", name: "USB-C", qty: 3, currentQty: 2, source: "proposal" });
    expect(s.stock[1]).toMatchObject({ itemTypeId: null, name: "65W", qty: 1, currentQty: 0, attrs: { color: "white" } });
  });

  test("今あって提案に無い品目は、今の本数を残す行として足す", () => {
    const s = initialRows(
      result({
        stock: [{ category: "cable", name: "A", qty: 1, attrs: null, confidence: 1, item_type_id: "T1" }],
        current: {
          stock: [
            { item_type_id: "T1", category: "cable", name: "A", qty: 1 },
            { item_type_id: "T2", category: "battery", name: "AA", qty: 8 },
          ],
          assets: [],
        },
      }),
    );
    expect(s.stock.map((r) => [r.itemTypeId, r.qty, r.source])).toEqual([
      ["T1", 1, "proposal"],
      ["T2", 8, "current"],
    ]);
    // そのまま確定しても今の本数が残る
    const f = buildFinal(s);
    expect(f.ok && f.final.stock).toEqual([
      { item_type_id: "T1", qty: 1 },
      { item_type_id: "T2", qty: 8 },
    ]);
  });

  test("個体: high/medium は候補の先頭を選ぶ、choose と new は選ばない", () => {
    const base = { maker: "M", model: "X1", serial: null, description: "PC", confidence: 0.8 };
    const s = initialRows(
      result({
        assets: [
          { ...base, match: "high", candidates: [asset("A1")] },
          { ...base, match: "medium", candidates: [asset("A2")] },
          { ...base, match: "choose", candidates: [asset("A3"), asset("A4")] },
          { ...base, match: "new", candidates: [] },
        ],
      }),
    );
    expect(s.assets.map((a) => a.pick)).toEqual(["A1", "A2", null, null]);
    const f = buildFinal(s);
    expect(f.ok && f.final.assets).toEqual(["A1", "A2"]);
  });

  test("withContainer: AI の提案 (proposal.container) を初期値にする。無ければ bag / 空", () => {
    const withProposal = initialRows(result({ proposal: { container: { kind: "bag", name: "USB ケーブルの袋" } } }), {
      withContainer: true,
    });
    expect(withProposal.container).toEqual({ kind: "bag", name: "USB ケーブルの袋" });

    const withoutProposal = initialRows(result({ proposal: {} }), { withContainer: true });
    expect(withoutProposal.container).toEqual({ kind: "bag", name: "" });

    // withContainer を付けなければ container 行は無い (通常の撮影して判定)
    expect(initialRows(result({ proposal: { container: { kind: "box", name: "x" } } })).container).toBeUndefined();
  });
});

describe("proposalContainer", () => {
  test("proposal.container を読む。形が違えば null", () => {
    expect(proposalContainer({ container: { kind: "box", name: "箱" } })).toEqual({ kind: "box", name: "箱" });
    expect(proposalContainer({ container: { kind: "box" } })).toEqual({ kind: "box", name: null });
    expect(proposalContainer({})).toBeNull();
    expect(proposalContainer(null)).toBeNull();
    expect(proposalContainer({ container: { name: "no kind" } })).toBeNull();
    expect(proposalContainer("not an object")).toBeNull();
  });
});

describe("buildFinal", () => {
  test("既存品目は ID、新しい名前は category・name (前後の空白を落とす)・attrs があれば付ける", () => {
    const f = buildFinal({
      stock: [
        row({ itemTypeId: "T1", name: "USB-C", qty: 2 }),
        row({ category: " power ", name: " 65W ", qty: 1, attrs: { color: "white" } }),
        row({ category: "other", name: "結束バンド", qty: 0 }),
      ],
      assets: [],
    });
    expect(f).toEqual({
      ok: true,
      final: {
        stock: [
          { item_type_id: "T1", qty: 2 },
          { category: "power", name: "65W", attrs: { color: "white" }, qty: 1 },
          { category: "other", name: "結束バンド", qty: 0 },
        ],
        assets: [],
      },
    });
  });

  test("削除した行は final に載らない (= 0 本になる) ので、zeroedItems で知らせる", () => {
    const current = [
      { item_type_id: "T1", category: "cable", name: "A", qty: 3 },
      { item_type_id: "T2", category: "cable", name: "B", qty: 1 },
      { item_type_id: "T3", category: "cable", name: "C", qty: 2 },
    ];
    const state: EditState = {
      stock: [row({ itemTypeId: "T1", name: "A", qty: 3 }), row({ itemTypeId: "T3", name: "C", qty: 0 })],
      assets: [],
    };
    const f = buildFinal(state);
    expect(f.ok && f.final.stock).toEqual([
      { item_type_id: "T1", qty: 3 },
      { item_type_id: "T3", qty: 0 },
    ]);
    expect(zeroedItems(state.stock, current).map((s) => s.name)).toEqual(["B", "C"]);
  });

  test("同じ品目の二重指定を止める (ID・新しい名前どうし・既存の登録名と新しい名前)", () => {
    const byId = buildFinal({ stock: [row({ itemTypeId: "T1" }), row({ itemTypeId: "T1" })], assets: [] });
    expect(byId.ok).toBe(false);
    const byName = buildFinal({ stock: [row({ name: "Lightning" }), row({ name: " lightning " })], assets: [] });
    expect(byName.ok).toBe(false);
    const mixed = buildFinal({
      stock: [row({ itemTypeId: "T1", category: "cable", name: "USB-C" }), row({ category: "Cable", name: "usb-c" })],
      assets: [],
    });
    expect(mixed).toMatchObject({ ok: false });
    // 分類が違えば別の品目
    expect(buildFinal({ stock: [row({ category: "cable" }), row({ category: "other" })], assets: [] }).ok).toBe(true);
  });

  test("新しい品目の空の名前・本数の不正を止める", () => {
    expect(buildFinal({ stock: [row({ name: "  " })], assets: [] }).ok).toBe(false);
    expect(buildFinal({ stock: [row({ qty: -1 })], assets: [] }).ok).toBe(false);
    expect(buildFinal({ stock: [row({ qty: 1.5 })], assets: [] }).ok).toBe(false);
    expect(buildFinal({ stock: [row({ qty: NaN })], assets: [] }).ok).toBe(false);
  });

  test("個体: 選んだものだけ・同じ個体の二重選択は止める", () => {
    const a = (key: string, pick: string | null) => ({
      key,
      maker: null,
      model: null,
      serial: null,
      description: "",
      confidence: 1,
      match: "choose" as const,
      candidates: [],
      pick,
    });
    const ok = buildFinal({ stock: [], assets: [a("1", "A1"), a("2", null), a("3", "A2")] });
    expect(ok).toEqual({ ok: true, final: { stock: [], assets: ["A1", "A2"] } });
    expect(buildFinal({ stock: [], assets: [a("1", "A1"), a("2", "A1")] }).ok).toBe(false);
  });

  test("container: 種別を trim して final に載せる。空なら止める、名前は空なら省く", () => {
    const withName = buildFinal({ stock: [], assets: [], container: { kind: " bag ", name: " USB ケーブルの袋 " } });
    expect(withName).toEqual({ ok: true, final: { stock: [], assets: [], container: { kind: "bag", name: "USB ケーブルの袋" } } });

    const withoutName = buildFinal({ stock: [], assets: [], container: { kind: "box", name: "  " } });
    expect(withoutName).toEqual({ ok: true, final: { stock: [], assets: [], container: { kind: "box" } } });

    expect(buildFinal({ stock: [], assets: [], container: { kind: "  ", name: "" } }).ok).toBe(false);

    // container 無しの通常の確定は final にキー自体が無い (前の指示までと同じ)
    const noContainer = buildFinal({ stock: [], assets: [] });
    expect(noContainer.ok && noContainer.final).not.toHaveProperty("container");
  });
});
