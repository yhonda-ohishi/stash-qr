// ホームの検索モード (全品目の一覧) が使う純粋関数。通信・DOM は Home.tsx 側。
// GET /api/search の応答 (stock 行 × assets 行) を品目ごとにまとめ、文字での絞り込みを行う。
import type { Crop, Crumb, SearchResult } from "./api";
import { crumbLabel } from "./ui";

/** 本数品目の置き場所 1 か所ぶん。 */
export type QuantityPlace = {
  kind: "quantity";
  containerId: string;
  breadcrumb: Crumb[];
  qty: number;
  /** その場所の切り抜き (無ければ null) */
  crop: Crop | null;
};

/** 個体管理の品目の個体 1 台ぶん。 */
export type IndividualPlace = {
  kind: "individual";
  assetId: string;
  maker: string | null;
  model: string | null;
  serial: string | null;
  containerId: string | null;
  breadcrumb: Crumb[];
};

export type Place = QuantityPlace | IndividualPlace;

/** 品目 1 つぶんのカード表示に使う形。 */
export type ItemGroup = {
  itemTypeId: string;
  category: string;
  name: string;
  tracking: "quantity" | "individual";
  /** 本数品目は本数の合計、個体管理は台数。 */
  total: number;
  places: Place[];
};

/** `search()` の応答 (stock・assets のフラットな行) を品目ごとにまとめる。並びは category → name。 */
export function groupByItem(result: SearchResult): ItemGroup[] {
  const groups = new Map<string, ItemGroup>();

  for (const s of result.stock) {
    const g = groupFor(groups, s.item_type_id, s.category, s.item_type_name, "quantity");
    g.total += s.qty;
    g.places.push({ kind: "quantity", containerId: s.container_id, breadcrumb: s.breadcrumb, qty: s.qty, crop: s.crop });
  }
  for (const a of result.assets) {
    const g = groupFor(groups, a.item_type_id, a.category, a.item_type_name, "individual");
    g.total += 1;
    g.places.push({
      kind: "individual",
      assetId: a.id,
      maker: a.maker,
      model: a.model,
      serial: a.serial,
      containerId: a.container_id,
      breadcrumb: a.breadcrumb,
    });
  }

  return [...groups.values()].sort((x, y) => cmp(x.category, y.category) || cmp(x.name, y.name));
}

function groupFor(
  groups: Map<string, ItemGroup>,
  itemTypeId: string,
  category: string,
  name: string,
  tracking: "quantity" | "individual",
): ItemGroup {
  let g = groups.get(itemTypeId);
  if (!g) {
    g = { itemTypeId, category, name, tracking, total: 0, places: [] };
    groups.set(itemTypeId, g);
  }
  return g;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 品目名・カテゴリ・場所のパスの名前・個体のメーカー/型番/シリアルに `text` を含む
 * 品目だけを残す (大文字小文字無視)。空文字なら全件。
 */
export function filterGroups(groups: ItemGroup[], text: string): ItemGroup[] {
  const t = text.trim().toLowerCase();
  if (!t) return groups;
  return groups.filter((g) => matchesGroup(g, t));
}

function includes(v: string | null | undefined, t: string): boolean {
  return !!v && v.toLowerCase().includes(t);
}

function matchesGroup(g: ItemGroup, t: string): boolean {
  if (includes(g.name, t) || includes(g.category, t)) return true;
  return g.places.some((p) => {
    if (p.breadcrumb.some((c) => includes(crumbLabel(c), t))) return true;
    return p.kind === "individual" && (includes(p.maker, t) || includes(p.model, t) || includes(p.serial, t));
  });
}
