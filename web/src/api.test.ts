import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, stockDelta, toApiError } from "./api";

describe("toApiError", () => {
  test("worker の {error} を message に、本文を body に", () => {
    const e = toApiError(409, JSON.stringify({ error: "not enough stock" }));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(409);
    expect(e.message).toBe("not enough stock");
    expect(e.body).toEqual({ error: "not enough stock" });
  });
  test("{error} 以外の値も body に残る (個体の重複)", () => {
    const e = toApiError(409, JSON.stringify({ error: "dup", asset: { id: "X" } }));
    expect((e.body as { asset: { id: string } }).asset.id).toBe("X");
  });
  test("JSON でなければ短い本文、HTML や空なら HTTP <status>", () => {
    expect(toApiError(502, "bad gateway").message).toBe("bad gateway");
    expect(toApiError(401, "<!doctype html><html>login</html>").message).toBe("HTTP 401");
    expect(toApiError(500, "").message).toBe("HTTP 500");
    expect(toApiError(500, "x".repeat(300)).message).toBe("HTTP 500");
  });
  test("error が文字列でない JSON は HTTP <status>", () => {
    expect(toApiError(400, JSON.stringify({ error: 1 })).message).toBe("HTTP 400");
  });
});

describe("fetch ラッパー", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("失敗応答は ApiError で投げる・同一オリジンの cookie 付き・JSON 本文", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "not enough stock" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await stockDelta("ABC123", "T1", -1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/containers/ABC123/stock");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(init.body as string)).toEqual({ item_type_id: "T1", delta: -1, note: null });
  });

  test("通信できなければ status 0 の ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const err = await stockDelta("ABC123", "T1", 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
  });
});
