import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { judgeReview, markUnverified, reviewErrors, reviewMemo, reviewToYaml, underReview, type ReviewSubmission } from "../src/write/review.ts";
import type { WrittenFeature } from "../src/write/schema.ts";
import { alignedFixture, outlineFixture, writtenFixture } from "./helpers/write.ts";

function fixture() {
  const aligned = alignedFixture();
  const outline = outlineFixture(aligned);
  const feature = writtenFixture(aligned, outline).get("FEAT-1")!;
  return { aligned, outline, feature, units: underReview(feature, outline) };
}

type Line = ReviewSubmission["reviews"][number]["lines"][number];
const ok = (ref: string, extra: Partial<Line> = {}): Line => ({ ref, grounding: "stated", contradicts: false, values: [], actualSourceIds: [], ...extra });

/** A review that finds nothing: every line of every unit stated by what it cites. */
function clean(units: ReturnType<typeof underReview>): ReviewSubmission {
  return { reviews: units.map((u) => ({ unit: u.unit, lines: u.lines.map((l) => ok(l.ref)) })) };
}

describe("underReview", () => {
  test("the Background and every written scenario, each line with what it cites", () => {
    const { units } = fixture();
    expect(units.map((u) => u.unit)).toEqual(["background", "SCN-1", "SCN-2", "SCN-3", "SCN-4"]);
    expect(units[2]!.lines).toEqual([
      { ref: "steps[0]", text: "Given 一般會員下單已 <天數> 天", sourceIds: ["DEC-1"], derived: true },
      { ref: "steps[1]", text: "When 會員取消訂單", sourceIds: ["FEAT-1"], derived: true },
      { ref: "steps[2]", text: "Then 系統拒絕取消", sourceIds: ["DEC-1"], derived: true },
      { ref: "examples[0].rows[0]", text: "天數 = 8", sourceIds: ["DEC-1"], derived: true },
    ]);
  });
});

describe("reviewToYaml", () => {
  test("shows each unit's lines and the full text of what they cite, nothing else", () => {
    const { aligned, units } = fixture();
    const view = parse(reviewToYaml(aligned, units.filter((u) => u.unit === "SCN-3")));
    expect(view.scenarios).toEqual([
      { unit: "SCN-3", title: "VIP 第 10 天取消", kind: "specified", lines: [
        { ref: "steps[0]", text: "Given VIP 會員下單已 10 天", sourceIds: ["DEC-5"] },
        { ref: "steps[1]", text: "When 會員取消訂單", sourceIds: ["FEAT-1"] },
        { ref: "steps[2]", text: "Then 系統接受取消", sourceIds: ["DEC-5"] },
      ] },
    ]);
    expect(view.sources.map((s: { id: string }) => s.id)).toEqual(["FEAT-1", "DEC-5"]);
    expect(view.sources[1]).toEqual({ id: "DEC-5", conclusion: "VIP 10 天內可取消", answer: "回答 DEC-5" });
    expect(view.sources[0]).toEqual({ id: "FEAT-1", name: "取消訂單", description: "取消訂單" });
  });
});

describe("reviewErrors", () => {
  test("every unit and every line reviewed exactly once", () => {
    const { units } = fixture();
    const sub = clean(units);
    sub.reviews[1]!.lines.pop();
    sub.reviews.push({ unit: "SCN-9", lines: [] }, { ...sub.reviews[2]! });
    sub.reviews[3]!.lines.push(ok("steps[7]"));
    sub.reviews.splice(4, 1);
    expect(reviewErrors(sub, units)).toEqual([
      "SCN-9 is not under review",
      "SCN-2 is reviewed more than once",
      "SCN-4 has no review",
      "SCN-1: steps[2] has no review",
      "SCN-3: steps[7] is not a line of SCN-3",
    ]);
  });
});

