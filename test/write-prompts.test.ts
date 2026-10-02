import { describe, expect, test } from "vitest";
import { PromptLibrary } from "../src/prompts/template.ts";
import { coverageSets } from "../src/write/coverage.ts";
import { buildOutlinePrompt, buildReviewPrompt, buildVocabularyPrompt, buildWriterPrompt } from "../src/write/prompts.ts";
import { underReview } from "../src/write/review.ts";
import { alignedFixture, outlineFixture, writtenFixture } from "./helpers/write.ts";

const lib = () => new PromptLibrary();

function fixture() {
  const aligned = alignedFixture();
  const sets = coverageSets(aligned);
  const outline = outlineFixture(aligned);
  return { aligned, sets, outline, written: writtenFixture(aligned, outline) };
}

const block = (message: string, tag: string) => message.slice(message.indexOf(`<${tag}>`), message.indexOf(`</${tag}>`));

describe("buildOutlinePrompt", () => {
  test("snapshot", () => {
    const { aligned, sets } = fixture();
    const prompt = buildOutlinePrompt(lib(), aligned, sets);
    expect(prompt.systemPrompt).toMatchSnapshot("system");
    expect(prompt.userMessage).toMatchSnapshot("user");
  });

  test("marks what was replaced, shows only confirmed Assumptions and active Decisions, and lists open questions", () => {
    const { aligned, sets } = fixture();
    const aligned_ = block(buildOutlinePrompt(lib(), aligned, sets).userMessage, "aligned");
    expect(aligned_).toMatch(/- id: BR-1\n(?:.*\n)*?\s+replacedBy:\n\s+- DEC-1/);
    expect(aligned_).toMatch(/- id: ASM-2\n(?:.*\n)*?\s+confirmedBy:\n\s+- DEC-3/);
    expect(aligned_).not.toContain("id: ASM-1");
    expect(aligned_).not.toContain("id: DEC-2");
    expect(aligned_).toMatch(/openItems:\n\s+- id: OQ-1\n\s+status: deferred/);
  });

  test("the coverage block says what to cite instead of each forbidden id", () => {
    const { aligned, sets } = fixture();
    const coverage = block(buildOutlinePrompt(lib(), aligned, sets).userMessage, "coverage");
    expect(coverage).toContain("BR-1: BR-1 was replaced by DEC-1; cite DEC-1 instead");
    expect(coverage).toContain("DEC-6: redefines 鑑賞期, which DEC-4 uses");
  });
});

describe("buildWriterPrompt", () => {
  test("snapshot", () => {
    const { aligned, sets, outline } = fixture();
    const prompt = buildWriterPrompt(lib(), aligned, sets, outline, "FEAT-1");
    expect(prompt.systemPrompt).toMatchSnapshot("system");
    expect(prompt.userMessage).toMatchSnapshot("user");
  });

  test("every writer's message is the same up to the end of <context> (prefix cache)", () => {
    const { aligned, sets, outline } = fixture();
    const [a, b] = ["FEAT-1", "FEAT-2"].map((id) => buildWriterPrompt(lib(), aligned, sets, outline, id).userMessage);
    const stable = a!.slice(0, a!.indexOf("</context>") + "</context>".length);
    expect(b!.startsWith(stable)).toBe(true);
    expect(a).not.toBe(b);
  });

  test("<sources> holds the items this Feature's scenarios stand on and leave open, nothing forbidden or from another Feature", () => {
    const { aligned, sets, outline } = fixture();
    const sources = block(buildWriterPrompt(lib(), aligned, sets, outline, "FEAT-1").userMessage, "sources");
    const ids = [...sources.matchAll(/^- id: (\S+)/gm)].map((m) => m[1]);
    expect(ids).toEqual(["FEAT-1", "BR-2", "AC-2", "DEC-1", "DEC-5", "OQ-1"]);
    for (const forbidden of ["BR-1", "TERM-1", "ASM-1", "DEC-2", "BR-3", "AC-1"]) expect(sources).not.toContain(`id: ${forbidden}`);
  });

  test("<context> shows a redefined Term as the Decision that redefined it", () => {
    const { aligned, sets, outline } = fixture();
    const context = block(buildWriterPrompt(lib(), aligned, sets, outline, "FEAT-1").userMessage, "context");
    expect(context).toMatch(/- id: DEC-6\n\s+conclusion: 鑑賞期是到貨後 7 天\n(?:.*\n)*?\s+replaces:\n\s+- TERM-1/);
    expect(context).not.toContain("收到商品後 3 天");
  });

  test("an existing vocabulary goes after <context>, keeping the shared prefix", () => {
    const { aligned, sets, outline } = fixture();
    const plain = buildWriterPrompt(lib(), aligned, sets, outline, "FEAT-1").userMessage;
    const withVocabulary = buildWriterPrompt(lib(), aligned, sets, outline, "FEAT-1", {
      vocabulary: [{ canonical: "會員", definition: "註冊的購買者", avoid: ["使用者"], sourceIds: ["ACT-1"] }],
    }).userMessage;
    const end = plain.indexOf("</context>") + "</context>".length;
    expect(withVocabulary.slice(0, end)).toBe(plain.slice(0, end));
    expect(withVocabulary).toContain("</context>\n\n<vocabulary>\n- canonical: 會員\n  definition: 註冊的購買者\n  avoid:\n    - 使用者\n</vocabulary>\n\n<feature>");
    expect(plain).toContain("</context>\n\n<feature>");
  });
});

describe("buildReviewPrompt", () => {
  test("snapshot", () => {
    const { aligned, outline, written } = fixture();
    const units = underReview(written.get("FEAT-1")!, outline).filter((u) => u.unit === "SCN-2");
    const prompt = buildReviewPrompt(lib(), aligned, units);
    expect(prompt.systemPrompt).toMatchSnapshot("system");
    expect(prompt.userMessage).toMatchSnapshot("user");
  });
});

describe("buildVocabularyPrompt", () => {
  test("snapshot", () => {
    const { aligned, outline, written } = fixture();
    const prompt = buildVocabularyPrompt(lib(), aligned, outline, written);
    expect(prompt.systemPrompt).toMatchSnapshot("system");
    expect(prompt.userMessage).toMatchSnapshot("user");
  });

  test("names show a redefined Term with its Decision; existing entries come before the text", () => {
    const { aligned, outline, written } = fixture();
    const message = buildVocabularyPrompt(lib(), aligned, outline, written, { existing: [{ canonical: "會員", definition: "d", avoid: [], sourceIds: [] }] }).userMessage;
    expect(block(message, "names")).toMatch(/- id: TERM-1\n(?:.*\n)*?\s+redefinedBy:\n\s+- id: DEC-6\n\s+conclusion: 鑑賞期是到貨後 7 天/);
    expect(message).toMatch(/<\/decisions>\n\n<existing>\n- canonical: 會員[\s\S]*<\/existing>\n\n<text>/);
    expect(block(message, "text")).toContain("SCN-1/step/1: 會員取消訂單");
  });
});
