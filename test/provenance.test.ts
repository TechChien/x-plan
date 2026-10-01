import { describe, expect, test } from "vitest";
import { applyAnalysis } from "../src/extract/apply-analysis.ts";
import { mergeFacts } from "../src/extract/merge.ts";
import { buildProvenance } from "../src/extract/provenance.ts";
import { actor, ev, feature, rule } from "./helpers/facts.ts";

const oq = (id: string, question: string, file: string) => ({ id, question, reason: "TBD", relatedIds: [], severity: "high" as const, evidence: [ev(file, 9, question)] });

/** Bin 1 and bin 2 both name 會員; Analysis folds bin 2's rule into bin 1's and adds an OQ, a CTR and an ASM. */
function extract() {
  const labels = ["facts-bin1", "facts-bin2"];
  const merged = mergeFacts([
    {
      actors: [actor("ACT-1", "會員", [ev("a.md", 1, "會員")])],
      features: [feature("FEAT-1", "取消", [ev("a.md", 2, "取消")], ["ACT-1"])],
      businessRules: [rule("BR-1", "3 天內可取消", [ev("a.md", 3, "3 天")], ["FEAT-1"])],
      openQuestions: [oq("OQ-1", "已出貨怎麼辦？", "a.md")],
    },
    {
      actors: [actor("ACT-1", "會員", [ev("b.md", 1, "會員")]), actor("ACT-2", "客服", [ev("b.md", 2, "客服")])],
      businessRules: [rule("BR-1", "三天內可以取消", [ev("b.md", 3, "三天")])],
    },
  ]);
  const { brief, log } = applyAnalysis(merged.facts, {
    merges: [{ keepId: "BR-1", dropIds: ["BR-2"], reason: "same rule" }],
    contradictions: [{ conflict: "x", relatedIds: ["FEAT-1", "ACT-3"] }],
    openQuestions: [{ question: "鑑賞期幾天？", reason: "未定義", relatedIds: [], severity: "high" }],
    assumptions: [{ assumption: "需登入", rationale: "會員", confidence: "medium", relatedIds: [] }],
  });
  const idMaps = Object.fromEntries(merged.idMaps.map((map, i) => [labels[i]!, Object.fromEntries(map)]));
  return buildProvenance({ idMaps, deduped: Object.fromEntries(merged.deduped), merges: log.merged, brief, analysisLabel: "analysis" });
}

describe("buildProvenance", () => {
  test("an item from one bin has that bin as its only source", () => {
    expect(extract()["FEAT-1"]).toEqual({ text: "facts-bin1", evidence: ["facts-bin1"] });
    expect(extract()["ACT-3"]).toEqual({ text: "facts-bin2", evidence: ["facts-bin2"] });
  });

  test("an exact-name duplicate keeps the first bin's text and every bin's evidence", () => {
    expect(extract()["ACT-1"]).toEqual({ text: "facts-bin1", evidence: ["facts-bin1", "facts-bin2"], mergedBy: ["dedup"] });
  });

  test("an Analysis merge keeps the kept item's text and adds the dropped item's sources", () => {
    expect(extract()["BR-1"]).toEqual({ text: "facts-bin1", evidence: ["facts-bin1", "facts-bin2"], mergedBy: ["analysis"] });
  });

  test("a bin's own open question stays with the bin; what Analysis adds belongs to Analysis", () => {
    const p = extract();
    expect(p["OQ-1"]).toEqual({ text: "facts-bin1", evidence: ["facts-bin1"] });
    expect(p["OQ-2"]).toEqual({ text: "analysis", evidence: ["analysis"] });
    expect(p["CTR-1"]).toEqual({ text: "analysis", evidence: ["analysis"] });
    expect(p["ASM-1"]).toEqual({ text: "analysis", evidence: ["analysis"] });
  });

  test("only ids in the final Brief are listed", () => {
    expect(Object.keys(extract()).sort()).toEqual(["ACT-1", "ACT-3", "ASM-1", "BR-1", "CTR-1", "FEAT-1", "OQ-1", "OQ-2"]);
  });
});
