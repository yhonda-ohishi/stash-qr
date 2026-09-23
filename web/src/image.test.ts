import { describe, expect, test } from "vitest";
import { fitSize, MAX_EDGE } from "./image";

describe("fitSize", () => {
  test("横長・縦長とも長辺を max に", () => {
    expect(fitSize(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitSize(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 });
  });
  test("すでに小さければ拡大しない・ちょうどならそのまま", () => {
    expect(fitSize(800, 600, 2048)).toEqual({ width: 800, height: 600 });
    expect(fitSize(2048, 1000, 2048)).toEqual({ width: 2048, height: 1000 });
  });
  test("端数は丸め、極端な比率でも 1px は残す", () => {
    expect(fitSize(4032, 3024, MAX_EDGE)).toEqual({ width: 2048, height: 1536 });
    expect(fitSize(3001, 2001, 2048)).toEqual({ width: 2048, height: 1366 });
    expect(fitSize(100000, 10, 2048)).toEqual({ width: 2048, height: 1 });
  });
  test("正方形", () => {
    expect(fitSize(3000, 3000, 2048)).toEqual({ width: 2048, height: 2048 });
  });
});
