import type { AlignedBrief, AlignedDecision } from "../../src/clarify/aligned.ts";
import type { RequirementBrief } from "../../src/extract/schema.ts";
import { coverageSets } from "../../src/write/coverage.ts";
import { applyOutline, checkOutline } from "../../src/write/outline.ts";
import type { FeatureSubmission, OutlineScenario, OutlineSubmission, Step, WriteOutline, WrittenFeature } from "../../src/write/schema.ts";
import { checkFeature } from "../../src/write/writer.ts";
import { returnsBrief } from "./brief.ts";
import { actor, ev, rule } from "./facts.ts";

// The category union is built with map(), so TypeScript cannot narrow a literal to it.
type NonFunctional = RequirementBrief["nonFunctional"][number];

export const alignedDec = (id: string, extra: Partial<AlignedDecision> = {}): AlignedDecision => ({
  id,
  round: 1,
  status: "active",
  answerRef: `R1/${id}`,
  resolves: ["OQ-1"],
  conclusion: `結論 ${id}`,
  supersedes: [],
  confirms: [],
  revises: [],
  relatedIds: [],
  effect: "new",
  answerText: `回答 ${id}`,
  ...extra,
});

/**
 * The returns Brief after Clarify: BR-1 (3 days) replaced by DEC-1, DEC-2 revised by DEC-5, ASM-2 confirmed by DEC-3,
 * DEC-4 a definition, TERM-1 replaced by DEC-6; OQ-1 deferred and OQ-4 unresolved.
 */
export function alignedFixture(): AlignedBrief {
  const brief = returnsBrief();
  brief.actors.push(actor("ACT-1", "會員", [ev("prd.md", 3, "會員可以下單。")]));
  brief.businessRules.push(rule("BR-3", "到貨 7 天內可退貨", [ev("prd.md", 15, "到貨 7 天內可退貨。")], ["FEAT-2"]));
  brief.acceptanceCriteria.push(
    { id: "AC-1", featureId: "FEAT-2", kind: "example", text: "到貨第 2 天申請退貨，系統接受", evidence: [ev("prd.md", 16, "例如到貨第 2 天申請，系統接受。")] },
    { id: "AC-2", featureId: "FEAT-1", kind: "scenario", text: "下單當天取消成功", evidence: [ev("prd.md", 10, "下單當天可取消。")] },
  );
  brief.glossary.push({ id: "TERM-1", term: "鑑賞期", definition: "收到商品後 3 天", aliases: [], evidence: [ev("prd.md", 20, "鑑賞期為收到商品後 3 天。")] });
  brief.nonFunctional.push({ id: "NFR-1", category: "performance", requirement: "退貨申請 2 秒內回應", target: "2s", evidence: [ev("prd.md", 30, "2 秒內回應。")] } as unknown as NonFunctional);
  return {
    outputLanguage: "zh",
    termination: "done",
    brief,
    supersededBy: { "BR-1": ["DEC-1"], "TERM-1": ["DEC-6"] },
    confirmedBy: { "ASM-2": ["DEC-3"] },
    decisions: [
      alignedDec("DEC-1", { conclusion: "一般會員 7 天內可取消", supersedes: ["BR-1"], effect: "replace", resolves: ["CTR-1"] }),
      alignedDec("DEC-2", { status: "revised", revisedBy: "DEC-5", conclusion: "VIP 14 天", effect: "reconcile", resolves: ["CTR-1"] }),
      alignedDec("DEC-3", { conclusion: "退款原路退回", confirms: ["ASM-2"], effect: "confirm", resolves: ["OQ-2"] }),
      alignedDec("DEC-4", { conclusion: "鑑賞期即 7 天退貨期", relatedIds: ["FEAT-2"], resolves: ["OQ-3"] }),
      alignedDec("DEC-5", { conclusion: "VIP 10 天內可取消", revises: ["DEC-2"], resolves: ["NOTE-1"] }),
      alignedDec("DEC-6", { conclusion: "鑑賞期是到貨後 7 天", supersedes: ["TERM-1"], effect: "replace", resolves: ["OQ-3"] }),
    ],
    agenda: [
      { id: "OQ-1", kind: "OQ", origin: "brief", status: "deferred", question: "已出貨的訂單如何處理？", relatedIds: ["FEAT-1"], answers: [] },
      { id: "OQ-4", kind: "OQ", origin: "brief", status: "unresolved", question: "退貨頁面要顯示什麼？", relatedIds: ["FEAT-2"], answers: [] },
    ],
  };
}

