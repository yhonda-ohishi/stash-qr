import { describe, expect, test } from "vitest";
import { assetLabelLines, buildLabel, capLines, containerLabelLines, esc, printSucceeded } from "./print";

describe("esc", () => {
  test("& < > \" ' をエスケープする", () => {
    expect(esc(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
  test("それ以外はそのまま", () => {
    expect(esc("品目 x10")).toBe("品目 x10");
  });
});

describe("capLines", () => {
  test("3 行以下はそのまま", () => {
    expect(capLines(["a", "b"])).toEqual(["a", "b"]);
    expect(capLines(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
  test("4 行以上は 3 行目を「ほか N 件」にする", () => {
    expect(capLines(["a", "b", "c", "d"])).toEqual(["a", "b", "ほか 2 件"]);
    expect(capLines(["a", "b", "c", "d", "e"])).toEqual(["a", "b", "ほか 3 件"]);
  });
});

describe("buildLabel", () => {
  test("QR の URL (本番ドメイン) と ID を含む", () => {
    const xml = buildLabel({ kind: "c", id: "ABC123", lines: ["品目A ×2"] });
    expect(xml).toContain("https://stash.mtamaramu.com/c/ABC123");
    expect(xml).toContain("ABC123");
    expect(xml).toContain("qrcode_model_2");
    expect(xml).toContain("<cut");
  });
  test("個体は /a/ になる", () => {
    expect(buildLabel({ kind: "a", id: "XYZ", lines: [] })).toContain("https://stash.mtamaramu.com/a/XYZ");
  });
  test("長い行は切り詰める", () => {
    const long = "あ".repeat(30);
    const xml = buildLabel({ kind: "c", id: "ID1", lines: [long] });
    expect(xml).not.toContain(long);
    expect(xml).toContain("…");
  });
  test("4 行を超える中身は「ほか N 件」になる", () => {
    const xml = buildLabel({ kind: "c", id: "ID1", lines: ["a", "b", "c", "d"] });
    expect(xml).toContain("ほか 2 件");
    expect(xml).not.toContain(">d<");
  });
  test("下の余白 (feed line=\"4\") の直後に cut が来る", () => {
    const xml = buildLabel({ kind: "c", id: "ID1", lines: ["a"] });
    expect(xml).toMatch(/<feed line="4"\/><cut type="feed"\/>$/);
  });
});

describe("containerLabelLines", () => {
  test("本数 → 個体の順", () => {
    const lines = containerLabelLines({
      stock: [{ item_type_id: "t1", category: "c", name: "ケーブル", qty: 3 }],
      assets: [{ id: "a1", item_type_id: "t2", item_name: "ドライバ", maker: null, model: "PRO-1", serial: null, status: "in_stock" }],
    });
    expect(lines).toEqual(["ケーブル ×3", "ドライバ PRO-1"]);
  });
  test("3 行を超えたら「ほか N 件」", () => {
    const lines = containerLabelLines({
      stock: [
        { item_type_id: "t1", category: "c", name: "A", qty: 1 },
        { item_type_id: "t2", category: "c", name: "B", qty: 1 },
        { item_type_id: "t3", category: "c", name: "C", qty: 1 },
      ],
      assets: [{ id: "a1", item_type_id: "t4", item_name: "D", maker: null, model: null, serial: null, status: "in_stock" }],
    });
    expect(lines).toEqual(["A ×1", "B ×1", "ほか 2 件"]);
  });
});

describe("assetLabelLines", () => {
  test("メーカー・型番 と シリアル", () => {
    const lines = assetLabelLines({
      asset: {
        id: "a1",
        item_type_id: "t1",
        item_name: "ドライバ",
        container_id: null,
        maker: "メーカーX",
        model: "PRO-1",
        serial: "SN001",
        status: "in_stock",
        memo: null,
        created_at: "",
        updated_at: "",
      },
    });
    expect(lines).toEqual(["メーカーX PRO-1", "S/N SN001"]);
  });
  test("メーカー・型番・シリアルが無ければ品目名だけ", () => {
    const lines = assetLabelLines({
      asset: {
        id: "a1",
        item_type_id: "t1",
        item_name: "ドライバ",
        container_id: null,
        maker: null,
        model: null,
        serial: null,
        status: "in_stock",
        memo: null,
        created_at: "",
        updated_at: "",
      },
    });
    expect(lines).toEqual(["ドライバ"]);
  });
});

describe("printSucceeded", () => {
  test("success=\"true\" があれば成功", () => {
    expect(printSucceeded('<response xmlns="..." success="true"/>')).toBe(true);
  });
  test("success=\"false\" や無ければ失敗", () => {
    expect(printSucceeded('<response xmlns="..." success="false" code="SystemError"/>')).toBe(false);
    expect(printSucceeded("")).toBe(false);
    expect(printSucceeded("<html>ログイン</html>")).toBe(false);
  });
});
