// 写真なしで作るコンテナ (NewContainerScreen) の編集フォーム → POST /api/containers 本文への変換。
// 副作用なしの純粋関数だけを置く (通信・DOM は NewContainerScreen.tsx 側)。
import type { CreateContainerBody } from "./api";

export type NewContainerForm = {
  kind: string;
  name: string;
  memo: string;
};

export const emptyNewContainerForm: NewContainerForm = { kind: "shelf", name: "", memo: "" };

/** よく使う種別。値は worker に既定値の制約は無いので自由入力も許す。 */
export const COMMON_KINDS: { value: string; label: string }[] = [
  { value: "shelf", label: "棚" },
  { value: "room", label: "部屋" },
  { value: "box", label: "箱" },
  { value: "bag", label: "袋" },
  { value: "case", label: "ケース" },
  { value: "drawer", label: "引き出し" },
];

/** 前後の空白を落とし、空なら undefined。 */
function clean(v: string): string | undefined {
  const t = v.trim();
  return t ? t : undefined;
}

/**
 * フォームの値を `POST /api/containers` の本文にする。種別は trim して空なら null を返す
 * (呼び出し側は null なら送信を止める)。名前・メモの空欄は送らない。
 */
export function buildCreateContainerBody(
  form: NewContainerForm,
  parentId?: string | null,
): CreateContainerBody | null {
  const kind = clean(form.kind);
  if (!kind) return null;

  const body: CreateContainerBody = { kind };
  const name = clean(form.name);
  const memo = clean(form.memo);
  if (name) body.name = name;
  if (memo) body.memo = memo;
  if (parentId) body.parent_id = parentId;
  return body;
}
