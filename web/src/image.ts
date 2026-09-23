// 送る前に写真を縮める。長辺 2048px 以下・JPEG 品質 0.85 (撮影・ラベル判定が使う)。

export const MAX_EDGE = 2048;
export const JPEG_QUALITY = 0.85;

/** 長辺が `max` 以下になる寸法。すでに小さければそのまま (拡大しない)。 */
export function fitSize(w: number, h: number, max: number): { width: number; height: number } {
  const long = Math.max(w, h);
  if (long <= max) return { width: w, height: h };
  const scale = max / long;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** EXIF の向きを反映して描き直し、JPEG にする。 */
export async function shrinkImage(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const { width, height } = fitSize(bitmap.width, bitmap.height, MAX_EDGE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d is not available");
    ctx.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("JPEG にできません"))), "image/jpeg", JPEG_QUALITY),
    );
  } finally {
    bitmap.close();
  }
}
