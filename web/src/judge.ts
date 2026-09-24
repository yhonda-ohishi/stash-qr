// 撮影→判定→編集→確定の、編集リストまわりの純粋関数 (画面は screens/JudgeScreen.tsx)。
//
// 確定はコンテナ直下の本数を final.stock とぴったり同じにする (載っていない品目は 0 本)。
// だから判定の提案に無くても今ある品目は行として出し、既定では今の本数を残す。
import type { Asset, AssetLine, Box, ConfirmFinal, ConfirmStockLine, JudgedContainer, JudgeResult, NewAsset, StockLine } from "./api";
import { clean, type LabelForm } from "./label";

/** 未確定のコンテナから進む先。提案が残っていれば編集から再開、無ければ (判定に失敗) 撮り直す。 */
export function resumeLink(containerId: string, pendingJudgementId: string | null): { href: string; label: string } {
  const base = `/app/c/${encodeURIComponent(containerId)}/judge`;
  return pendingJudgementId
    ? { href: `${base}?resume=${encodeURIComponent(pendingJudgementId)}`, label: "続きから確定" }
    : { href: base, label: "撮影して判定" };
}

/** 数量物の編集行。`itemTypeId` があれば既存品目 (category・name は表示用)、無ければ新しい品目。 */
export type StockRow = {
  key: string;
  itemTypeId: string | null;
  category: string;
  name: string;
  attrs: Record<string, unknown> | null;
  qty: number;
  /** 今このコンテナ直下にある本数 (無ければ 0) */
  currentQty: number;
  /** AI の確からしさ。提案に無い行は null */
  confidence: number | null;
  /** proposal = AI の提案 / current = 提案に無いが今ある / added = ユーザーが足した */
  source: "proposal" | "current" | "added";
  /** 判定の写真の中の範囲 (切り抜き表示用)。無ければ null */
  box: Box | null;
};

/** 未登録の個体を確定で登録するときの入力 (ラベル画面のフォームと同じ欄。メモは使わない)。 */
export type AssetDraft = Omit<LabelForm, "memo">;

/** 個体の編集行。`pick` は確定でこのコンテナへ移す個体の ID (null = 移さない)。
 * match="new" の行だけ `mode` を使う: skip = 確定しない / register = `draft` で個体として登録する。 */
export type AssetRow = {
  key: string;
  maker: string | null;
  model: string | null;
  serial: string | null;
  description: string;
  confidence: number;
  match: "high" | "medium" | "choose" | "new";
  candidates: Asset[];
  pick: string | null;
  mode: "skip" | "register";
  draft: AssetDraft;
  /** 判定の写真の中の範囲 (切り抜き表示用)。無ければ null */
  box: Box | null;
};

/** コンテナ自体の種別・名前の編集行。判定画面には常に出す。 */
export type ContainerRow = { kind: string; name: string };

/** 今のコンテナの種別・名前 (`GET /api/containers/:id` の `container`)。initialRows/buildFinal に渡す。 */
export type CurrentContainer = { kind: string; name: string | null };

export type EditState = { stock: StockRow[]; assets: AssetRow[]; container?: ContainerRow };

/** 判定の応答 (proposal) から container の提案を読む。無い/形が違えば null。 */
export function proposalContainer(proposal: unknown): JudgedContainer | null {
  if (!proposal || typeof proposal !== "object") return null;
  const c = (proposal as { container?: unknown }).container;
  if (!c || typeof c !== "object") return null;
  const kind = (c as { kind?: unknown }).kind;
  const name = (c as { name?: unknown }).name;
  if (typeof kind !== "string") return null;
  return { kind, name: typeof name === "string" ? name : null };
}

/** 判定の応答から編集リストの初期値を作る。種別・名前の編集行は常に添える。
 * `fresh` (新規 `?new=1` か提案からの再開 `?resume=`) なら AI の提案 (proposal.container) が初期値、
 * 無ければ bag / 空。それ以外 (既存コンテナの撮り直し) は `current` を基準にする:
 * 種別は current のまま (AI の種別で上書きしない)、名前は current にあればそのまま、空なら AI の提案。
 * `current` が無ければ `fresh` を渡さなくても fresh 扱いにする。 */
