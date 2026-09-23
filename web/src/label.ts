// ラベル画面 (LabelScreen) の編集フォーム → POST /api/assets 本文への変換。
// 副作用なしの純粋関数だけを置く (通信・DOM は LabelScreen.tsx 側)。
import type { CreateAssetBody } from "./api";

export type LabelForm = {
  maker: string;
  model: string;
  serial: string;
  /** 品目名。空なら model を使う。 */
  name: string;
  /** 区分 (category)。空なら "device"。 */
  category: string;
  memo: string;
};

export type CreateAssetOptions = {
  /** 登録先。null/undefined なら「場所なし」(container_id を送らない)。 */
  containerId?: string | null;
  judgementId?: string;
  photoId?: string;
};

const DEFAULT_CATEGORY = "device";

/** 前後の空白を落とし、空なら undefined。 */
export function clean(v: string): string | undefined {
  const t = v.trim();
  return t ? t : undefined;
}

/** フォームの値を `POST /api/assets` の本文にする。空欄のフィールドは送らない。 */
export function buildCreateAssetBody(form: LabelForm, opts: CreateAssetOptions = {}): CreateAssetBody {
  const maker = clean(form.maker);
  const model = clean(form.model);
  const serial = clean(form.serial);
  const memo = clean(form.memo);
  const name = clean(form.name) ?? model;
  const category = clean(form.category) ?? DEFAULT_CATEGORY;

  const body: CreateAssetBody = { category };
  if (name) body.name = name;
  if (maker) body.maker = maker;
  if (model) body.model = model;
  if (serial) body.serial = serial;
  if (memo) body.memo = memo;
  if (opts.containerId) body.container_id = opts.containerId;
  if (opts.judgementId) body.judgement_id = opts.judgementId;
  if (opts.photoId) body.photo_id = opts.photoId;
  return body;
}

export const emptyLabelForm: LabelForm = { maker: "", model: "", serial: "", name: "", category: "", memo: "" };
