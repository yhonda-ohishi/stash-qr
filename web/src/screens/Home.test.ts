import { describe, expect, test } from "vitest";
import { withoutParam } from "./Home";

describe("withoutParam", () => {
  test("指定したキーだけ外す・他は残す", () => {
    expect(withoutParam({ scan: "1", q: "USB" }, "scan")).toBe("/app?q=USB");
    expect(withoutParam({ search: "1", q: "箱" }, "search")).toBe("/app?q=%E7%AE%B1");
  });
  test("残りが無ければクエリなし", () => {
    expect(withoutParam({ scan: "1" }, "scan")).toBe("/app");
  });
  test("そのキーが無ければ何も変わらない", () => {
    expect(withoutParam({ q: "x" }, "scan")).toBe("/app?q=x");
  });
});
