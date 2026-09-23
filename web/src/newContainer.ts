// 作成画面 (NewContainerScreen) の入力フォーム → POST /api/containers 本文への変換。
// 副作用なしの純粋関数だけを置く (通信・DOM は NewContainerScreen.tsx 側)。
import type { CreateContainerBody } from "./api";

export type NewContainerForm = {
  kind: string;
  name: string;
  memo: string;
};

export type CreateContainerOptions = {
  /** 作る場所。null/undefined なら一番上 (parent_id を送らない)。 */
  parentId?: string | null;
};

export const emptyNewContainerForm: NewContainerForm = { kind: "", name: "", memo: "" };

/** 前後の空白を落とし、空なら undefined。 */
function clean(v: string): string | undefined {
  const t = v.trim();
  return t ? t : undefined;
}

/** フォームの値を `POST /api/containers` の本文にする。空欄のフィールドは送らない。 */
export function buildCreateContainerBody(form: NewContainerForm, opts: CreateContainerOptions = {}): CreateContainerBody {
  const kind = clean(form.kind) ?? "";
  const name = clean(form.name);
  const memo = clean(form.memo);

  const body: CreateContainerBody = { kind };
  if (name) body.name = name;
  if (memo) body.memo = memo;
  if (opts.parentId) body.parent_id = opts.parentId;
  return body;
}