export function initialRows(r: JudgeResult, opts: { current?: CurrentContainer; fresh?: boolean } = {}): EditState {
  const currentQty = new Map(r.current.stock.map((s) => [s.item_type_id, s.qty]));
  const byId = new Map(r.current.stock.map((s) => [s.item_type_id, s]));
  const proposed = new Set<string>();
  const stock: StockRow[] = r.stock.map((l, i) => {
    if (l.item_type_id) proposed.add(l.item_type_id);
    const known = l.item_type_id ? byId.get(l.item_type_id) : undefined;
    return {
      key: `p${i}`,
      itemTypeId: l.item_type_id,
      // 既存品目は登録名で見せる (AI の表記は大文字小文字がずれることがある)
      category: known?.category ?? l.category,
      name: known?.name ?? l.name,
      attrs: l.attrs,
      qty: Math.max(0, Math.floor(l.qty)),
      currentQty: (l.item_type_id && currentQty.get(l.item_type_id)) || 0,
      confidence: l.confidence,
      source: "proposal",
      box: l.box_2d ?? null,
    };
  });
  for (const s of r.current.stock) {
    if (proposed.has(s.item_type_id)) continue;
    stock.push(currentRow(s));
  }
  const assets: AssetRow[] = r.assets.map((a, i) => ({
    key: `a${i}`,
    maker: a.maker,
    model: a.model,
    serial: a.serial,
    description: a.description,
    confidence: a.confidence,
    match: a.match,
    candidates: a.candidates,
    pick: (a.match === "high" || a.match === "medium") && a.candidates[0] ? a.candidates[0].id : null,
    mode: "skip",
    box: a.box_2d ?? null,
    draft: {
      category: "device",
      name: a.model ?? a.description,
      maker: a.maker ?? "",
      model: a.model ?? "",
      serial: a.serial ?? "",
    },
  }));
  const containerProposal = proposalContainer(r.proposal);
  const current = opts.current;
  const fresh = !current || !!opts.fresh;
  const container: ContainerRow = fresh
    ? { kind: containerProposal?.kind ?? "bag", name: containerProposal?.name ?? "" }
    : { kind: current.kind, name: current.name?.trim() ? current.name : (containerProposal?.name ?? "") };
  return { stock, assets, container };
}

function currentRow(s: StockLine): StockRow {
  return {
    key: `c${s.item_type_id}`,
    itemTypeId: s.item_type_id,
    category: s.category,
    name: s.name,
    attrs: null,
    qty: s.qty,
    currentQty: s.qty,
    confidence: null,
    source: "current",
    box: null,
  };
}

/** 未登録の個体の行を、本数で数える行 (手で足した行と同じ形) にする。 */
export function assetToStockRow(row: AssetRow, key: string): StockRow {
  return {
    key,
    itemTypeId: null,
    category: "other",
    name: row.model ?? row.description,
    attrs: null,
    qty: 1,
    currentQty: 0,
    confidence: row.confidence,
    source: "added",
    // 元の個体候補の枠を引き継ぐ
    box: row.box,
  };
}

/** 確定すると 0 本になる品目 (今あるのに、一覧に無いか 0 本にした)。確定前の注意書き用。 */
export function zeroedItems(rows: readonly StockRow[], current: readonly StockLine[]): StockLine[] {
  const kept = new Set(rows.filter((r) => r.itemTypeId && r.qty > 0).map((r) => r.itemTypeId));
  return current.filter((s) => s.qty > 0 && !kept.has(s.item_type_id));
}

export type BuildResult = { ok: true; final: ConfirmFinal } | { ok: false; error: string };

const fold = (s: string) => s.trim().toLowerCase();

