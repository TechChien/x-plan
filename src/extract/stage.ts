import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { SubmitTask, TaskMetrics, TaskOutcome } from "../agent/submit-task.ts";
import type { AgentBackend } from "../agent/types.ts";
import { thinkingFor, type XPlanConfig } from "../config.ts";
import { PromptLibrary, sha256 } from "../prompts/template.ts";
import { computeBudget, estimateTokens, packBins, type Bin, type Packing } from "../source/binning.ts";
import { convertFile, type SourceText } from "../source/convert.ts";
import { scanDirectory } from "../source/scan.ts";
import { applyAnalysis, checkAnalysis, type OpIssue } from "./apply-analysis.ts";
import { SourceIndex } from "./evidence.ts";
import { LANGUAGE_NAMES, languageErrors, type OutputLanguage } from "../shared/language.ts";
import { mergeFacts } from "./merge.ts";
import { buildProvenance } from "./provenance.ts";
import { savePrompt, writeJson, writeText, type BuiltPrompt } from "../shared/run-files.ts";
import { buildNudge, runTraced, validationFeedback } from "../shared/traced.ts";
import { runTelemetry, traceRun } from "../telemetry/run-trace.ts";
import { endSpan, startSpan } from "../telemetry/spans.ts";
import { buildAnalysisPrompt, buildFactsPrompt, buildFactsSystemPrompt } from "./prompts.ts";
import { renderBriefMarkdown } from "./render.ts";
import {
  AnalysisSubmissionSchema,
  FACT_SECTION_NAMES,
  factsSubmissionSchema,
  type AnalysisSubmission,
  type FactSectionName,
  type Facts,
  type RejectedItem,
  type RequirementBrief,
} from "./schema.ts";
import { checkFacts, checkLanguage, dropInvalid, formatIssues, mergeIssues } from "./validate.ts";

/** Submit calls per agent: the first plus two retries (Q17). */
export const MAX_SUBMIT_ATTEMPTS = 3;
export const MAX_NUDGES = 2;
/** More rejected than this fraction of all submitted items fails the Run (Q19). */
export const MAX_REJECTED_RATIO = 0.3;

export interface ExtractOptions {
  dir: string;
  runDir: string;
  config: XPlanConfig;
  include?: string[];
  exclude?: string[];
  /** Globs marking Reference Documents: supporting material extracted only where the requirement documents need it. */
  reference?: string[];
  /** Overrides `config.outputLanguage`; English when neither is set. */
  outputLanguage?: OutputLanguage;
  sections?: FactSectionName[];
  dryRun?: boolean;
  /** How documents are grouped into batches; evals use "per-file" to force several batches. */
  packing?: Packing;
  /** Created on demand so a dry run needs no API key. */
  backend: () => Promise<AgentBackend>;
  log: (message: string) => void;
}

export interface ExtractReport {
  status: "succeeded" | "failed" | "dry-run";
  failures: string[];
  warnings: string[];
  runDir: string;
  brief?: RequirementBrief;
  rejected: RejectedItem[];
}

interface AgentRecord {
  label: string;
  status: TaskOutcome<unknown>["status"];
  reason?: string;
  metrics: TaskMetrics;
}

/** Runs Extract as one trace (ADR 0013); without telemetry the span is a no-op. */
export function runExtract(opts: ExtractOptions): Promise<ExtractReport> {
  return traceRun({ stage: "extract", runId: basename(opts.runDir), attributes: { "xplan.dry_run": Boolean(opts.dryRun) } }, () => extract(opts));
}

