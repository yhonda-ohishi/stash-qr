import { describe, expect, test } from "vitest";
import { buildCreateAssetBody, emptyLabelForm } from "./label";

describe("buildCreateAssetBody", () => {
  test("空欄のフィールドは送らない", () => {
    const body = buildCreateAssetBody(emptyLabelForm);
    expect(body).not.toHaveProperty("maker");
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("serial");
    expect(body).not.toHaveProperty("memo");
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("container_id");
    expect(body).not.toHaveProperty("judgement_id");
    expect(body).not.toHaveProperty("photo_id");
  });

  test("空白だけの値も空欄扱い", () => {
    const body = buildCreateAssetBody({ ...emptyLabelForm, maker: "  ", model: " TM-L100 " });
    expect(body).not.toHaveProperty("maker");
    expect(body.model).toBe("TM-L100");
  });

  test("品目名の既定は型番、両方あれば品目名を優先", () => {
    expect(buildCreateAssetBody({ ...emptyLabelForm, model: "TM-L100" }).name).toBe("TM-L100");
    expect(buildCreateAssetBody({ ...emptyLabelForm, model: "TM-L100", name: "レシートプリンタ" }).name).toBe(
      "レシートプリンタ",
    );
    expect(buildCreateAssetBody(emptyLabelForm).name).toBeUndefined();
  });

  test("区分の既定は device、指定があれば尊重する", () => {
    expect(buildCreateAssetBody(emptyLabelForm).category).toBe("device");
    expect(buildCreateAssetBody({ ...emptyLabelForm, category: "cable" }).category).toBe("cable");
  });

  test("container の有無で container_id の有無が決まる (null/未指定は送らない)", () => {
    expect(buildCreateAssetBody(emptyLabelForm, { containerId: null })).not.toHaveProperty("container_id");
    expect(buildCreateAssetBody(emptyLabelForm, {})).not.toHaveProperty("container_id");
    expect(buildCreateAssetBody(emptyLabelForm, { containerId: "ABC123" }).container_id).toBe("ABC123");
  });

  test("judgement_id / photo_id はあれば付ける", () => {
    const body = buildCreateAssetBody(emptyLabelForm, { judgementId: "J1", photoId: "P1" });
    expect(body.judgement_id).toBe("J1");
    expect(body.photo_id).toBe("P1");
  });
});
