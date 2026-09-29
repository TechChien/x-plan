import { stringify } from "yaml";
import type { PromptLibrary } from "../prompts/template.ts";
import type { Bin, Segment } from "../source/binning.ts";
import { ITEM_SECTIONS } from "./merge.ts";
import type { Evidence, FactSectionName, Facts } from "./schema.ts";
import { itemsOf } from "./validate.ts";

export interface BuiltPrompt {
  systemPrompt: string;
  userMessage: string;
}

export const ANALYSIS_SECTIONS = ["contradictions", "openQuestions", "assumptions"] as const;

/** Concatenates `shared/sections/<name>.md` in the given order. */
export function sectionDefinitions(lib: PromptLibrary, sections: readonly string[]): string {
  return sections.map((s) => lib.read(`shared/sections/${s}`).trim()).join("\n\n");
}

/** Identical for every bin of a Run, so the provider can reuse its prefix cache across Facts agents. */
export function buildFactsSystemPrompt(lib: PromptLibrary, sections: FactSectionName[]): string {
  return lib.render("extract/facts.system", { sectionDefinitions: sectionDefinitions(lib, sections) });
}

export interface FactsPromptInput {
  bin: Bin;
  totalBins: number;
  /** Every Source Document path in the Run. */
  allFiles: string[];
  sections: FactSectionName[];
}

export function buildFactsPrompt(lib: PromptLibrary, input: FactsPromptInput): BuiltPrompt {
  return {
    systemPrompt: buildFactsSystemPrompt(lib, input.sections),
    userMessage: lib.render("extract/facts.user", {
      binInfo: formatBinInfo(input.bin, input.totalBins, input.allFiles),
      documents: formatDocuments(input.bin.segments),
    }),
  };
}

export function formatBinInfo(bin: Bin, totalBins: number, allFiles: string[]): string {
  const seen = new Set(bin.segments.map((s) => s.path));
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
  return lines.join("\n");
}

export function formatDocuments(segments: Segment[]): string {
  return segments
    .map((s) => {
      const part = s.part ? ` part="${s.part.index}/${s.part.total}"` : "";
      const body = s.lines.map((line, i) => `L${s.lineStart + i}: ${line}`).join("\n");
      return `<document path="${s.path}"${part}>\n${body}\n</document>`;
    })
    .join("\n\n");
}

export function buildAnalysisPrompt(lib: PromptLibrary, facts: Facts): BuiltPrompt {
  return {
    systemPrompt: lib.render("extract/analysis.system", { sectionDefinitions: sectionDefinitions(lib, ANALYSIS_SECTIONS) }),
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

export function buildNudge(lib: PromptLibrary, toolName: string): string {
  return lib.render("shared/nudge-submit", { toolName }).trim();
}