async function extract(opts: ExtractOptions): Promise<ExtractReport> {
  const { config, runDir, log } = opts;
  const sections = opts.sections ?? FACT_SECTION_NAMES;
  const warnings: string[] = [];
  const failures: string[] = [];
  const agents: AgentRecord[] = [];
  const rejected: RejectedItem[] = [];
  mkdirSync(runDir, { recursive: true });

  // Scan and convert.
  const prepare = startSpan("extract.prepare", {});
  const scan = await scanDirectory(opts.dir, { include: opts.include, exclude: opts.exclude, reference: opts.reference });
  if (!scan.files.length) throw new Error(`No supported documents (.md .txt .pdf .docx) found in ${opts.dir}`);
  if (scan.reference.length === scan.files.length) throw new Error("Every document is a Reference Document; at least one requirement document is needed");
  if (scan.skipped.length) warnings.push(`Skipped ${scan.skipped.length} unsupported file(s): ${scan.skipped.join(", ")}`);
  if (opts.reference?.length && !scan.reference.length) warnings.push(`No document matched the reference globs: ${opts.reference.join(", ")}`);
  const reference = new Set(scan.reference);
  log(
    `Found ${scan.files.length} document(s)${reference.size ? ` (${reference.size} reference)` : ""}${scan.skipped.length ? `, skipped ${scan.skipped.length}` : ""}`,
  );

  const sources: SourceText[] = [];
  for (const file of scan.files) {
    const source = await convertFile(opts.dir, file);
    sources.push(source);
    writeText(join(runDir, "sources", `${file}.txt`), source.text);
  }

  // Pack into bins.
  const lib = new PromptLibrary(config.promptsDir);
  const hasReferences = reference.size > 0;
  const language = opts.outputLanguage ?? config.outputLanguage ?? "en";
  /** Items still in the wrong language after the last attempt are kept: their content is valid. */
  const warnLanguage = (label: string, where: string[]) =>
    warnings.push(`${label}: ${where.length} item(s) still not written in ${LANGUAGE_NAMES[language]} after the last attempt, kept: ${where.join(", ")}`);
  const factsSystem = buildFactsSystemPrompt(lib, sections, { hasReferences, language });
  const budget = computeBudget({
    contextWindow: config.provider.contextWindow,
    maxOutputTokens: config.provider.maxOutputTokens,
    systemPromptTokens: estimateTokens(factsSystem),
  });
  const bins = packBins(sources, budget, opts.packing, reference);
  const allFiles = sources.map((s) => s.path);
  log(`Packed into ${bins.length} batch(es) (budget ${budget} tokens each)`);
  const blind = bins.filter((b) => b.segments.every((s) => s.reference) && !b.context?.length).map((b) => b.index);
  if (blind.length) {
    warnings.push(`Batch(es) ${blind.join(", ")} hold only Reference Documents without the requirement documents (too large to repeat); relevance cannot be judged there`);
  }

  prepare.setAttributes({ "xplan.files": sources.length, "xplan.reference_files": reference.size, "xplan.bins": bins.length, "xplan.budget_tokens": budget });
  endSpan(prepare);

  const factsPrompts = bins.map((bin) => buildFactsPrompt(lib, { bin, totalBins: bins.length, allFiles, sections, hasReferences, language }));
  bins.forEach((bin, i) => savePrompt(runDir, `facts-bin${bin.index}`, factsPrompts[i] as BuiltPrompt));

  const writeRun = (status: ExtractReport["status"], extra: Record<string, unknown> = {}) =>
    writeJson(join(runDir, "run.json"), {
      status,
      createdAt: new Date().toISOString(),
      stage: "extract",
      source: { kind: "documents", dir: opts.dir },
      inputDir: opts.dir,
      files: sources.map((s) => ({
        path: s.path,
        ...(reference.has(s.path) ? { reference: true } : {}),
        converted: s.converted,
        sha256: sha256(s.text),
        text: `sources/${s.path}.txt`,
      })),
      skipped: scan.skipped,
      model: config.provider.model,
      thinking: thinkingFor(config, "extract"),
      outputLanguage: language,
      sections,
      promptHashes: lib.hashes(),
      budget,
      packing: opts.packing ?? "auto",
      bins: bins.map(binSummary),
      agents,
      warnings,
      failures,
      ...extra,
      ...withTelemetry(),
    });

  if (opts.dryRun) {
    writeRun("dry-run");
    log(`Dry run: rendered prompts written to ${join(runDir, "prompts")}`);
    return { status: "dry-run", failures, warnings, runDir, rejected };
  }

  // Facts (map).
  const backend = await opts.backend();
  const index = new SourceIndex(sources);
  const thinking = thinkingFor(config, "extract");
  const traceDir = join(runDir, "traces");
  let relocated = 0;

  const factsResults = await mapLimit(bins, config.concurrency ?? 2, async (bin, i) => {
    const label = `facts-bin${bin.index}`;
    log(`[${label}] extracting ${bin.segments.length} segment(s), ~${bin.tokens} tokens`);
    const allowedFiles = new Set(bin.segments.map((s) => s.path));
    const task: SubmitTask<Partial<Facts>, { facts: Partial<Facts>; dropped: RejectedItem[] }> = {
      label,
      ...(factsPrompts[i] as BuiltPrompt),
      nudge: buildNudge(lib, "submit_facts"),
      thinking,
      maxSubmitAttempts: MAX_SUBMIT_ATTEMPTS,
      maxNudges: MAX_NUDGES,
      tool: {
        name: "submit_facts",
        description: "Submit the complete extracted facts. Call exactly once; call again with the complete corrected result if errors are returned.",
        parameters: factsSubmissionSchema(sections),
        check: (params, { isLast }) => {
          const result = checkFacts(params, { index, allowedFiles });
          const wrongLanguage = checkLanguage(result.facts, language);
          if (!isLast && (result.issues.length || wrongLanguage.length)) {
            const all = mergeIssues(result.issues, wrongLanguage);
            return { retry: validationFeedback(lib, "submit_facts", formatIssues(all), all.length) };
          }
          if (wrongLanguage.length) warnLanguage(label, wrongLanguage.map((i) => i.id ?? `${i.section}[${i.index}]`));
          if (!result.issues.length) {
            relocated += result.relocated;
            return { accept: { facts: result.facts, dropped: [] } };
          }
          relocated += result.relocated;
          const { facts, dropped } = dropInvalid(result.facts, result.issues);
          return { accept: { facts, dropped: dropped.map((d) => ({ ...d, stage: "facts" as const, bin: bin.index })) } };
        },
      },
    };
    const outcome = await runTraced(backend, task, traceDir);
    agents.push({ label, status: outcome.status, reason: outcome.status === "failed" ? outcome.reason : undefined, metrics: outcome.metrics });
    return outcome;
  });

  const perBin: Partial<Facts>[] = [];
  factsResults.forEach((outcome, i) => {
    if (outcome.status === "failed") failures.push(`facts-bin${bins[i]!.index} failed (${outcome.reason}): ${outcome.message}`);
    else {
      perBin.push(outcome.value.facts);
      rejected.push(...outcome.value.dropped);
    }
  });
  if (relocated) warnings.push(`Corrected line numbers of ${relocated} evidence quote(s)`);
  if (failures.length) {
    writeRun("failed");
    return { status: "failed", failures, warnings, runDir, rejected };
  }

  // Merge.
  const mergeSpan = startSpan("extract.merge", {});
  const merged = mergeFacts(perBin);
  mergeSpan.setAttributes({ "xplan.items": countItems(merged.facts), "xplan.deduped": merged.deduped.size });
  endSpan(mergeSpan);
  const idMaps = Object.fromEntries(merged.idMaps.map((map, i) => [`facts-bin${bins[i]!.index}`, Object.fromEntries(map)]));
  const submittedItems = countItems(merged.facts) + merged.deduped.size + rejected.length;
  log(`Merged: ${countItems(merged.facts)} item(s), ${merged.deduped.size} exact-name duplicate(s) folded`);

  // Analysis (reduce).
  const analysisPrompt = buildAnalysisPrompt(lib, merged.facts, scan.reference, language);
  savePrompt(runDir, "analysis", analysisPrompt);
  const analysisTokens = estimateTokens(analysisPrompt.systemPrompt) + estimateTokens(analysisPrompt.userMessage);
  if (analysisTokens > config.provider.contextWindow - config.provider.maxOutputTokens) {
    failures.push(`Merged facts (~${analysisTokens} tokens) do not fit in one Analysis call; the input is too large`);
    writeRun("failed", { idMaps });
    return { status: "failed", failures, warnings, runDir, rejected };
  }

  log(`[analysis] reviewing merged facts, ~${analysisTokens} tokens`);
  const analysisOutcome = await runTraced<AnalysisSubmission, AnalysisSubmission>(
    backend,
    {
      label: "analysis",
      ...analysisPrompt,
      nudge: buildNudge(lib, "submit_analysis"),
      thinking,
      maxSubmitAttempts: MAX_SUBMIT_ATTEMPTS,
      maxNudges: MAX_NUDGES,
      tool: {
        name: "submit_analysis",
        description: "Submit merges, contradictions, new open questions and assumptions. Call exactly once.",
        parameters: AnalysisSubmissionSchema,
        check: (params: AnalysisSubmission, { isLast }) => {
          const { issues } = checkAnalysis(merged.facts, params);
          const wrongLanguage = checkAnalysisLanguage(params, language);
          const all = [...issues, ...wrongLanguage];
          if (all.length && !isLast) return { retry: validationFeedback(lib, "submit_analysis", formatOpIssues(all), all.length) };
          if (wrongLanguage.length) warnLanguage("analysis", wrongLanguage.map((i) => i.op));
          return { accept: params };
        },
      },
    },
    traceDir,
  );
  agents.push({
    label: "analysis",
    status: analysisOutcome.status,
    reason: analysisOutcome.status === "failed" ? analysisOutcome.reason : undefined,
    metrics: analysisOutcome.metrics,
  });
  if (analysisOutcome.status === "failed") {
    failures.push(`analysis failed (${analysisOutcome.reason}): ${analysisOutcome.message}`);
    writeRun("failed");
    return { status: "failed", failures, warnings, runDir, rejected };
  }

  const { brief, rejectedOps, log: analysisLog } = applyAnalysis(merged.facts, analysisOutcome.value);
  rejected.push(...rejectedOps.map((op) => ({ section: op.op, item: pickOp(analysisOutcome.value, op.op), errors: op.errors, stage: "analysis" as const })));

  // Run-level thresholds (Q19).
  if (!brief.features.length) failures.push("No features were extracted");
  const totalItems = submittedItems + countOps(analysisOutcome.value);
  if (totalItems && rejected.length / totalItems > MAX_REJECTED_RATIO) {
    failures.push(`${rejected.length} of ${totalItems} items were rejected (> ${MAX_REJECTED_RATIO * 100}%)`);
  }

  writeJson(join(runDir, "01-brief.json"), brief);
  writeJson(join(runDir, "01-rejected.json"), rejected);
  writeJson(join(runDir, "01-analysis-log.json"), analysisLog);
  writeText(join(runDir, "01-brief.md"), renderBriefMarkdown(brief, rejected, analysisLog));
  const status = failures.length ? "failed" : "succeeded";
  const deduped = Object.fromEntries(merged.deduped);
  const provenance = buildProvenance({ idMaps, deduped, merges: analysisLog.merged, brief, analysisLabel: "analysis" });
  writeRun(status, { counts: countBySection(brief), rejectedCount: rejected.length, idMaps, deduped, provenance });
  return { status, failures, warnings, runDir, brief, rejected };
}



