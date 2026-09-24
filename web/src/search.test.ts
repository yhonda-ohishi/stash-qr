import { describe, expect, test } from "vitest";
import type { Crumb, SearchResult } from "./api";
import { filterGroups, groupByItem } from "./search";

const room: Crumb = { id: "ROOM01", kind: "room", name: "部屋" };
const box: Crumb = { id: "BOX001", kind: "box", name: "箱A" };
const shelf: Crumb = { id: "SHELF1", kind: "shelf", name: "棚B" };

function emptyResult(): SearchResult {
  return { stock: [], assets: [], truncated: false };
}

describe("groupByItem", () => {
  test("本数品目: 同じ品目の複数コンテナ分を合計し、場所ごとの本数を持つ", () => {
    const result: SearchResult = {
      ...emptyResult(),
      stock: [
        { item_type_id: "T1", category: "cable", item_type_name: "A-C", container_id: box.id, qty: 3, breadcrumb: [room, box], crop: null },
        { item_type_id: "T1", category: "cable", item_type_name: "A-C", container_id: shelf.id, qty: 2, breadcrumb: [shelf], crop: null },
      ],
    };
    const groups = groupByItem(result);
    expect(groups).toHaveLength(1);
    expect(groups[0].tracking).toBe("quantity");
    expect(groups[0].total).toBe(5);
    expect(groups[0].places).toHaveLength(2);
    expect(groups[0].places.map((p) => (p.kind === "quantity" ? p.qty : null))).toEqual([3, 2]);
  });

  test("個体管理: 台数は個体の件数、場所は個体ごとに 1 つ", () => {
    const result: SearchResult = {
      ...emptyResult(),
      assets: [
        {
          id: "A1",
          item_type_id: "T2",
          category: "device",
          item_type_name: "TM-L100",
          maker: "EPSON",
          model: "TM-L100",
          serial: "S1",
          container_id: box.id,
          breadcrumb: [room, box],
        },
        {
          id: "A2",
          item_type_id: "T2",
          category: "device",
          item_type_name: "TM-L100",
          maker: "EPSON",
          model: "TM-L100",
          serial: "S2",
          container_id: null,
          breadcrumb: [],
        },
      ],
    };
    const groups = groupByItem(result);
    expect(groups).toHaveLength(1);
    expect(groups[0].tracking).toBe("individual");
    expect(groups[0].total).toBe(2);
    expect(groups[0].places).toHaveLength(2);
  });

  test("本数品目の場所ごとに crop を持ち回る (無ければ null)", () => {
    const crop = { photo_id: "P1", box: [10, 20, 300, 400] as [number, number, number, number] };
    const groups = groupByItem({
      ...emptyResult(),
      stock: [
        { item_type_id: "T1", category: "cable", item_type_name: "A-C", container_id: box.id, qty: 3, breadcrumb: [box], crop },
        { item_type_id: "T1", category: "cable", item_type_name: "A-C", container_id: shelf.id, qty: 1, breadcrumb: [shelf], crop: null },
      ],
    });
    expect(groups[0].places.map((p) => (p.kind === "quantity" ? p.crop : undefined))).toEqual([crop, null]);
  });

  test("並びは category → name", () => {
    const result: SearchResult = {
      ...emptyResult(),
      stock: [
        { item_type_id: "T3", category: "power", item_type_name: "B", container_id: box.id, qty: 1, breadcrumb: [box], crop: null },
        { item_type_id: "T4", category: "cable", item_type_name: "Z", container_id: box.id, qty: 1, breadcrumb: [box], crop: null },
        { item_type_id: "T5", category: "cable", item_type_name: "A", container_id: box.id, qty: 1, breadcrumb: [box], crop: null },
      ],
    };
    const groups = groupByItem(result);
    expect(groups.map((g) => [g.category, g.name])).toEqual([
      ["cable", "A"],
      ["cable", "Z"],
      ["power", "B"],
    ]);
  });
});

describe("filterGroups", () => {
  const groups = groupByItem({
    ...emptyResult(),
    stock: [
      { item_type_id: "T1", category: "cable", item_type_name: "A-C ケーブル", container_id: box.id, qty: 3, breadcrumb: [room, box], crop: null },
    ],
    assets: [
      {
        id: "A1",
        item_type_id: "T2",
        category: "device",
        item_type_name: "プリンタ",
        maker: "EPSON",
        model: "TM-L100",
        serial: "SN-ABC-999",
        container_id: shelf.id,
        breadcrumb: [shelf],
      },
    ],
  });

  test("空文字は全件", () => {
    expect(filterGroups(groups, "")).toHaveLength(2);
    expect(filterGroups(groups, "   ")).toHaveLength(2);
  });

  test("品目名で当たる (大文字小文字無視)", () => {
    expect(filterGroups(groups, "a-c").map((g) => g.itemTypeId)).toEqual(["T1"]);
    expect(filterGroups(groups, "A-C").map((g) => g.itemTypeId)).toEqual(["T1"]);
  });

  test("カテゴリで当たる", () => {
    expect(filterGroups(groups, "device").map((g) => g.itemTypeId)).toEqual(["T2"]);
  });

  test("場所のパスの名前で当たる", () => {
    expect(filterGroups(groups, "棚b").map((g) => g.itemTypeId)).toEqual(["T2"]);
    expect(filterGroups(groups, "部屋").map((g) => g.itemTypeId)).toEqual(["T1"]);
  });

  test("個体のメーカー・型番・シリアルで当たる", () => {
    expect(filterGroups(groups, "epson").map((g) => g.itemTypeId)).toEqual(["T2"]);
    expect(filterGroups(groups, "tm-l100").map((g) => g.itemTypeId)).toEqual(["T2"]);
    expect(filterGroups(groups, "sn-abc-999").map((g) => g.itemTypeId)).toEqual(["T2"]);
  });

  test("当たらない文字は空", () => {
    expect(filterGroups(groups, "存在しない品目xyz")).toHaveLength(0);
  });
});
