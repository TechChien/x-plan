import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { emptyFacts } from "../src/extract/merge.ts";
import { buildAnalysisPrompt, buildFactsPrompt, buildFactsSystemPrompt } from "../src/extract/prompts.ts";
import { FACT_SECTION_NAMES } from "../src/extract/schema.ts";
import { BUNDLED_PROMPTS_DIR, parseTemplate, PromptLibrary } from "../src/prompts/template.ts";
import { packBins, splitSource } from "../src/source/binning.ts";
import { actor, ev, rule } from "./helpers/facts.ts";

const SIX_SECTIONS = ["Role", "Input Contract", "Allowed Actions", "Process", "Output Contract", "Failure Conditions"];

const lib = () => new PromptLibrary();
const headings = (text: string) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

function templateFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? templateFiles(path) : name.endsWith(".md") && name !== "README.md" ? [path] : [];
  });
}

const sources = [
  { path: "docs/prd.md", converted: false, text: "# 退貨\n會員可於下單後 3 天內取消訂單。\nSKU：庫存單位\n價格為 {{price}}" },
  { path: "docs/faq.md", converted: false, text: "Q: 可以取消嗎？\nA: 7 天內都可以取消喔。" },
];

describe("every stage's templates", () => {
  const files = templateFiles(BUNDLED_PROMPTS_DIR!).map((f) => relative(BUNDLED_PROMPTS_DIR!, f).split("\\").join("/"));

  test.each(files.filter((f) => f.endsWith(".system.md")))("%s has the six sections in order", (file) => {
    const { body } = parseTemplate(readFileSync(join(BUNDLED_PROMPTS_DIR!, file), "utf8").replace(/\r\n/g, "\n"), file);
    expect(headings(body)).toEqual(SIX_SECTIONS);
  });

  test.each(files.filter((f) => /\.(system|user|turn)\.md$/.test(f)))("%s declares its variables in front-matter", (file) => {
    const text = readFileSync(join(BUNDLED_PROMPTS_DIR!, file), "utf8").replace(/\r\n/g, "\n");
    expect(text.startsWith("---\nvariables:")).toBe(true);
  });

  test("a section fragment exists for every fact section plus the analysis sections", () => {
    for (const s of [...FACT_SECTION_NAMES, "openQuestions", "contradictions", "assumptions"]) {
      expect(files).toContain(`shared/sections/${s}.md`);
    }
  });
});

/** Fits the larger document whole, but not both together. */
const oneFileBudget = Math.max(...sources.map((s) => splitSource(s, Infinity)[0]!.tokens));

describe("buildFactsPrompt", () => {
  const bins = packBins(sources, 100_000);
  const allFiles = sources.map((s) => s.path);

  test("snapshot", () => {
    const prompt = buildFactsPrompt(lib(), { bin: bins[0]!, totalBins: 1, allFiles, sections: FACT_SECTION_NAMES });
    expect(prompt.systemPrompt).toMatchSnapshot("system");
    expect(prompt.userMessage).toMatchSnapshot("user");
  });

  test("the system prompt is identical for every bin (prefix caching)", () => {
    const small = packBins(sources, oneFileBudget);
    expect(small.length).toBe(2);
    const prompts = small.map((bin) => buildFactsPrompt(lib(), { bin, totalBins: 2, allFiles, sections: FACT_SECTION_NAMES }));
    expect(prompts[0]!.systemPrompt).toBe(prompts[1]!.systemPrompt);
    expect(prompts[0]!.userMessage).not.toBe(prompts[1]!.userMessage);
  });

  test("the section list controls which definitions appear", () => {
    const system = buildFactsSystemPrompt(lib(), ["actors"]);
    expect(system).toContain("#### actors");
    expect(system).not.toContain("#### businessRules");
    expect(system).toContain("#### openQuestions");
  });

  test("documents carry original line numbers; placeholders inside documents stay literal", () => {
    const { userMessage } = buildFactsPrompt(lib(), { bin: bins[0]!, totalBins: 1, allFiles, sections: ["actors"] });
    expect(userMessage).toContain('<document path="docs/prd.md">\nL1: # 退貨\nL2: 會員可於下單後 3 天內取消訂單。');
    expect(userMessage).toContain("L4: 價格為 {{price}}");
    expect(userMessage).toContain("You are seeing ALL source documents");
  });

  test("a partial batch lists what the agent cannot see", () => {
    const small = packBins(sources, oneFileBudget);
    const { userMessage } = buildFactsPrompt(lib(), { bin: small[1]!, totalBins: 2, allFiles, sections: ["actors"] });
    expect(userMessage).toMatch(/You are seeing batch 2 of 2/);
    expect(userMessage).toMatch(/Documents you cannot see: docs\/(prd|faq)\.md/);
    expect(userMessage).toMatch(/Do NOT raise open questions/);
  });
});

describe("buildAnalysisPrompt", () => {
  test("snapshot: facts as YAML with file and quote, without line numbers", () => {
    const facts = {
      ...emptyFacts(),
      actors: [actor("ACT-1", "會員", [ev("docs/prd.md", 2, "會員可於下單後 3 天內取消訂單。")])],
      businessRules: [rule("BR-1", "下單後 3 天內可取消", [ev("docs/prd.md", 2, "會員可於下單後 3 天內取消訂單。")]), rule("BR-2", "7 天內可取消", [ev("docs/faq.md", 2, "A: 7 天內都可以取消喔。")])],
    };
    const prompt = buildAnalysisPrompt(lib(), facts);
    expect(prompt.userMessage).not.toMatch(/lineStart/);
    expect(prompt.systemPrompt).toMatchSnapshot("system");
    expect(prompt.userMessage).toMatchSnapshot("user");
  });
});
