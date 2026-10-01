import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { emptyFacts } from "../src/extract/merge.ts";
import type { OpenQuestion, RequirementBrief } from "../src/extract/schema.ts";
import { parseConfig } from "../src/config.ts";
import { loadExpected, type Expected } from "../src/eval/expected.ts";
import { renderReport, runEval } from "../src/eval/run-eval.ts";
import { scoreCase, scoreQuestions } from "../src/eval/score.ts";
import { actor, ev, rule } from "./helpers/facts.ts";
import { ScriptedBackend } from "./helpers/scripted-backend.ts";

const EVAL_CASES = join(import.meta.dirname, "..", "eval", "cases");

const q = (id: string, question: string): OpenQuestion => ({ id, question, reason: "r", relatedIds: [], severity: "medium", evidence: [] });

const labels: Expected = {
  expect: [],
  openQuestions: {
    mustBeRaised: [
      { id: "vip", any: ["VIP"] },
      { id: "fee", any: ["運費"] },
    ],
    shouldNotBeRaised: [
      { id: "appraisal", any: ["鑑賞期是幾天"] },
      { id: "member", any: ["會員是"] },
      { id: "sku", any: ["SKU 的定義"] },
    ],
  },
};

describe("scoreQuestions", () => {
  test("real questions raised or not, and questions the documents already answer", () => {
    const open = [q("OQ-1", "VIP 會員是什麼？"), q("OQ-2", "SKU 的定義？"), q("OQ-3", "鑑賞期是幾天？"), q("OQ-4", "折扣怎麼算？")];
    const score = scoreQuestions(labels, open);
    expect(score.raised).toEqual(["vip"]);
    expect(score.neverRaised).toEqual(["fee"]);
    // "VIP 會員是什麼？" also matches the member label, but a real question is never counted as unwanted.
    expect(score.unwanted).toEqual([
      { label: "appraisal", questions: [{ id: "OQ-3", question: "鑑賞期是幾天？" }] },
      { label: "sku", questions: [{ id: "OQ-2", question: "SKU 的定義？" }] },
    ]);
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
    );
    expect(score.recall).toEqual({ found: ["member", "3d"], missing: ["cs"] });
    expect(score.contradictions).toEqual({ found: ["window"], missing: ["other"] });
    expect(score.items).toBe(4);
  });

  test("noise: unexpected labels hit by any keyword, optionally limited to sections", () => {
    const brief: RequirementBrief = {
      ...emptyFacts(),
      actors: [actor("ACT-1", "Dealer", [ev("ref.md", 1, "vendor")])],
      businessRules: [rule("BR-1", "calls get_cpe", [])],
      contradictions: [],
      assumptions: [],
      traceability: [{ file: "ref.md", itemIds: ["ACT-1"] }],
    };
    const score = scoreCase(
      {
        expect: [],
        unexpected: [
          { id: "dealer", any: ["dealer", "reseller"] },
          { id: "endpoint-as-feature", section: "features", any: ["get_cpe"] },
          { id: "vendor", any: ["vendor"] },
        ],
      },
      brief,
    );
    // Evidence is not item text, so "vendor" in a quote does not count.
    expect(score.noise).toEqual({ hits: [{ label: "dealer", itemIds: ["ACT-1"] }], labels: 3 });
    expect(score.items).toBe(2);
  });

  test("duplicate assumptions: an assumption stating the answer to a labelled open question, matched on its statement only", () => {
    const asm = (id: string, assumption: string, rationale: string) => ({ id, assumption, rationale, confidence: "high" as const, relatedIds: [] });
    const brief: RequirementBrief = {
      ...emptyFacts(),
      contradictions: [],
      assumptions: [
        asm("ASM-1", "admyn_id is the AdminUUID value", "only tenant field"),
        asm("ASM-2", "One POST per tenant", "the body carries a single admyn_id"),
        asm("ASM-3", "dcnt counts distinct devices", "BR-2 counts devices"),
      ],
      traceability: [],
    };
    const score = scoreCase(
      {
        expect: [],
        assumptions: {
          shouldNotDuplicate: [
            { id: "admyn-id-mapping", any: ["admyn_id"] },
            { id: "count-unit", any: ["distinct", "unique device"] },
            { id: "hardware", any: ["hardware"] },
          ],
        },
      },
      brief,
    );
    // ASM-2 mentions admyn_id only in its rationale, so it is not a duplicate.
    expect(score.duplicateAssumptions).toEqual([
      { label: "admyn-id-mapping", itemIds: ["ASM-1"] },
      { label: "count-unit", itemIds: ["ASM-3"] },
    ]);
  });
});

describe("eval cases", () => {
  // Every case present, including local-only ones such as the gitignored cpe-inventory.
  test.each(readdirSync(EVAL_CASES))("%s has a valid expected.yaml and documents", (name) => {
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
    const analysis = { merges: [], contradictions: [], openQuestions: [], assumptions: [] };
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
    expect(results[0]!.score!.questions).toEqual({ raised: ["return-shipping-fee"], neverRaised: ["shipped-order", "appraisal-period"], unwanted: [] });
    expect(results[0]!.promptHashes["extract/facts.system"]).toMatch(/^[0-9a-f]{12}$/);
    const report = renderReport(results);
    expect(report).toContain("| 33% | 0 |");
    expect(report).toContain("- 未提出的真問題：shipped-order, appraisal-period");
  });
});

function emptySections() {
  const { openQuestions: _, ...rest } = emptyFacts();
  return rest;
}
