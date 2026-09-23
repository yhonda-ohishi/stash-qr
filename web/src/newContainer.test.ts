import { describe, expect, test } from "vitest";
import { buildCreateContainerBody, emptyNewContainerForm } from "./newContainer";

describe("buildCreateContainerBody", () => {
  test("種別を trim して送る", () => {
    const body = buildCreateContainerBody({ ...emptyNewContainerForm, kind: " shelf " });
    expect(body?.kind).toBe("shelf");
  });

  test("空の種別 (空白だけも含む) は null を返し送信を止める", () => {
    expect(buildCreateContainerBody({ ...emptyNewContainerForm, kind: "" })).toBeNull();
    expect(buildCreateContainerBody({ ...emptyNewContainerForm, kind: "   " })).toBeNull();
  });

  test("名前とメモの空欄 (空白だけも含む) は送らない", () => {
    const body = buildCreateContainerBody(emptyNewContainerForm);
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("memo");

    const spaceOnly = buildCreateContainerBody({ ...emptyNewContainerForm, name: "  ", memo: " " });
    expect(spaceOnly).not.toHaveProperty("name");
    expect(spaceOnly).not.toHaveProperty("memo");
  });

  test("名前・メモがあれば trim して送る", () => {
    const body = buildCreateContainerBody({ kind: "box", name: " 工具箱 ", memo: " 予備 " });
    expect(body?.name).toBe("工具箱");
    expect(body?.memo).toBe("予備");
  });

  test("parent の有無で parent_id の有無が決まる (null/未指定は送らない)", () => {
    expect(buildCreateContainerBody(emptyNewContainerForm)).not.toHaveProperty("parent_id");
    expect(buildCreateContainerBody(emptyNewContainerForm, null)).not.toHaveProperty("parent_id");
    expect(buildCreateContainerBody(emptyNewContainerForm, "ABC123")?.parent_id).toBe("ABC123");
  });
});