describe("judgeReview", () => {
  const paths = new Map([["background", "background"], ["SCN-1", "scenarios[0]"], ["SCN-2", "scenarios[1]"], ["SCN-3", "scenarios[2]"], ["SCN-4", "scenarios[3]"]]);

  test("a clean review flags nothing", () => {
    const { units } = fixture();
    const outcome = judgeReview(units, clean(units), { attempt: 1, paths });
    expect(outcome.issues).toEqual([]);
    expect(outcome.flagged.size).toBe(0);
    expect(outcome.records.every((r) => r.verdicts.length === 0)).toBe(true);
  });

  test("each finding becomes a verdict and feedback the writer can act on", () => {
    const { units } = fixture();
    const sub = clean(units);
    const line = (unit: string, ref: string, extra: Partial<Line>) => Object.assign(sub.reviews.find((r) => r.unit === unit)!.lines.find((l) => l.ref === ref)!, extra);
    line("SCN-1", "steps[2]", { grounding: "none" });
    line("SCN-2", "steps[2]", { grounding: "none" });
    line("SCN-3", "steps[0]", { contradicts: true, values: [{ value: "10", source: "DEC-5" }, { value: "NT$500", source: "none" }] });
    line("SCN-4", "steps[0]", { grounding: "other", actualSourceIds: ["AC-2"] });
    const outcome = judgeReview(units, sub, { attempt: 2, paths });

    expect(outcome.records.map((r) => [r.unit, r.verdicts])).toEqual([
      ["background", []],
      ["SCN-1", ["unsupported"]],
      ["SCN-2", ["underived"]],
      ["SCN-3", ["contradicts", "invented-value"]],
      ["SCN-4", ["misattributed"]],
    ]);
    expect([...outcome.flagged]).toEqual(["SCN-1", "SCN-2", "SCN-3", "SCN-4"]);
    const text = outcome.issues.map((i) => `${i.path}: ${i.errors.join(" | ")}`);
    expect(text).toEqual([
      expect.stringMatching(/^scenarios\[0\]\.steps\[2\]: states what AC-2 does not say: "Then 系統接受取消"/),
      expect.stringMatching(/^scenarios\[1\]\.steps\[2\]: does not necessarily follow from DEC-1: "Then 系統拒絕取消".*openReason/),
      expect.stringMatching(/^scenarios\[2\]\.steps\[0\]: contradicts DEC-5: "Given VIP 會員下單已 10 天"\. Correct it to agree with DEC-5 \| states NT\$500, which no item gives: write <…> for it/),
      expect.stringMatching(/^scenarios\[3\]\.steps\[0\]: comes from AC-2, not FEAT-1: correct its sourceIds/),
    ]);
    expect(outcome.records[3]).toMatchObject({ attempt: 2, findings: [{ ref: "steps[0]", verdict: "contradicts" }, { ref: "steps[0]", verdict: "invented-value", detail: "NT$500" }] });
  });

  test("a derived scenario's premise that does not follow warns that its Thens may rest on it", () => {
    const { units } = fixture();
    const sub = clean(units);
    sub.reviews.find((r) => r.unit === "SCN-2")!.lines[0]!.grounding = "none";
    const outcome = judgeReview(units, sub, { attempt: 1, paths });
    expect(outcome.records.find((r) => r.unit === "SCN-2")!.verdicts).toEqual(["underived"]);
    expect(outcome.issues).toEqual([
      { path: "scenarios[1].steps[0]", errors: [expect.stringMatching(/^does not necessarily follow from DEC-1: "Given 一般會員下單已 <天數> 天"\. It is a premise: .*every Then still follows/)] },
    ]);
  });

  test("on the last attempt flagged scenarios are kept as unverified with the reviewer's findings", () => {
    const { units, feature } = fixture();
    const sub = clean(units);
    sub.reviews[3]!.lines[0]!.contradicts = true;
    const outcome = judgeReview(units, sub, { attempt: 3, paths });
    const marked: WrittenFeature = markUnverified(feature, outcome);
    expect(marked.scenarios[2]!.unverified).toEqual([expect.stringMatching(/^review: steps\[0\] contradicts DEC-5/)]);
    expect(marked.scenarios[0]!.unverified).toBeUndefined();
  });
});

describe("reviewMemo", () => {
  test("a unit the writer did not change keeps its review and is not sent again", () => {
    const { units } = fixture();
    const memo = reviewMemo();
    expect(memo.fresh(units)).toEqual(units);
    const first = clean(units);
    first.reviews.find((r) => r.unit === "SCN-3")!.lines[0]!.contradicts = true;
    expect(memo.merge(units, first)).toEqual(first);

    expect(memo.fresh(units)).toEqual([]);
    // Nothing sent: the flagged SCN-3 keeps its finding and still goes back to the writer.
    const merged = memo.merge(units, { reviews: [] });
    expect(merged).toEqual(first);
    expect(judgeReview(units, merged, { attempt: 2, paths: new Map() }).flagged).toEqual(new Set(["SCN-3"]));
  });

  test("a changed line sends its unit again, and only that unit", () => {
    const { units } = fixture();
    const memo = reviewMemo();
    memo.merge(units, clean(units));
    const changed = units.map((u) => (u.unit === "SCN-2" ? { ...u, lines: u.lines.slice(1) } : u));
    const fresh = memo.fresh(changed);
    expect(fresh.map((u) => u.unit)).toEqual(["SCN-2"]);
    const merged = memo.merge(changed, clean(fresh));
    expect(merged.reviews.map((r) => r.unit)).toEqual(["background", "SCN-1", "SCN-2", "SCN-3", "SCN-4"]);
    expect(merged.reviews.find((r) => r.unit === "SCN-2")!.lines.map((l) => l.ref)).toEqual(changed[2]!.lines.map((l) => l.ref));
  });
});
