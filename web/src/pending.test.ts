import { describe, expect, test } from "vitest";
import { planResend } from "./pending";

describe("planResend", () => {
  test("photoId を持つものだけを、サーバーの pending に居れば送る・居なければ捨てる", () => {
    const entries = [
      { localId: "1", photoId: "P1" },
      { localId: "2", photoId: "P2" },
      { localId: "3" }, // 応答が無かった (送り直せない) → 触らない
    ];
    const { send, drop } = planResend(entries, new Set(["P1"]));
    expect(send.map((e) => e.localId)).toEqual(["1"]);
    expect(drop.map((e) => e.localId)).toEqual(["2"]);
  });
});
