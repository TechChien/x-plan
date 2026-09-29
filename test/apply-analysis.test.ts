import { describe, expect, test } from "vitest";
import { applyAnalysis, checkAnalysis } from "../src/extract/apply-analysis.ts";
import { emptyFacts } from "../src/extract/merge.ts";
import type { AnalysisSubmission, Facts } from "../src/extract/schema.ts";
import { actor, ev, feature, rule } from "./helpers/facts.ts";

function facts(): Facts {
  return {
    ...emptyFacts(),
    actors: [actor("ACT-1", "會員", [ev("prd.md", 1, "會員")]), actor("ACT-4", "使用者", [ev("faq.md", 1, "使用者")])],
    features: [feature("FEAT-3", "取消", [ev("prd.md", 2, "取消")], ["ACT-4"])],
    businessRules: [
      rule("BR-2", "3 天", [ev("prd.md", 3, "3 天")]),
      rule("BR-3", "退款", [ev("prd.md", 4, "退款")]),
      rule("BR-7", "7 天", [ev("faq.md", 2, "7 天")]),
      rule("BR-9", "退款原路", [ev("faq.md", 3, "原路")]),
    ],
    openQuestions: [{ id: "OQ-1", question: "會員是什麼？", reason: "未定義", relatedIds: [], severity: "low", evidence: [] }],
  };
}

const ops = (partial: Partial<AnalysisSubmission>): AnalysisSubmission => ({
  merges: [],
  resolvedQuestions: [],
  contradictions: [],
  openQuestions: [],
  assumptions: [],
  ...partial,
});

describe("applyAnalysis", () => {
  test("the walkthrough example: merge, redirect, inherit evidence, add contradiction and traceability", () => {
    const { brief, rejectedOps } = applyAnalysis(
      facts(),
      ops({
        merges: [{ keepId: "ACT-1", dropIds: ["ACT-4"], reason: "同指註冊會員" }],
        contradictions: [{ conflict: "取消期限不一致", relatedIds: ["BR-2", "BR-7"] }],
      }),
    );
    expect(rejectedOps).toEqual([]);
    expect(brief.actors.map((a) => a.id)).toEqual(["ACT-1"]);
    expect(brief.actors[0]!.evidence.map((e) => e.file)).toEqual(["prd.md", "faq.md"]);
    expect(brief.features[0]!.actorIds).toEqual(["ACT-1"]);
    expect(brief.contradictions).toEqual([
      { id: "CTR-1", conflict: "取消期限不一致", relatedIds: ["BR-2", "BR-7"], evidence: [ev("prd.md", 3, "3 天"), ev("faq.md", 2, "7 天")] },
    ]);
    expect(brief.traceability.find((t) => t.file === "faq.md")!.itemIds).toEqual(["ACT-1", "BR-7", "BR-9", "CTR-1"]);
  });

  test("a merge redirect that leaves two distinct ids is a valid contradiction", () => {
    const { brief, rejectedOps } = applyAnalysis(
      facts(),
      ops({ merges: [{ keepId: "BR-3", dropIds: ["BR-9"], reason: "同一規則" }], contradictions: [{ conflict: "c", relatedIds: ["BR-2", "BR-9"] }] }),
    );
    expect(rejectedOps).toEqual([]);
    expect(brief.contradictions[0]!.relatedIds).toEqual(["BR-2", "BR-3"]);
  });

  test("resolved questions are removed; new questions and assumptions get fresh ids", () => {
    const { brief } = applyAnalysis(
      facts(),
      ops({
        resolvedQuestions: [{ questionId: "OQ-1", answeredByIds: ["ACT-1"], reason: "ACT-1 已定義" }],
        openQuestions: [{ question: "已出貨可否取消？", reason: "未說明", relatedIds: ["FEAT-3"], severity: "blocking" }],
        assumptions: [{ assumption: "需登入", rationale: "會員功能", confidence: "medium", relatedIds: ["FEAT-3"] }],
      }),
    );
    expect(brief.openQuestions.map((q) => q.id)).toEqual(["OQ-2"]);
    expect(brief.assumptions.map((a) => a.id)).toEqual(["ASM-1"]);
  });
});

describe("checkAnalysis: Q30 illegal operations", () => {
  const errorsOf = (o: AnalysisSubmission) => checkAnalysis(facts(), o).issues.map((i) => `${i.op}: ${i.errors.join(" | ")}`);

  test("merging across sections", () => {
    expect(errorsOf(ops({ merges: [{ keepId: "ACT-1", dropIds: ["BR-2"], reason: "" }] }))).toEqual([
      'merges[0]: "BR-2" (businessRules) and keepId "ACT-1" (actors) are in different sections',
    ]);
  });

  test("an id dropped by two merges", () => {
    const errors = errorsOf(
      ops({
        merges: [
          { keepId: "BR-2", dropIds: ["BR-7"], reason: "" },
          { keepId: "BR-3", dropIds: ["BR-7"], reason: "" },
        ],
      }),
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/appears in dropIds of more than one merge/);
  });

  test("merge chains", () => {
    const errors = errorsOf(
      ops({
        merges: [
          { keepId: "BR-2", dropIds: ["BR-3"], reason: "" },
          { keepId: "BR-3", dropIds: ["BR-9"], reason: "" },
        ],
      }),
    );
    expect(errors.join("\n")).toMatch(/merge chains are not allowed/);
  });

  test("case 4: declared duplicates and in conflict at once", () => {
    expect(
      errorsOf(ops({ merges: [{ keepId: "BR-2", dropIds: ["BR-7"], reason: "" }], contradictions: [{ conflict: "c", relatedIds: ["BR-2", "BR-7"] }] })),
    ).toEqual([
      "contradictions[0]: after merges these ids are the same item (merges[0]); an item cannot contradict itself. Either they are duplicates (keep the merge) or they conflict (remove the merge)",
    ]);
  });

  test("unknown ids anywhere", () => {
    expect(errorsOf(ops({ assumptions: [{ assumption: "a", rationale: "r", confidence: "low", relatedIds: ["FEAT-99"] }] }))).toEqual([
      'assumptions[0]: "FEAT-99" does not exist',
    ]);
  });

  test("applyAnalysis skips invalid operations and reports them", () => {
    const { brief, rejectedOps } = applyAnalysis(
      facts(),
      ops({
        merges: [
          { keepId: "ACT-1", dropIds: ["BR-2"], reason: "" },
          { keepId: "ACT-1", dropIds: ["ACT-4"], reason: "" },
        ],
      }),
    );
    expect(rejectedOps.map((r) => r.op)).toEqual(["merges[0]"]);
    expect(brief.businessRules.map((b) => b.id)).toContain("BR-2");
    expect(brief.actors.map((a) => a.id)).toEqual(["ACT-1"]);
  });
});
