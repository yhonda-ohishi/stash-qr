import { describe, expect, test } from "vitest";
import type { Asset, JudgeResult } from "./api";
import {
  assetToStockRow,
  buildFinal,
  initialRows,
  proposalContainer,
  resumeLink,
  zeroedItems,
  type AssetRow,
  type EditState,
  type StockRow,
} from "./judge";

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
  box: null,
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

  test("box_2d を行の box に引き継ぐ。無い・null は null、今あるだけの行は null", () => {
    const s = initialRows(
      result({
        stock: [
          { category: "cable", name: "A", qty: 1, attrs: null, confidence: 1, item_type_id: null, box_2d: [1, 2, 3, 4] },
          { category: "cable", name: "B", qty: 1, attrs: null, confidence: 1, item_type_id: null, box_2d: null },
          { category: "cable", name: "C", qty: 1, attrs: null, confidence: 1, item_type_id: null },
        ],
        assets: [
          { maker: null, model: null, serial: null, description: "x", confidence: 1, match: "new", candidates: [], box_2d: [5, 6, 7, 8] },
          { maker: null, model: null, serial: null, description: "y", confidence: 1, match: "new", candidates: [] },
        ],
        current: { stock: [{ item_type_id: "T9", category: "cable", name: "Z", qty: 1 }], assets: [] },
      }),
    );
    expect(s.stock.map((r) => r.box)).toEqual([[1, 2, 3, 4], null, null, null]);
    expect(s.assets.map((r) => r.box)).toEqual([[5, 6, 7, 8], null]);
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

  test("fresh (新規・再開): AI の提案 (proposal.container) を初期値にする。無ければ bag / 空", () => {
    const withProposal = initialRows(result({ proposal: { container: { kind: "bag", name: "USB ケーブルの袋" } } }), {
      current: { kind: "box", name: "元の名前" },
      fresh: true,
    });
    expect(withProposal.container).toEqual({ kind: "bag", name: "USB ケーブルの袋" });

    const withoutProposal = initialRows(result({ proposal: {} }), { fresh: true });
    expect(withoutProposal.container).toEqual({ kind: "bag", name: "" });
  });

  test("既存コンテナの撮り直し: current.name があれば current の種別・名前のまま (提案があっても)", () => {
    const s = initialRows(result({ proposal: { container: { kind: "bag", name: "AI の名前" } } }), {
      current: { kind: "box", name: "今の名前" },
      fresh: false,
    });
    expect(s.container).toEqual({ kind: "box", name: "今の名前" });
  });

  test("既存コンテナの撮り直し: current.name が空なら種別は current のまま、名前は AI の提案", () => {
    const s = initialRows(result({ proposal: { container: { kind: "bag", name: "AI の名前" } } }), {
      current: { kind: "box", name: "" },
      fresh: false,
    });
    expect(s.container).toEqual({ kind: "box", name: "AI の名前" });
  });

  test("既存コンテナの撮り直し: current.name が空・提案に container が無ければ current の種別と空", () => {
    const s = initialRows(result({ proposal: {} }), { current: { kind: "box", name: "  " }, fresh: false });
    expect(s.container).toEqual({ kind: "box", name: "" });
  });

  test("current が無ければ fresh: true と同じ扱い", () => {
    const s = initialRows(result({ proposal: { container: { kind: "bag", name: "AI の名前" } } }), { fresh: false });
    expect(s.container).toEqual({ kind: "bag", name: "AI の名前" });
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
      mode: "skip" as const,
      draft: { category: "", name: "", maker: "", model: "", serial: "" },
      box: null,
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

  test("container: fresh なら current と同じでも final.container を常に載せる", () => {
    const f = buildFinal(
      { stock: [], assets: [], container: { kind: "bag", name: "今の名前" } },
      { current: { kind: "bag", name: "今の名前" }, fresh: true },
    );
    expect(f).toEqual({ ok: true, final: { stock: [], assets: [], container: { kind: "bag", name: "今の名前" } } });
  });

  test("container: 既存コンテナの撮り直しで変更が無ければ final に container キーが無い", () => {
    const f = buildFinal(
      { stock: [], assets: [], container: { kind: "bag", name: "今の名前" } },
      { current: { kind: "bag", name: "今の名前" }, fresh: false },
    );
    expect(f.ok && f.final).not.toHaveProperty("container");
  });

  test("container: 既存コンテナの撮り直しで名前を変えれば final.container が載る", () => {
    const f = buildFinal(
      { stock: [], assets: [], container: { kind: "bag", name: "新しい名前" } },
      { current: { kind: "bag", name: "今の名前" }, fresh: false },
    );
    expect(f).toEqual({ ok: true, final: { stock: [], assets: [], container: { kind: "bag", name: "新しい名前" } } });
  });

  test("new_assets: 「個体として登録」の行だけを trim・空は null にして載せる", () => {
    const f = buildFinal({
      stock: [],
      assets: [
        newRow("1", { mode: "register", draft: { category: " device ", name: " 変換アダプタ ", maker: " Apple ", model: "", serial: " S1 " } }),
        newRow("2", { mode: "skip" }),
        // match が new 以外の行は mode を見ない
        { ...newRow("3", { mode: "register" }), match: "choose", pick: "A1" },
      ],
    });
    expect(f).toEqual({
      ok: true,
      final: {
        stock: [],
        assets: ["A1"],
        new_assets: [{ category: "device", name: "変換アダプタ", maker: "Apple", model: null, serial: "S1" }],
      },
    });
  });

  test("new_assets: 名前・種類が空なら止める", () => {
    const d = { category: "device", name: "  ", maker: "", model: "", serial: "" };
    expect(buildFinal({ stock: [], assets: [newRow("1", { mode: "register", draft: d })] })).toEqual({
      ok: false,
      error: "個体の名前を入れてください",
    });
    expect(
      buildFinal({ stock: [], assets: [newRow("1", { mode: "register", draft: { ...d, name: "X", category: " " } })] }),
    ).toEqual({ ok: false, error: "個体の名前を入れてください" });
  });

  test("new_assets: 同じ (maker, model, serial) の 2 行は止める。どれかが空なら重複にしない", () => {
    const d = { category: "device", name: "X", maker: "M", model: "X1", serial: "S1" };
    const dup = buildFinal({
      stock: [],
      assets: [newRow("1", { mode: "register", draft: d }), newRow("2", { mode: "register", draft: { ...d, serial: " S1 " } })],
    });
    expect(dup).toEqual({ ok: false, error: "同じ個体を 2 行で登録しようとしています" });
    const noSerial = buildFinal({
      stock: [],
      assets: [
        newRow("1", { mode: "register", draft: { ...d, serial: "" } }),
        newRow("2", { mode: "register", draft: { ...d, serial: "" } }),
      ],
    });
    expect(noSerial.ok && noSerial.final.new_assets).toEqual([
      { category: "device", name: "X", maker: "M", model: "X1", serial: null },
      { category: "device", name: "X", maker: "M", model: "X1", serial: null },
    ]);
  });

  test("new_assets: 登録の行が無ければ final にキー自体が無い", () => {
    const f = buildFinal({ stock: [], assets: [newRow("1", { mode: "skip" })] });
    expect(f).toEqual({ ok: true, final: { stock: [], assets: [] } });
    expect(f.ok && f.final).not.toHaveProperty("new_assets");
  });
});

describe("未登録の個体", () => {
  test("initialRows: 既定は確定しない、入力の初期値は AI の値 (名前は型番、無ければ説明)", () => {
    const s = initialRows(
      result({
        assets: [
          { maker: null, model: null, serial: null, description: "白いLightning変換アダプタ", confidence: 0.4, match: "new", candidates: [] },
          { maker: "Apple", model: "A1", serial: "S", description: "d", confidence: 0.8, match: "new", candidates: [] },
        ],
      }),
    );
    expect(s.assets.map((a) => [a.mode, a.draft])).toEqual([
      ["skip", { category: "device", name: "白いLightning変換アダプタ", maker: "", model: "", serial: "" }],
      ["skip", { category: "device", name: "A1", maker: "Apple", model: "A1", serial: "S" }],
    ]);
  });

  test("assetToStockRow: 手で足した行と同じ形 (other・1 本・今 0 本)", () => {
    expect(assetToStockRow(newRow("1", { model: null, description: "白いLightning変換アダプタ", confidence: 0.4 }), "n9")).toEqual({
      key: "n9",
      itemTypeId: null,
      category: "other",
      name: "白いLightning変換アダプタ",
      attrs: null,
      qty: 1,
      currentQty: 0,
      confidence: 0.4,
      source: "added",
      box: null,
    });
    expect(assetToStockRow(newRow("1", { model: "MD820", description: "x" }), "n1").name).toBe("MD820");
  });

  test("assetToStockRow: 元の個体候補の枠 (box) を引き継ぐ", () => {
    expect(assetToStockRow(newRow("1", { box: [10, 20, 300, 400] }), "n2").box).toEqual([10, 20, 300, 400]);
  });
});

function newRow(key: string, over: Partial<AssetRow> = {}): AssetRow {
  return {
    key,
    maker: null,
    model: null,
    serial: null,
    description: "",
    confidence: 0.5,
    match: "new",
    candidates: [],
    pick: null,
    mode: "skip",
    draft: { category: "device", name: "X", maker: "", model: "", serial: "" },
    box: null,
    ...over,
  };
}

describe("resumeLink", () => {
  test("提案が残っていれば ?resume= で編集から再開", () => {
    expect(resumeLink("AB12CD", "J 1")).toEqual({ href: "/app/c/AB12CD/judge?resume=J%201", label: "続きから確定" });
  });
  test("提案が無ければ (判定に失敗) 撮影して判定", () => {
    expect(resumeLink("AB12CD", null)).toEqual({ href: "/app/c/AB12CD/judge", label: "撮影して判定" });
  });
});