/**
 * 編集リストを確定の本文にする。worker が 400/422 で弾くもの (空の名前・本数の不正・
 * 同じ品目の二重指定・同じ個体の二重選択) は送る前に画面で止める。
 *
 * `fresh` (新規・再開) なら final.container を常に載せる。それ以外 (既存コンテナの撮り直し)
 * は編集後の kind・name (trim 後) が `current` と変わったときだけ載せる (同じ値での書き換えと
 * updated_at の空回り、撮影中に別画面で変えた名前を古い値で戻すのを避ける)。`current` が無ければ
 * `fresh` を渡さなくても fresh 扱いにする (initialRows と同じ規則)。
 */
export function buildFinal(state: EditState, opts: { current?: CurrentContainer; fresh?: boolean } = {}): BuildResult {
  const stock: ConfirmStockLine[] = [];
  const seen = new Map<string, string>(); // 品目の鍵 → 表示名
  const dup = (keys: string[], label: string): string | null => {
    for (const k of keys) {
      const prev = seen.get(k);
      if (prev !== undefined) return `「${prev}」と「${label}」が同じ品目です。1 行にまとめてください`;
    }
    for (const k of keys) seen.set(k, label);
    return null;
  };
  for (const r of state.stock) {
    const category = r.category.trim();
    const name = r.name.trim();
    const label = name || "(名前なし)";
    if (!Number.isInteger(r.qty) || r.qty < 0) return { ok: false, error: `「${label}」の本数は 0 以上の整数にしてください` };
    if (r.itemTypeId) {
      // 既存品目は ID でも、登録名 (新しい名前の行と重なる場合) でも照合する
      const err = dup([`id:${r.itemTypeId}`, `name:${fold(category)}/${fold(name)}`], label);
      if (err) return { ok: false, error: err };
      stock.push({ item_type_id: r.itemTypeId, qty: r.qty });
      continue;
    }
    if (!category || !name) return { ok: false, error: "新しい品目には分類と名前を入れてください" };
    const err = dup([`name:${fold(category)}/${fold(name)}`], label);
    if (err) return { ok: false, error: err };
    stock.push(r.attrs ? { category, name, attrs: r.attrs, qty: r.qty } : { category, name, qty: r.qty });
  }

  const assets: string[] = [];
  for (const a of state.assets) {
    if (!a.pick) continue;
    if (assets.includes(a.pick)) return { ok: false, error: "同じ個体を 2 行で選んでいます" };
    assets.push(a.pick);
  }

  const newAssets: NewAsset[] = [];
  const serials = new Set<string>();
  for (const a of state.assets) {
    if (a.match !== "new" || a.mode !== "register") continue;
    const category = clean(a.draft.category);
    const name = clean(a.draft.name);
    if (!category || !name) return { ok: false, error: "個体の名前を入れてください" };
    const maker = clean(a.draft.maker) ?? null;
    const model = clean(a.draft.model) ?? null;
    const serial = clean(a.draft.serial) ?? null;
    // assets の UNIQUE (maker, model, serial) と同じく、どれかが空なら重複にならない
    if (maker !== null && model !== null && serial !== null) {
      const k = JSON.stringify([maker, model, serial]);
      if (serials.has(k)) return { ok: false, error: "同じ個体を 2 行で登録しようとしています" };
      serials.add(k);
    }
    newAssets.push({ category, name, maker, model, serial });
  }

  const final: ConfirmFinal = { stock, assets };
  if (newAssets.length) final.new_assets = newAssets;
  if (state.container) {
    const kind = state.container.kind.trim();
    if (!kind) return { ok: false, error: "コンテナの種別を入れてください" };
    const name = state.container.name.trim();
    const current = opts.current;
    const fresh = !current || !!opts.fresh;
    const changed = fresh || kind !== current.kind || name !== (current.name ?? "").trim();
    if (changed) final.container = name ? { kind, name } : { kind };
  }
  return { ok: true, final };
}

/** 個体の見出し (メーカー / 型番 / シリアル)。 */
export function assetLabel(a: Pick<AssetLine, "maker" | "model" | "serial"> & { item_name?: string }): string {
  return [a.maker, a.model, a.serial].filter(Boolean).join(" / ") || a.item_name || "(不明)";
}
