import { stringify } from "yaml";
import type { PromptLibrary } from "../prompts/template.ts";
import type { BuiltPrompt } from "../shared/run-files.ts";
import type { Bin, Segment } from "../source/binning.ts";
import { ITEM_SECTIONS } from "./merge.ts";
import { LANGUAGE_NAMES, type OutputLanguage } from "../shared/language.ts";
import type { Evidence, FactSectionName, Facts } from "./schema.ts";
import { itemsOf } from "./validate.ts";


export const ANALYSIS_SECTIONS = ["contradictions", "openQuestions", "assumptions"] as const;

/** Concatenates `shared/sections/<name>.md` in the given order. */
export function sectionDefinitions(lib: PromptLibrary, sections: readonly string[]): string {
  return sections.map((s) => lib.read(`shared/sections/${s}`).trim()).join("\n\n");
}

export interface RunPromptOptions {
  /** Whether the Run has any Reference Document. */
  hasReferences?: boolean;
  /** Default "en". */
  language?: OutputLanguage;
}

/**
 * Identical for every bin of a Run, so the provider can reuse its prefix cache across Facts agents.
 * The reference rules appear only in Runs with Reference Documents, so other Runs keep their prompt unchanged.
 */
export function buildFactsSystemPrompt(lib: PromptLibrary, sections: FactSectionName[], opts: RunPromptOptions = {}): string {
  return lib.render("extract/facts.system", {
    sectionDefinitions: sectionDefinitions(lib, sections),
    referenceRules: opts.hasReferences ? optionalBlock(lib.render("extract/facts.reference", {})) : "",
    outputLanguage: LANGUAGE_NAMES[opts.language ?? "en"],
  });
}

export interface FactsPromptInput extends RunPromptOptions {
  bin: Bin;
  totalBins: number;
  /** Every Source Document path in the Run. */
  allFiles: string[];
  sections: FactSectionName[];
}

export function buildFactsPrompt(lib: PromptLibrary, input: FactsPromptInput): BuiltPrompt {
  return {
    systemPrompt: buildFactsSystemPrompt(lib, input.sections, input),
    userMessage: lib.render("extract/facts.user", {
      binInfo: formatBinInfo(input.bin, input.totalBins, input.allFiles),
      documents: formatDocuments(input.bin.segments, input.bin.context),
    }),
  };
}

/** A block placed on its own line between paragraphs; an empty value leaves the template text as it was. */
function optionalBlock(text: string): string {
  return `\n${text.trim()}\n`;
}

export function formatBinInfo(bin: Bin, totalBins: number, allFiles: string[]): string {
  const seen = new Set([...bin.segments, ...(bin.context ?? [])].map((s) => s.path));
  const partial = bin.segments.filter((s) => s.part);
  const lines: string[] = [];
  if (totalBins === 1 && partial.length === 0) {
    lines.push(`You are seeing ALL source documents (batch 1 of 1).`);
  } else {
    lines.push(`You are seeing batch ${bin.index} of ${totalBins}. Other batches are analysed separately.`);
    const unseen = allFiles.filter((f) => !seen.has(f));
    if (unseen.length) lines.push(`Documents you cannot see: ${unseen.join(", ")}`);
    for (const s of partial) {
      lines.push(`You see only part ${s.part!.index} of ${s.part!.total} of ${s.path} (lines ${s.lineStart}-${s.lineEnd}).`);
    }
    lines.push(`Do NOT raise open questions about information that may be in documents or parts you cannot see.`);
  }
  if (bin.context?.length) {
    lines.push(`Documents with role="context" are extracted in another batch: use them only to judge relevance. Never extract from them or cite them.`);
  }
  return lines.join("\n");
}

/** Context first, then the bin's own segments. Requirement documents carry no role attribute. */
export function formatDocuments(segments: Segment[], context: Segment[] = []): string {
  const format = (s: Segment, role?: "context" | "reference") => {
    const part = s.part ? ` part="${s.part.index}/${s.part.total}"` : "";
    const roleAttr = role ? ` role="${role}"` : "";
    const body = s.lines.map((line, i) => `L${s.lineStart + i}: ${line}`).join("\n");
    return `<document path="${s.path}"${part}${roleAttr}>\n${body}\n</document>`;
  };
  return [...context.map((s) => format(s, "context")), ...segments.map((s) => format(s, s.reference ? "reference" : undefined))].join("\n\n");
}

export function buildAnalysisPrompt(lib: PromptLibrary, facts: Facts, referenceFiles: string[] = [], language: OutputLanguage = "en"): BuiltPrompt {
  const files = referenceFiles.map((f) => `\`${f}\``).join(", ");
  const referenceRules = referenceFiles.length ? optionalBlock(lib.render("extract/analysis.reference", { files })) : "";
  return {
    systemPrompt: lib.render("extract/analysis.system", {
      sectionDefinitions: sectionDefinitions(lib, ANALYSIS_SECTIONS),
      referenceRules,
      outputLanguage: LANGUAGE_NAMES[language],
    }),
    userMessage: lib.render("extract/analysis.user", { facts: factsToYaml(facts) }),
  };
}

/** Facts as YAML for the Analysis agent. Evidence keeps file and quote; line numbers are dropped to save tokens. */
export function factsToYaml(facts: Facts): string {
  const view: Record<string, unknown[]> = {};
  for (const section of ITEM_SECTIONS) {
    const items = itemsOf(facts, section);
    if (!items.length) continue;
    view[section] = items.map(({ evidence, ...rest }) => ({
      ...rest,
      ...(evidence?.length ? { evidence: evidence.map((e: Evidence) => ({ file: e.file, quote: e.quote })) } : {}),
    }));
  }
  return stringify(view, { lineWidth: 0 }).trimEnd();
}

