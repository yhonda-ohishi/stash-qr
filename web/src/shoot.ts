// 「撮影して登録」(ShootScreen → JudgeScreen) が撮った画像を 1 回だけ受け渡す置き場。
// URL には載せない (画像は大きい)。モジュール内の変数を経由するだけなので、
// ページを再読み込みすると消える (そのときは JudgeScreen が通常の撮影に戻る)。
let pendingImage: Blob | null = null;

export function setPendingShootImage(blob: Blob): void {
  pendingImage = blob;
}

/** 取り出したら消える (2 回使わない)。無ければ null。 */
export function takePendingShootImage(): Blob | null {
  const blob = pendingImage;
  pendingImage = null;
  return blob;
}
