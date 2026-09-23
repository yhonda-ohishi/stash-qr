import { describe, expect, test } from "vitest";
import { setPendingShootImage, takePendingShootImage } from "./shoot";

describe("shoot pending image", () => {
  test("取り出したら消える (2 回目は null)", () => {
    const blob = new Blob(["x"]);
    setPendingShootImage(blob);
    expect(takePendingShootImage()).toBe(blob);
    expect(takePendingShootImage()).toBeNull();
  });

  test("何も置いていなければ null", () => {
    expect(takePendingShootImage()).toBeNull();
  });
});