/** Language of the items Analysis adds to the Brief; merge and resolution reasons only reach the log. */
function checkAnalysisLanguage(ops: AnalysisSubmission, lang: OutputLanguage): OpIssue[] {
  return (["contradictions", "openQuestions", "assumptions"] as const).flatMap((kind) =>
    (ops[kind] as unknown[]).flatMap((item, i) => {
      const errors = languageErrors(item, lang);
      return errors.length ? [{ op: `${kind}[${i}]`, errors }] : [];
    }),
  );
}

function formatOpIssues(issues: OpIssue[]): string {
  return issues.map((i) => `- ${i.op}:\n${i.errors.map((e) => `    - ${e}`).join("\n")}`).join("\n");
}

function pickOp(ops: AnalysisSubmission, path: string): unknown {
  const match = /^(\w+)\[(\d+)\]$/.exec(path);
  return match ? (ops as unknown as Record<string, unknown[]>)[match[1] as string]?.[Number(match[2])] : undefined;
}

function countItems(facts: Partial<Facts>): number {
  return Object.values(facts).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
}

function countOps(ops: AnalysisSubmission): number {
  return Object.values(ops).reduce((n, list) => n + list.length, 0);
}

function countBySection(brief: RequirementBrief): Record<string, number> {
  return Object.fromEntries(Object.entries(brief).filter(([k]) => k !== "traceability").map(([k, v]) => [k, (v as unknown[]).length]));
}

function withTelemetry(): { telemetry?: ReturnType<typeof runTelemetry> } {
  const telemetry = runTelemetry();
  return telemetry ? { telemetry } : {};
}

function binSummary(bin: Bin) {
  return {
    index: bin.index,
    tokens: bin.tokens,
    segments: bin.segments.map((s) => ({
      path: s.path,
      lines: `${s.lineStart}-${s.lineEnd}`,
      ...(s.part ? { part: `${s.part.index}/${s.part.total}` } : {}),
      ...(s.reference ? { reference: true } : {}),
    })),
    ...(bin.context?.length ? { context: bin.context.map((s) => s.path) } : {}),
  };
}




async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

