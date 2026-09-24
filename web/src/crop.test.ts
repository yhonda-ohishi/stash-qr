import { describe, expect, test } from "vitest";
import { cropStyle } from "./crop";

describe("cropStyle", () => {
  test("正方形の写真・正方形の枠: 枠の範囲が size いっぱいに入る", () => {
    // 1000x1000 の写真の (100,200)-(300,400) → 200px 四方を 50px に
    expect(cropStyle([200, 100, 400, 300], 1000, 1000, 50)).toEqual({
      clip: { width: 50, height: 50 },
      img: { width: 250, height: 250, left: -25, top: -50 },
    });
  });

  test("横長の写真: 横長の枠は幅を size に合わせ、高さの余りは背景 (窓が低い)", () => {
    // 2000x1000、box 横 0〜500 (=1000px)、縦 0〜250 (=250px)
    const s = cropStyle([0, 0, 250, 500], 2000, 1000, 100)!;
    expect(s.clip).toEqual({ width: 100, height: 25 });
    expect(s.img).toEqual({ width: 200, height: 100, left: -0, top: -0 });
  });

  test("縦長の写真: 縦長の枠は高さを size に合わせる", () => {
    // 1000x2000、box 横 500〜600 (=100px)、縦 500〜1000 (=1000px)
    const s = cropStyle([500, 500, 1000, 600], 1000, 2000, 100)!;
    expect(s.clip).toEqual({ width: 10, height: 100 });
    expect(s.img).toEqual({ width: 100, height: 200, left: -50, top: -100 });
  });

  test("box が右下の端・とても小さい", () => {
    // 640x480、右下 1/1000 の範囲 → 拡大率が大きい
    const s = cropStyle([999, 999, 1000, 1000], 640, 480, 56)!;
    expect(s.clip.width).toBeCloseTo((0.64 / 0.64) * 56);
    expect(s.clip.height).toBeCloseTo((0.48 / 0.64) * 56);
    const scale = 56 / 0.64;
    expect(s.img.width).toBeCloseTo(640 * scale);
    expect(s.img.left).toBeCloseTo(-639.36 * scale);
    expect(s.img.top).toBeCloseTo(-479.52 * scale);
    // 窓の右下 = 写真の右下
    expect(s.img.left + s.img.width).toBeCloseTo(s.clip.width);
    expect(s.img.top + s.img.height).toBeCloseTo(s.clip.height);
  });

  test("写真全体の box は写真をそのまま縮めた形", () => {
    expect(cropStyle([0, 0, 1000, 1000], 640, 480, 64)).toEqual({
      clip: { width: 64, height: 48 },
      img: { width: 64, height: 48, left: -0, top: -0 },
    });
  });

  test("寸法が 0 (読み込み前) や幅 0 の box は null", () => {
    expect(cropStyle([0, 0, 10, 10], 0, 0, 56)).toBeNull();
    expect(cropStyle([0, 10, 10, 10], 640, 480, 56)).toBeNull();
  });
});
