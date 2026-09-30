import { emptyFacts } from "../../src/extract/merge.ts";
import type { RequirementBrief } from "../../src/extract/schema.ts";
import { ev, feature, rule } from "./facts.ts";

/** A small returns-and-cancellation Brief with one open question of each severity, a contradiction and an assumption. */
export function returnsBrief(): RequirementBrief {
  return {
    ...emptyFacts(),
    features: [feature("FEAT-1", "取消訂單", [ev("prd.md", 9, "會員可於下單後 3 天內取消訂單。")]), feature("FEAT-2", "申請退貨", [ev("prd.md", 14, "會員可以申請退貨。")])],
    businessRules: [
      rule("BR-1", "下單後 3 天內可取消", [ev("prd.md", 9, "會員可於下單後 3 天內取消訂單。")], ["FEAT-1"]),
      rule("BR-2", "下單後 7 天內可取消", [ev("faq.md", 4, "7 天內都可以取消喔。")], ["FEAT-1"]),
    ],
    openQuestions: [
      { id: "OQ-1", question: "已出貨的訂單如何處理？", reason: "TBD", relatedIds: ["FEAT-1"], severity: "blocking", evidence: [] },
      { id: "OQ-2", question: "退貨運費由誰負擔？", reason: "待確認", relatedIds: ["FEAT-2"], severity: "high", evidence: [] },
      { id: "OQ-3", question: "鑑賞期是幾天？", reason: "未定義", relatedIds: ["FEAT-2"], severity: "medium", evidence: [] },
      { id: "OQ-4", question: "退貨頁面要顯示什麼？", reason: "未描述", relatedIds: ["FEAT-2"], severity: "low", evidence: [] },
    ],
    contradictions: [{ id: "CTR-1", conflict: "取消期限 3 天與 7 天不一致", relatedIds: ["BR-1", "BR-2"], evidence: [] }],
    assumptions: [
      { id: "ASM-1", assumption: "取消與退貨都需要登入", rationale: "會員為已登入者", confidence: "medium", relatedIds: ["FEAT-1", "FEAT-2"] },
      { id: "ASM-2", assumption: "退款一律原路退回", rationale: "未說明", confidence: "low", relatedIds: ["FEAT-1"] },
    ],
    traceability: [],
  };
}
