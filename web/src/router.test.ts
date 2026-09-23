import { describe, expect, test } from "vitest";
import { matchPath, matchRoute, parseQuery, type Route } from "./router";
import { routes } from "./routes";

describe("matchPath", () => {
  test("パラメータを取り出す", () => {
    expect(matchPath("/app/c/:id", "/app/c/ABC123")).toEqual({ id: "ABC123" });
  });
  test("末尾のスラッシュは同じに扱う", () => {
    expect(matchPath("/app", "/app/")).toEqual({});
    expect(matchPath("/app/c/:id", "/app/c/ABC123/")).toEqual({ id: "ABC123" });
  });
  test("%xx はデコードする・壊れた %xx は一致しない", () => {
    expect(matchPath("/app/c/:id", "/app/c/A%20B")).toEqual({ id: "A B" });
    expect(matchPath("/app/c/:id", "/app/c/%E0%A4%A")).toBeNull();
  });
  test("段数や固定部分が違えば null", () => {
    expect(matchPath("/app/c/:id", "/app/c")).toBeNull();
    expect(matchPath("/app/c/:id", "/app/c/ABC123/x")).toBeNull();
    expect(matchPath("/app/c/:id", "/app/a/ABC123")).toBeNull();
    expect(matchPath("/app/c/:id", "/app/c//")).toBeNull();
  });
  test("/ は / だけに一致する", () => {
    expect(matchPath("/", "/")).toEqual({});
    expect(matchPath("/", "/app")).toBeNull();
  });
});

describe("matchRoute (routes.tsx の実物)", () => {
  const screenOf = (path: string) => matchRoute(routes, path)?.route.pattern ?? null;
  test("ホーム・コンテナ・個体・移動", () => {
    expect(screenOf("/")).toBe("/");
    expect(screenOf("/app")).toBe("/app");
    expect(screenOf("/app/")).toBe("/app");
    expect(screenOf("/app/c/ABC123")).toBe("/app/c/:id");
    expect(screenOf("/app/a/0123456789ABCDEF")).toBe("/app/a/:id");
    expect(screenOf("/app/move")).toBe("/app/move");
  });
  test("未一致 (QR の簡易 HTML・API・知らない画面) は null", () => {
    expect(screenOf("/c/ABC123")).toBeNull();
    expect(screenOf("/api/search")).toBeNull();
    expect(screenOf("/app/nope")).toBeNull();
  });
  test("上から順に最初の一致を採る", () => {
    const Dummy = () => null;
    const table: Route[] = [
      { pattern: "/app/c/new", screen: Dummy },
      { pattern: "/app/c/:id", screen: Dummy },
    ];
    expect(matchRoute(table, "/app/c/new")?.route.pattern).toBe("/app/c/new");
    expect(matchRoute(table, "/app/c/X")?.params).toEqual({ id: "X" });
  });
});

describe("parseQuery", () => {
  test("クエリ文字列を読む", () => {
    expect(parseQuery("?q=USB%20C&x=1")).toEqual({ q: "USB C", x: "1" });
    expect(parseQuery("q=%E7%AE%B1")).toEqual({ q: "箱" });
    expect(parseQuery("")).toEqual({});
  });
  test("同じキーは最後を採る", () => {
    expect(parseQuery("?a=1&a=2")).toEqual({ a: "2" });
  });
});
