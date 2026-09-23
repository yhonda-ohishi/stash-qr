import { describe, expect, test } from "vitest";
import { buildCreateContainerBody, emptyNewContainerForm } from "./newContainer";

describe("buildCreateContainerBody", () => {
  test("空欄のフィールドは送らない", () => {
    const body = buildCreateContainerBody(emptyNewContainerForm);
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("memo");
    expect(body).not.toHaveProperty("parent_id");
    expect(body.kind).toBe("");
  });

  test("種別は trim する", () => {
    expect(buildCreateContainerBody({ ...emptyNewContainerForm, kind: "  box  " }).kind).toBe("box");
  });

  test("空白だけの値も空欄扱い", () => {
    const body = buildCreateContainerBody({ ...emptyNewContainerForm, name: "  ", memo: " メモ " });
    expect(body).not.toHaveProperty("name");
    expect(body.memo).toBe("メモ");
  });

  test("parent の有無で parent_id の有無が決まる (null/未指定は送らない)", () => {
    expect(buildCreateContainerBody(emptyNewContainerForm, { parentId: null })).not.toHaveProperty("parent_id");
    expect(buildCreateContainerBody(emptyNewContainerForm, {})).not.toHaveProperty("parent_id");
    expect(buildCreateContainerBody(emptyNewContainerForm, { parentId: "ABC123" }).parent_id).toBe("ABC123");
  });
});
