import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";
import type { RequirementBrief } from "../src/extract/schema.ts";
import { runExtract } from "../src/extract/stage.ts";
import { ev } from "./helpers/facts.ts";
import { ScriptedBackend, type ScriptedTurn } from "./helpers/scripted-backend.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "returns");
/** The fixture and the scripted facts are Traditional Chinese. */
const config = parseConfig({ provider: { baseUrl: "http://unused" }, outputLanguage: "zh" });

const facts = (brCancelQuote: string) => ({
  actors: [
    { id: "ACT-1", name: "會員", description: "已註冊並登入的購物者", responsibilities: ["取消訂單", "申請退貨"], evidence: [ev("prd.md", 4, "- 會員：已註冊並登入的購物者。")] },
    { id: "ACT-2", name: "客服人員", description: "處理會員退貨申請的內部人員", responsibilities: ["審核退貨"], evidence: [ev("prd.md", 5, "客服人員：處理會員退貨申請的內部人員。")] },
  ],
  features: [
    { id: "FEAT-1", name: "取消訂單", description: "會員取消訂單", actorIds: ["ACT-1"], inputs: [], outputs: ["退款"], dependsOn: [], evidence: [ev("prd.md", 9, "會員可於下單後 3 天內取消訂單。")] },
    { id: "FEAT-2", name: "申請退貨", description: "會員申請退貨", actorIds: ["ACT-1", "ACT-2"], inputs: [], outputs: [], dependsOn: [], evidence: [ev("prd.md", 14, "會員收到商品後可以在會員中心申請退貨。")] },
  ],
  businessRules: [
    { id: "BR-1", rule: "下單後 3 天內可取消", featureIds: ["FEAT-1"], conditions: ["下單後 3 天內"], evidence: [ev("prd.md", 9, "會員可於下單後 3 天內取消訂單。")] },
    { id: "BR-2", rule: "下單後 7 天內可取消", featureIds: ["FEAT-1"], conditions: [], evidence: [ev("faq.md", 4, brCancelQuote)] },
    { id: "BR-3", rule: "退貨需客服審核", featureIds: ["FEAT-2"], conditions: [], evidence: [ev("prd.md", 15, "退貨申請需經客服人員審核。")] },
  ],
  acceptanceCriteria: [{ id: "AC-1", featureId: "FEAT-1", kind: "hint", text: "取消後退款至原付款方式", evidence: [ev("prd.md", 10, "取消後應退款至原付款方式。")] }],
  nonFunctional: [
    { id: "NFR-1", category: "performance", requirement: "退貨申請頁面回應快速", metric: "頁面回應時間", target: "< 2 秒", evidence: [ev("prd.md", 22, "退貨申請頁面回應時間需小於 2 秒。")] },
  ],
  domainEntities: [],
  glossary: [{ id: "TERM-1", term: "SKU", definition: "庫存單位", aliases: [], evidence: [ev("prd.md", 19, "SKU：庫存單位，每一個商品規格對應一個 SKU。")] }],
  dependencies: [{ id: "DEP-1", name: "金流閘道", type: "external", description: "處理退款", evidence: [ev("faq.md", 7, "退款會經由金流閘道處理")] }],
  constraints: [],
  outOfScope: [{ id: "OOS-1", item: "跨境訂單退貨", evidence: [ev("prd.md", 25, "第一版不支援跨境訂單退貨。")] }],
  openQuestions: [
    { id: "OQ-1", question: "已出貨的訂單如何處理？", reason: "文件標示 TBD", relatedIds: ["FEAT-1"], severity: "blocking", evidence: [ev("prd.md", 11, "已出貨的訂單如何處理：TBD。")] },
    { id: "OQ-2", question: "退貨運費由誰負擔？", reason: "文件標示待確認", relatedIds: ["FEAT-2"], severity: "high", evidence: [ev("prd.md", 16, "退貨運費由誰負擔待確認。")] },
  ],
});

const analysis = {
  merges: [],
  contradictions: [{ conflict: "取消期限不一致：3 天 vs 7 天", relatedIds: ["BR-1", "BR-2"] }],
  openQuestions: [{ question: "鑑賞期是幾天？", reason: "faq 使用「鑑賞期」但未定義", relatedIds: ["FEAT-2"], severity: "high" }],
  assumptions: [{ assumption: "取消與退貨都需要登入", rationale: "會員定義為已登入的購物者", confidence: "medium", relatedIds: ["FEAT-1", "FEAT-2"] }],
};

function backend(factsTurns: ScriptedTurn[], analysisTurns: ScriptedTurn[] = [{ call: analysis }]) {
  return new ScriptedBackend((opts) => (opts.tool.name === "submit_facts" ? factsTurns : analysisTurns));
}

