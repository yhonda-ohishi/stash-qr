// 品目ごとの切り抜き表示 (ui.tsx の Crop) の位置計算。画像は切って保存せず、元の写真を CSS だけで切る。
import type { Box } from "./api";

/** 0〜1000 の正規化座標 (Gemini の box_2d)。 */
const BOX_MAX = 1000;

export type CropStyle = {
  /** 枠の中で box の範囲だけを見せる窓 (中央に置く)。余りは外枠の背景色 */
  clip: { width: number; height: number };
  /** 窓の中の写真 (position:absolute) */
  img: { width: number; height: number; left: number; top: number };
};

/**
 * `box` = `[ymin, xmin, ymax, xmax]` の範囲が `size` px の正方形にちょうど入るよう、写真
 * (元の寸法 `naturalW` × `naturalH`) を拡大してずらす。box の長い辺を `size` に合わせる。
 * 寸法か box が使えなければ null。
 */
export function cropStyle(box: Box, naturalW: number, naturalH: number, size: number): CropStyle | null {
  if (!(naturalW > 0 && naturalH > 0 && size > 0)) return null;
  const [ymin, xmin, ymax, xmax] = box;
  const bx = (xmin / BOX_MAX) * naturalW;
  const by = (ymin / BOX_MAX) * naturalH;
  const bw = ((xmax - xmin) / BOX_MAX) * naturalW;
  const bh = ((ymax - ymin) / BOX_MAX) * naturalH;
  if (!(bw > 0 && bh > 0)) return null;
  const scale = size / Math.max(bw, bh);
  return {
    clip: { width: bw * scale, height: bh * scale },
    img: {
      width: naturalW * scale,
      height: naturalH * scale,
      left: -bx * scale,
      top: -by * scale,
    },
  };
}
