import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";
import { languageErrors } from "../src/extract/language.ts";
import { buildAnalysisPrompt, buildFactsSystemPrompt } from "../src/extract/prompts.ts";
import { emptyFacts } from "../src/extract/merge.ts";
import { checkLanguage, mergeIssues } from "../src/extract/validate.ts";
import { PromptLibrary } from "../src/prompts/template.ts";

describe("languageErrors", () => {
  test("en: any CJK outside evidence, ids and glossary terms is wrong", () => {
    expect(languageErrors({ id: "OQ-1", question: "此回報何時觸發？", reason: "No schedule is stated." }, "en")).toEqual(["not written in English: question"]);
    expect(languageErrors({ id: "BR-1", rule: "Cancel within 3 days.", evidence: [{ file: "prd.md", quote: "下單後 3 天內可取消" }] }, "en")).toEqual([]);
    expect(languageErrors({ id: "TERM-1", term: "鑑賞期", aliases: ["鑑賞"], definition: "The 7 days after delivery." }, "en")).toEqual([]);
    expect(languageErrors({ id: "ENT-1", name: "Order", relationships: [{ targetId: "ENT-2", kind: "屬於" }] }, "en")).toEqual(["not written in English: relationships"]);
  });

  test("zh: Simplified-only characters, or a prose field left in English, are wrong", () => {
    expect(languageErrors({ id: "BR-1", rule: "退貨需客服審核" }, "zh")).toEqual([]);
    expect(languageErrors({ id: "BR-1", rule: "退货需客服审核" }, "zh")).toEqual(["not written in Traditional Chinese (繁體中文): rule"]);
    expect(languageErrors({ id: "OQ-1", question: "Who pays the return shipping fee when an order is cancelled?" }, "zh")).toHaveLength(1);
    // Identifiers and short technical strings stay as they are.
    expect(languageErrors({ id: "DEP-1", name: "CVE service", description: "POST /api/v1/inventory/collect" }, "zh")).toEqual([]);
  });

  test("cn: Traditional-only characters are wrong", () => {
    expect(languageErrors({ id: "BR-1", rule: "退货需客服审核" }, "cn")).toEqual([]);
    expect(languageErrors({ id: "BR-1", rule: "退貨需客服審核" }, "cn")).toEqual(["not written in Simplified Chinese (简体中文): rule"]);
  });

  test("characters shared by both scripts are never flagged", () => {
    for (const lang of ["zh", "cn"] as const) expect(languageErrors({ id: "BR-1", rule: "后台面板里准范并余" }, lang)).toEqual([]);
  });
});

describe("checkLanguage", () => {
  test("reports items by section and index, and merges with other issues of the same item", () => {
    const facts = { ...emptyFacts(), openQuestions: [{ id: "OQ-1", question: "何時觸發？", reason: "r", relatedIds: [], severity: "low" as const, evidence: [] }] };
    const issues = checkLanguage(facts, "en");
    expect(issues).toEqual([{ section: "openQuestions", index: 0, id: "OQ-1", errors: ["not written in English: question"] }]);
    const merged = mergeIssues([{ section: "openQuestions", index: 0, id: "OQ-1", errors: ["evidence[0]: quote not found"] }], issues);
    expect(merged).toEqual([{ section: "openQuestions", index: 0, id: "OQ-1", errors: ["evidence[0]: quote not found", "not written in English: question"] }]);
  });
});

describe("output language in prompts and config", () => {
  test("the prompts name the output language; English by default", () => {
    const lib = new PromptLibrary();
    expect(buildFactsSystemPrompt(lib, ["actors"])).toContain("Write every field in English");
    expect(buildFactsSystemPrompt(lib, ["actors"], { language: "zh" })).toContain("Write every field in Traditional Chinese (繁體中文)");
    expect(buildAnalysisPrompt(lib, emptyFacts(), [], "cn").systemPrompt).toContain("Write every field in Simplified Chinese (简体中文)");
  });

  test("config accepts en, zh and cn only", () => {
    expect(parseConfig({ provider: { baseUrl: "x" }, outputLanguage: "cn" }).outputLanguage).toBe("cn");
    expect(() => parseConfig({ provider: { baseUrl: "x" }, outputLanguage: "ja" })).toThrow(/outputLanguage/);
  });
});