export const scn = (title: string, kind: OutlineScenario["kind"], sourceIds: string[], extra: Partial<OutlineScenario> = {}): OutlineScenario => ({
  title,
  kind,
  sourceIds,
  agendaIds: [],
  ...extra,
});

/** Covers everything the fixture requires: FEAT-1/2, BR-2/3, AC-1/2, DEC-1/5/6, with DEC-4 marked not behavioural. */
export function validOutline(): OutlineSubmission {
  return {
    features: [
      {
        featureId: "FEAT-1",
        rules: [
          {
            sourceId: "DEC-1",
            title: "一般會員 7 天內可取消",
            scenarios: [scn("下單當天取消", "specified", ["AC-2", "BR-2"]), scn("下單第 8 天取消被拒", "derived", [])],
          },
          { sourceId: "DEC-5", title: "VIP 10 天內可取消", scenarios: [scn("VIP 第 10 天取消", "specified", [])] },
        ],
        scenarios: [scn("已出貨的訂單取消", "deferred", ["FEAT-1"], { agendaIds: ["OQ-1"] })],
      },
      {
        featureId: "FEAT-2",
        rules: [{ sourceId: "BR-3", title: "鑑賞期內可退貨", scenarios: [scn("到貨第 2 天申請退貨", "specified", ["AC-1", "DEC-6"])] }],
        scenarios: [scn("退貨頁面的內容", "open", ["FEAT-2"], { agendaIds: ["OQ-4"] }), scn("退貨申請的回應時間", "specified", ["NFR-1"])],
      },
    ],
    notBehavioral: [{ id: "DEC-4", reason: "只是名詞定義" }],
  };
}

/** `validOutline()` accepted and numbered: FEAT-1 holds SCN-1 to SCN-4, FEAT-2 holds SCN-5 to SCN-7. */
export function outlineFixture(aligned = alignedFixture()): WriteOutline {
  const sets = coverageSets(aligned);
  const result = checkOutline(validOutline(), { aligned, sets, isLast: false, language: "zh" });
  if (result.issues.length) throw new Error(JSON.stringify(result.issues));
  return applyOutline(result.accepted, aligned, result.uncovered);
}

export const step = (keyword: Step["keyword"], text: string, sourceIds: string[]): Step => ({ keyword, text, sourceIds });

/** FEAT-1: SCN-1 specified (AC-2, BR-2, DEC-1), SCN-2 derived (DEC-1), SCN-3 specified (DEC-5), SCN-4 deferred (OQ-1). */
export function validFeature(): FeatureSubmission {
  return {
    description: "會員可以取消訂單",
    background: [step("Given", "會員已登入", ["ACT-1"])],
    scenarios: [
      { id: "SCN-1", steps: [step("Given", "會員在下單當天", ["AC-2"]), step("When", "會員取消訂單", ["FEAT-1"]), step("Then", "系統接受取消", ["AC-2"])], examples: [] },
      {
        id: "SCN-2",
        steps: [step("Given", "一般會員下單已 <天數> 天", ["DEC-1"]), step("When", "會員取消訂單", ["FEAT-1"]), step("Then", "系統拒絕取消", ["DEC-1"])],
        examples: [{ name: "邊界", derived: true, header: ["天數"], rows: [{ cells: ["8"], sourceIds: ["DEC-1"] }] }],
      },
      { id: "SCN-3", steps: [step("Given", "VIP 會員下單已 10 天", ["DEC-5"]), step("When", "會員取消訂單", ["FEAT-1"]), step("Then", "系統接受取消", ["DEC-5"])], examples: [] },
      { id: "SCN-4", steps: [step("Given", "訂單已出貨", ["FEAT-1"]), step("When", "會員取消訂單", ["FEAT-1"])], examples: [] },
    ],
  };
}

/** `validFeature()` accepted for FEAT-1; FEAT-2 has no writer result. */
export function writtenFixture(aligned = alignedFixture(), outline = outlineFixture(aligned)): Map<string, WrittenFeature> {
  const result = checkFeature(validFeature(), { aligned, sets: coverageSets(aligned), outline, featureId: "FEAT-1", isLast: false, language: "zh" });
  if (result.issues.length) throw new Error(JSON.stringify(result.issues));
  return new Map([["FEAT-1", result.accepted]]);
}
