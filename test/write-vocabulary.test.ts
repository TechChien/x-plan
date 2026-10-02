import { describe, expect, test } from "vitest";
import { applyVocabulary, checkVocabulary, renderVocabulary, vocabularyLocations, type VocabularySubmission } from "../src/write/vocabulary.ts";
import { alignedFixture, outlineFixture, writtenFixture } from "./helpers/write.ts";

function fixture() {
  const aligned = alignedFixture();
  const outline = outlineFixture(aligned);
  return { aligned, outline, written: writtenFixture(aligned, outline) };
}

const entry = { canonical: "會員", definition: "在平台註冊的購買者", avoid: ["使用者", "用戶"], sourceIds: ["ACT-1"] };

describe("vocabularyLocations", () => {
  test("labels every piece of Gherkin text a replacement may target", () => {
    const { outline, written } = fixture();
    const locs = vocabularyLocations(outline, written);
    expect(locs.get("FEAT-1/description")).toBe("會員可以取消訂單");
    expect(locs.get("FEAT-1/background/0")).toBe("會員已登入");
    expect(locs.get("FEAT-1/rule/0")).toBe("一般會員 7 天內可取消");
    expect(locs.get("SCN-2/title")).toBe("下單第 8 天取消被拒");
    expect(locs.get("SCN-2/step/0")).toBe("一般會員下單已 <天數> 天");
    expect(locs.get("SCN-2/examples/0/name")).toBe("邊界");
    expect(locs.get("SCN-2/examples/0/row/0/cell/0")).toBe("8");
    expect(locs.get("SCN-5/title")).toBe("到貨第 2 天申請退貨");
    expect(locs.has("SCN-5/step/0")).toBe(false);
  });
});

describe("applyVocabulary", () => {
  function written() {
    const f = fixture();
    const w = f.written.get("FEAT-1")!;
    w.scenarios[0]!.steps[1]!.text = "使用者取消訂單，「使用者」欄位不變，<使用者編號> 不變，使用者再確認";
    w.description = "使用者可以取消訂單";
    return f;
  }

  test("replaces at the given location only, outside placeholders and quotes, and records each replacement", () => {
    const { outline, written: w } = written();
    const sub: VocabularySubmission = {
      entries: [entry],
      replacements: [{ loc: "SCN-1/step/1", from: "使用者", to: "會員" }],
    };
    const result = applyVocabulary(outline, w, sub);
    expect(result.written.get("FEAT-1")!.scenarios[0]!.steps[1]!.text).toBe("會員取消訂單，「使用者」欄位不變，<使用者編號> 不變，會員再確認");
    expect(result.written.get("FEAT-1")!.description).toBe("使用者可以取消訂單");
    expect(result.applied).toEqual([{ loc: "SCN-1/step/1", from: "使用者", to: "會員", count: 2, before: "使用者取消訂單，「使用者」欄位不變，<使用者編號> 不變，使用者再確認", after: "會員取消訂單，「使用者」欄位不變，<使用者編號> 不變，會員再確認" }]);
    expect(w.get("FEAT-1")!.scenarios[0]!.steps[1]!.text).toMatch(/^使用者/);
  });

  test("replaces outline titles and Rule titles in the copy it returns, leaving the outline as accepted", () => {
    const { outline, written: w } = fixture();
    const result = applyVocabulary(outline, w, { entries: [], replacements: [{ loc: "SCN-1/title", from: "下單", to: "訂購" }, { loc: "FEAT-1/rule/1", from: "VIP", to: "貴賓" }] });
    expect(result.outline.scenarios[0]!.title).toBe("訂購當天取消");
    expect(result.outline.features[0]!.rules[1]!.title).toBe("貴賓 10 天內可取消");
    expect(outline.scenarios[0]!.title).toBe("下單當天取消");
  });

  test("a replacement whose location or text is not found is skipped, not refused", () => {
    const { outline, written: w } = written();
    const result = applyVocabulary(outline, w, {
      entries: [],
      replacements: [
        { loc: "SCN-99/step/0", from: "a", to: "b" },
        { loc: "SCN-1/step/0", from: "使用者", to: "會員" },
        { loc: "SCN-1/step/1", from: "使用者編號", to: "會員編號" },
      ],
    });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      { loc: "SCN-99/step/0", from: "a", to: "b", reason: "no such location" },
      { loc: "SCN-1/step/0", from: "使用者", to: "會員", reason: "not found outside placeholders and quotes" },
      { loc: "SCN-1/step/1", from: "使用者編號", to: "會員編號", reason: "not found outside placeholders and quotes" },
    ]);
  });
});

describe("checkVocabulary", () => {
  test("only the language of definitions is checked", () => {
    const sub: VocabularySubmission = { entries: [entry, { ...entry, canonical: "订单", definition: "购买的记录" }], replacements: [{ loc: "nowhere", from: "x", to: "y" }] };
    expect(checkVocabulary(sub, "zh")).toEqual({ issues: [{ path: "entries[1]", errors: [expect.stringMatching(/not written in/)] }] });
  });
});

describe("renderVocabulary", () => {
  test("one entry per term in the CONTEXT.md format, with sources and how often it was applied", () => {
    const md = renderVocabulary([entry, { canonical: "訂單", definition: "會員的一次購買", avoid: [], sourceIds: [] }], [
      { loc: "SCN-1/step/1", from: "使用者", to: "會員", count: 2, before: "", after: "" },
      { loc: "FEAT-1/description", from: "用戶", to: "會員", count: 1, before: "", after: "" },
    ]);
    expect(md).toBe(
      ["# Vocabulary", "", "**會員**:", "在平台註冊的購買者", "_Avoid_: 使用者, 用戶", "_Sources_: ACT-1 · replaced 3 times", "", "**訂單**:", "會員的一次購買", "_Sources_: — · replaced 0 times", ""].join("\n"),
    );
  });
});
