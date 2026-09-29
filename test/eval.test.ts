import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AnalysisLog } from "../src/extract/apply-analysis.ts";
import { emptyFacts } from "../src/extract/merge.ts";
import type { OpenQuestion, RequirementBrief } from "../src/extract/schema.ts";
import { parseConfig } from "../src/config.ts";
import { loadExpected, type Expected } from "../src/eval/expected.ts";
import { renderReport, runEval } from "../src/eval/run-eval.ts";
import { scoreCase, scoreResolution } from "../src/eval/score.ts";
import { actor, ev, rule } from "./helpers/facts.ts";
import { ScriptedBackend } from "./helpers/scripted-backend.ts";

const EVAL_CASES = join(import.meta.dirname, "..", "eval", "cases");

const q = (id: string, question: string): OpenQuestion => ({ id, question, reason: "r", relatedIds: [], severity: "medium", evidence: [] });
const resolvedLog = (...questions: OpenQuestion[]): AnalysisLog => ({
  merged: [],
  resolved: questions.map((question) => ({ questionId: question.id, answeredByIds: ["TERM-1"], reason: "defined", question })),
});

const labels: Expected = {
  expect: [],
  openQuestions: {
    mustRemainOpen: [
      { id: "vip", any: ["VIP"] },
      { id: "fee", any: ["運費"] },
    ],
    shouldBeResolved: [
      { id: "appraisal", any: ["鑑賞期"] },
      { id: "member", any: ["會員是"] },
      { id: "sku", any: ["SKU"] },
    ],
  },
};

describe("scoreResolution", () => {
  test("classifies every resolution against the labels, counterfactually", () => {
    const open = [q("OQ-2", "VIP 會員是什麼？"), q("OQ-3", "SKU 的定義？")];
    const log = resolvedLog(q("OQ-1", "鑑賞期是幾天？"), q("OQ-4", "退貨運費誰付？"), q("OQ-5", "折扣怎麼算？"));
    const score = scoreResolution(labels, open, log);
    expect(score.beneficial.map((b) => b.label)).toEqual(["appraisal"]);
    expect(score.harmful.map((h) => h.label)).toEqual(["fee"]);
    expect(score.unlabeled.map((u) => u.id)).toEqual(["OQ-5"]);
    expect(score.missed.map((m) => m.label)).toEqual(["sku"]);
    // "VIP 會員是什麼？" matches the member label too, but a mustRemainOpen match takes precedence.
    expect(score.notRaised).toEqual(["member"]);
    expect(score.realOpen).toEqual({ kept: ["vip"], wronglyResolved: ["fee"], neverRaised: [] });
  });
});

describe("scoreCase", () => {
  test("recall by keywords in the given sections, and contradictions by both sides", () => {
    const brief: RequirementBrief = {
      ...emptyFacts(),
      actors: [actor("ACT-1", "會員", [])],
      businessRules: [rule("BR-1", "下單後 3 天內可取消", [ev("a.md", 1, "x")]), rule("BR-2", "7 天內可取消", [ev("b.md", 1, "y")])],
      contradictions: [{ id: "CTR-1", conflict: "期限不一致", relatedIds: ["BR-1", "BR-2"], evidence: [] }],
      assumptions: [],
      traceability: [],
    };
    const score = scoreCase(
      {
        expect: [
          { id: "member", section: "actors", all: ["會員"] },
          { id: "3d", section: ["features", "businessRules"], all: ["3 天", "取消"] },
          { id: "cs", section: "actors", all: ["客服"] },
        ],
        contradictions: [
          { id: "window", between: [["3 天"], ["7 天"]] },
          { id: "other", between: [["3 天"], ["30 天"]] },
        ],
      },
      brief,
      { merged: [], resolved: [] },
    );
    expect(score.recall).toEqual({ found: ["member", "3d"], missing: ["cs"] });
    expect(score.contradictions).toEqual({ found: ["window"], missing: ["other"] });
  });
});

describe("eval cases", () => {
  test.each(["returns", "glossary-split"])("%s has a valid expected.yaml and documents", (name) => {
    const expected = loadExpected(join(EVAL_CASES, name, "expected.yaml"));
    expect(expected.expect.length).toBeGreaterThan(0);
    expect(existsSync(join(EVAL_CASES, name, "docs"))).toBe(true);
  });
});

describe("runEval", () => {
  test("runs a case with scripted agents, scores it and renders a report", async () => {
    const facts = {
      actors: [{ id: "ACT-1", name: "會員", description: "購物者", responsibilities: [], evidence: [ev("prd.md", 4, "- 會員：已註冊並登入的購物者。")] }],
      features: [{ id: "FEAT-1", name: "取消訂單", description: "取消", actorIds: ["ACT-1"], inputs: [], outputs: [], dependsOn: [], evidence: [ev("prd.md", 9, "會員可於下單後 3 天內取消訂單。")] }],
      openQuestions: [{ id: "OQ-1", question: "退貨運費誰負擔？", reason: "待確認", relatedIds: [], severity: "high", evidence: [ev("prd.md", 16, "退貨運費由誰負擔待確認。")] }],
    };
    const analysis = { merges: [], resolvedQuestions: [{ questionId: "OQ-1", answeredByIds: ["ACT-1"], reason: "wrong on purpose" }], contradictions: [], openQuestions: [], assumptions: [] };
    const backend = new ScriptedBackend((o) => (o.tool.name === "submit_facts" ? [{ call: { ...emptySections(), ...facts } }] : [{ call: analysis }]));
    const outDir = mkdtempSync(join(tmpdir(), "xplan-eval-"));

    const results = await runEval({
      cases: [{ name: "returns", dir: join(EVAL_CASES, "returns") }],
      outDir,
      repeat: 1,
      config: parseConfig({ provider: { baseUrl: "http://unused" } }),
      backend: async () => backend,
      log: () => {},
    });

    expect(results[0]!.status).toBe("succeeded");
    expect(results[0]!.score!.resolution.harmful.map((h) => h.label)).toEqual(["return-shipping-fee"]);
    expect(results[0]!.promptHashes["extract/facts.system"]).toMatch(/^[0-9a-f]{12}$/);
    const report = renderReport(results);
    expect(report).toContain("| 誤刪真問題 | 1 |");
    expect(report).toContain("⚠ 誤刪真問題 [return-shipping-fee]");
    expect(readFileSync(join(results[0]!.runDir, "01-analysis-log.json"), "utf8")).toContain("退貨運費誰負擔？");
  });
});

function emptySections() {
  const { openQuestions: _, ...rest } = emptyFacts();
  return rest;
}
