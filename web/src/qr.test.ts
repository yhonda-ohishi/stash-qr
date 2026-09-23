import { describe, expect, test } from "vitest";
import { appPath, parseQr } from "./qr";

describe("parseQr", () => {
  test("コンテナと個体", () => {
    expect(parseQr("https://stash.mtamaramu.com/c/ABC123")).toEqual({ kind: "c", id: "ABC123" });
    expect(parseQr("https://stash.mtamaramu.com/a/0123456789ABCDEF")).toEqual({ kind: "a", id: "0123456789ABCDEF" });
  });
  test("末尾のスラッシュ・前後の空白", () => {
    expect(parseQr("https://stash.mtamaramu.com/c/ABC123/")).toEqual({ kind: "c", id: "ABC123" });
    expect(parseQr("  https://stash.mtamaramu.com/c/ABC123\n")).toEqual({ kind: "c", id: "ABC123" });
  });
  test("大文字小文字の違い (ID は大文字にそろえる)", () => {
    expect(parseQr("HTTPS://STASH.MTAMARAMU.COM/C/abc123")).toEqual({ kind: "c", id: "ABC123" });
    expect(parseQr("https://Stash.Mtamaramu.com/A/abcdef")).toEqual({ kind: "a", id: "ABCDEF" });
  });
  test("他のドメイン・http・ポート付きは読まない", () => {
    expect(parseQr("https://example.com/c/ABC123")).toBeNull();
    expect(parseQr("https://stash.mtamaramu.com.example.com/c/ABC123")).toBeNull();
    expect(parseQr("https://evil.stash.mtamaramu.com/c/ABC123")).toBeNull();
    expect(parseQr("http://stash.mtamaramu.com/c/ABC123")).toBeNull();
    expect(parseQr("https://stash.mtamaramu.com:8443/c/ABC123")).toBeNull();
  });
  test("ゴミ・別のパス", () => {
    expect(parseQr("")).toBeNull();
    expect(parseQr("ABC123")).toBeNull();
    expect(parseQr("not a url")).toBeNull();
    expect(parseQr("https://stash.mtamaramu.com/")).toBeNull();
    expect(parseQr("https://stash.mtamaramu.com/c/")).toBeNull();
    expect(parseQr("https://stash.mtamaramu.com/x/ABC123")).toBeNull();
    expect(parseQr("https://stash.mtamaramu.com/c/ABC123/extra")).toBeNull();
    expect(parseQr("https://stash.mtamaramu.com/app/c/ABC123")).toBeNull();
    expect(parseQr("https://stash.mtamaramu.com/c/<script>")).toBeNull();
  });
  test("appPath は PWA の中のパス", () => {
    expect(appPath({ kind: "c", id: "ABC123" })).toBe("/app/c/ABC123");
    expect(appPath({ kind: "a", id: "XYZ" })).toBe("/app/a/XYZ");
  });
});