const runDir = () => mkdtempSync(join(tmpdir(), "xplan-run-"));

describe("runExtract end to end (scripted agents)", () => {
  test("extracts, retries a paraphrased quote, analyses and writes every artifact", async () => {
    const fake = backend([{ call: facts("7 天內可取消") }, { call: facts("A: 可以，下單後 7 天內都可以取消喔。") }]);
    const dir = runDir();
    const report = await runExtract({ dir: FIXTURE, runDir: dir, config, backend: async () => fake, log: () => {} });

    expect(report.failures).toEqual([]);
    expect(report.status).toBe("succeeded");
    expect(report.warnings).toEqual(["Skipped 1 unsupported file(s): notes.xlsx"]);

    const brief = JSON.parse(readFileSync(join(dir, "01-brief.json"), "utf8")) as RequirementBrief;
    expect(brief.features.map((f) => f.name)).toEqual(["取消訂單", "申請退貨"]);
    expect(brief.contradictions).toMatchObject([{ id: "CTR-1", relatedIds: ["BR-1", "BR-2"] }]);
    expect(brief.contradictions[0]!.evidence.map((e) => e.file)).toEqual(["prd.md", "faq.md"]);
    expect(brief.openQuestions.map((q) => q.id)).toEqual(["OQ-1", "OQ-2", "OQ-3"]);
    expect(brief.traceability.map((t) => t.file)).toEqual(["faq.md", "prd.md"]);

    // The retry: the paraphrased quote was fed back to the model.
    const factsSession = fake.sessions.find((s) => s.systemPrompt.includes("submit_facts"))!;
    expect(factsSession.prompts).toHaveLength(1);
    const trace = readFileSync(join(dir, "traces", "facts-bin1.md"), "utf8");
    expect(trace).toContain("submit_facts rejected");
    expect(trace).toContain('quote not found in faq.md: "7 天內可取消"');

    for (const f of ["run.json", "01-brief.md", "01-rejected.json", "sources/prd.md.txt", "prompts/facts-bin1.system.md", "prompts/facts-bin1.user.md", "prompts/analysis.user.md", "traces/facts-bin1.jsonl", "traces/analysis.md"]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    expect(run.status).toBe("succeeded");
    expect(run.agents.map((a: { label: string }) => a.label).sort()).toEqual(["analysis", "facts-bin1"]);
    expect(Object.keys(run.promptHashes)).toContain("extract/facts.system");
    expect(run.provenance["BR-2"]).toEqual({ text: "facts-bin1", evidence: ["facts-bin1"] });
    expect(run.provenance["OQ-3"]).toEqual({ text: "analysis", evidence: ["analysis"] });
    expect(Object.keys(run.provenance)).toHaveLength(Object.values(run.counts as Record<string, number>).reduce((a, b) => a + b, 0));
  });

  test("on the last attempt invalid items become Rejected Items instead of failing the run", async () => {
    const bad = facts("7 天內可取消");
    const fake = backend([{ call: bad }, { call: bad }, { call: bad }], [{ call: { ...analysis, contradictions: [] } }]);
    const report = await runExtract({ dir: FIXTURE, runDir: runDir(), config, backend: async () => fake, log: () => {} });
    expect(report.status).toBe("succeeded");
    expect(report.rejected.map((r) => [r.section, (r.item as { id: string }).id])).toEqual([["businessRules", "BR-2"]]);
    // Merge renumbers the survivors: bin1's BR-3 becomes BR-2; run.json keeps the mapping.
    expect(report.brief!.businessRules.map((b) => [b.id, b.rule])).toEqual([
      ["BR-1", "下單後 3 天內可取消"],
      ["BR-2", "退貨需客服審核"],
    ]);
  });

  test("fails the run when no features survive", async () => {
    const noFeatures = { ...facts("A: 可以，下單後 7 天內都可以取消喔。"), features: [], acceptanceCriteria: [] };
    noFeatures.businessRules = noFeatures.businessRules.map((b) => ({ ...b, featureIds: [] }));
    noFeatures.openQuestions = noFeatures.openQuestions.map((q) => ({ ...q, relatedIds: [] }));
    const fake = backend([{ call: noFeatures }], [{ call: { ...analysis, openQuestions: [], assumptions: [] } }]);
    const report = await runExtract({ dir: FIXTURE, runDir: runDir(), config, backend: async () => fake, log: () => {} });
    expect(report.status).toBe("failed");
    expect(report.failures).toEqual(["No features were extracted"]);
  });

  test("fails the run when a Facts agent never submits", async () => {
    const fake = backend([{ text: "a" }, { text: "b" }, { text: "c" }]);
    const report = await runExtract({ dir: FIXTURE, runDir: runDir(), config, backend: async () => fake, log: () => {} });
    expect(report.status).toBe("failed");
    expect(report.failures[0]).toMatch(/facts-bin1 failed \(no-submit\)/);
  });

  test("a submission in the wrong script is sent back, like any other issue", async () => {
    const good = facts("A: 可以，下單後 7 天內都可以取消喔。");
    const simplified = { ...good, businessRules: good.businessRules.map((b) => (b.id === "BR-3" ? { ...b, rule: "退货需客服审核" } : b)) };
    const analysisSimplified = { ...analysis, openQuestions: [{ ...analysis.openQuestions[0]!, question: "这个鉴赏期为几天？" }] };
    const fake = backend([{ call: simplified }, { call: good }], [{ call: analysisSimplified }, { call: analysis }]);
    const dir = runDir();
    const report = await runExtract({ dir: FIXTURE, runDir: dir, config, backend: async () => fake, log: () => {} });

    expect(report.status).toBe("succeeded");
    expect(report.warnings.filter((w) => w.includes("not written"))).toEqual([]);
    expect(readFileSync(join(dir, "traces", "facts-bin1.md"), "utf8")).toContain("not written in Traditional Chinese (繁體中文): rule");
    expect(readFileSync(join(dir, "traces", "analysis.md"), "utf8")).toContain("not written in Traditional Chinese (繁體中文): question");
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).outputLanguage).toBe("zh");
  });

  test("still in the wrong script after the last attempt: the item is kept with a warning, not rejected", async () => {
    const good = facts("A: 可以，下單後 7 天內都可以取消喔。");
    const simplified = { ...good, businessRules: good.businessRules.map((b) => (b.id === "BR-3" ? { ...b, rule: "退货需客服审核" } : b)) };
    const fake = backend([{ call: simplified }, { call: simplified }, { call: simplified }]);
    const report = await runExtract({ dir: FIXTURE, runDir: runDir(), config, backend: async () => fake, log: () => {} });

    expect(report.status).toBe("succeeded");
    expect(report.rejected).toEqual([]);
    expect(report.brief!.businessRules.map((b) => b.rule)).toContain("退货需客服审核");
    expect(report.warnings).toContainEqual(expect.stringMatching(/^facts-bin1: 1 item\(s\) still not written in Traditional Chinese.*: BR-3$/));
  });

  test("the default output language is English", async () => {
    const dir = runDir();
    await runExtract({ dir: FIXTURE, runDir: dir, config: parseConfig({ provider: { baseUrl: "http://unused" } }), dryRun: true, backend: async () => backend([]), log: () => {} });
    expect(readFileSync(join(dir, "prompts", "facts-bin1.system.md"), "utf8")).toContain("Write every field in English");
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).outputLanguage).toBe("en");
  });

  test("Reference Documents are marked in the prompts and in run.json", async () => {
    const fake = backend([{ call: facts("A: 可以，下單後 7 天內都可以取消喔。") }]);
    const dir = runDir();
    const report = await runExtract({ dir: FIXTURE, runDir: dir, config, reference: ["faq.md"], backend: async () => fake, log: () => {} });
    expect(report.status).toBe("succeeded");

    const [factsSession, analysisSession] = fake.sessions;
    expect(factsSession!.systemPrompt).toContain("### Reference documents");
    expect(factsSession!.prompts[0]).toContain('<document path="faq.md" role="reference">');
    expect(analysisSession!.systemPrompt).toContain("not requirements: `faq.md`.");
    const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    expect(run.files.filter((f: { reference?: boolean }) => f.reference).map((f: { path: string }) => f.path)).toEqual(["faq.md"]);
  });

  test("a Run needs at least one requirement document", async () => {
    await expect(
      runExtract({ dir: FIXTURE, runDir: runDir(), config, reference: ["*.md"], dryRun: true, backend: async () => backend([]), log: () => {} }),
    ).rejects.toThrow(/at least one requirement document/);
  });

  test("dry run renders prompts without creating a backend", async () => {
    const dir = runDir();
    const report = await runExtract({
      dir: FIXTURE,
      runDir: dir,
      config,
      dryRun: true,
      backend: async () => {
        throw new Error("must not be called");
      },
      log: () => {},
    });
    expect(report.status).toBe("dry-run");
    expect(readFileSync(join(dir, "prompts", "facts-bin1.user.md"), "utf8")).toContain('<document path="faq.md">');
  });
});
