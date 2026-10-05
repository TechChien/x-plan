import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { TaskMetrics, TaskOutcome } from "../agent/submit-task.ts";
import type { AgentBackend } from "../agent/types.ts";
import type { AlignedBrief } from "../clarify/aligned.ts";
import { formatRoundIssues } from "../clarify/check.ts";
import { thinkingFor, thinkingForWriteRole, type XPlanConfig } from "../config.ts";
import { PromptLibrary, sha256 } from "../prompts/template.ts";
import { LANGUAGE_NAMES, type OutputLanguage } from "../shared/language.ts";
import { savePrompt, writeJson, writeText } from "../shared/run-files.ts";
import { readRunMeta, type RunMeta, type RunSource } from "../shared/runs.ts";
import { buildNudge, runTraced, validationFeedback } from "../shared/traced.ts";
import { linksTo, runTelemetry, traceRun } from "../telemetry/run-trace.ts";
import { failSpan, inSpan } from "../telemetry/spans.ts";
import { coverageSets } from "./coverage.ts";
import { applyOutline, checkOutline, type OutlineCheckResult, type OutlineRejected } from "./outline.ts";
import { buildOutlinePrompt, buildReviewPrompt, buildWriterPrompt } from "./prompts.ts";
import { buildTrace, duplicateScenarios, gherkinErrors, renderFeature, renderSpec } from "./render.ts";
import { judgeReview, markUnverified, reviewErrors, reviewMemo, ReviewSubmissionSchema, underReview, type ReviewSubmission, type ReviewUnit, type ScenarioReviewRecord } from "./review.ts";
import { FeatureSubmissionSchema, OutlineSubmissionSchema, type FeatureSubmission, type OutlineSubmission, type WriteOutline, type WrittenFeature } from "./schema.ts";
import { checkFeature, type FeatureIssue, type FeatureRejected } from "./writer.ts";

/** Submit calls per agent: the first plus two retries, as in Extract and Clarify. */
export const MAX_SUBMIT_ATTEMPTS = 3;
export const MAX_NUDGES = 2;

export interface WriteOptions {
  /** This Write Run's directory: a new Run starts there, or `only` rewrites Features of the Run there. */
  runDir: string;
  /** The Clarify Run a new Write Run starts from (ADR 0010). */
  sourceRunDir?: string;
  /** Rewrites these Features of an existing Write Run, keeping its outline and SCN ids. */
  only?: string[];
  /** Start from a Clarify Run whose status is not succeeded. */
  allowFailedClarify?: boolean;
  config: XPlanConfig;
  /** Overrides the language the Aligned Brief was written in. */
  outputLanguage?: OutputLanguage;
  backend: () => Promise<AgentBackend>;
  log: (message: string) => void;
  now?: () => Date;
}

export interface WriteReport {
  status: "succeeded" | "failed";
  failures: string[];
  warnings: string[];
  runDir: string;
  /** Features whose writer failed, and scenarios rendered `@unwritten`. */
  unwritten: string[];
}

interface AgentRecord {
  label: string;
  status: TaskOutcome<unknown>["status"];
  reason?: string;
  metrics: TaskMetrics;
  /** Share of input tokens served from the provider's prefix cache. */
  cacheReadRatio: number;
}

/** Each Feature's state in `run.json`: which batch wrote it, and what it still lacks. */
interface FeatureRecord {
  status: "written" | "failed";
  /** `initial`, or `only-<time>` for a rewrite. */
  batch: string;
  /** SCN ids rendered `@unwritten`. */
  unwritten: string[];
  reason?: string;
}

/** `03-written.json`: the writers' results, which a rewrite with `--only` builds on. */
interface WrittenFile {
  features: Record<string, WrittenFeature>;
  reviews: Record<string, ScenarioReviewRecord[]>;
  rejected: Record<string, FeatureRejected[]>;
}

type UpstreamRun = Extract<RunSource, { kind: "run" }>;
type WriteRunMeta = RunMeta & { agents?: AgentRecord[]; features?: Record<string, FeatureRecord>; warnings?: string[] };

/** Runs this process's part of a Write Run as one trace (ADR 0013), linked to the Clarify Run it reads. */
export function runWrite(opts: WriteOptions): Promise<WriteReport> {
  const existing = readRunMeta(opts.runDir);
  const upstreamDir = existing?.source?.kind === "run" ? existing.source.runDir : opts.sourceRunDir;
  const upstream = upstreamDir ? readRunMeta(upstreamDir) : undefined;
  return traceRun(
    {
      stage: "write",
      runId: basename(opts.runDir),
      links: [...linksTo(existing?.telemetry, "resumes"), ...linksTo(upstream?.telemetry, "upstream", "last")],
      attributes: { "xplan.rewrite": Boolean(opts.only?.length), ...(upstreamDir ? { "xplan.source.run_id": basename(upstreamDir) } : {}) },
    },
    () => write(opts),
  );
}

async function write(opts: WriteOptions): Promise<WriteReport> {
  const { config, runDir, log } = opts;
  const now = opts.now ?? (() => new Date());
  const runPath = join(runDir, "run.json");
  const rewriting = Boolean(opts.only?.length);
  /** Which batch wrote a Feature; a rewrite's labels carry it, so its prompts and traces sit beside the first batch's. */
  const batch = rewriting ? `only-${compactTime(now())}` : "initial";
  const labelSuffix = rewriting ? `-${batch}` : "";

  // Which Clarify Run this Write Run reads (ADR 0010).
  const existing = readRunMeta(runDir) as WriteRunMeta | undefined;
  const warnings: string[] = [...(existing?.warnings ?? [])];
  let source: UpstreamRun;
  let createdAt: string;
  if (existing) {
    if (existing.stage !== "write") throw new Error(`${runDir} is a ${existing.stage} Run, not a Write Run`);
    if (!rewriting) throw new Error(`${runDir} is already a Write Run; to rewrite Features in it, pass --only <FEAT-id...>`);
    if (existing.source?.kind !== "run") throw new Error(`${runPath} does not record the Clarify Run it was written from`);
    source = existing.source;
    createdAt = existing.createdAt ?? now().toISOString();
  } else {
    if (rewriting) throw new Error(`${runDir} is not a Write Run; --only rewrites Features of an existing Write Run`);
    if (!opts.sourceRunDir) throw new Error(`${runDir} is not a Write Run; to start one, give the Clarify Run to write from`);
    const upstreamDir = resolve(opts.sourceRunDir);
    const upstream = readRunMeta(upstreamDir);
    if (upstream?.stage !== "clarify") throw new Error(`${upstreamDir} is not a Clarify Run`);
    if (upstream.status !== "succeeded") {
      if (!opts.allowFailedClarify) {
        throw new Error(`Clarify Run ${basename(upstreamDir)} has status ${upstream.status}, so its Aligned Brief may be incomplete; pass --allow-failed-clarify to use it anyway`);
      }
      warnings.push(`Started from Clarify Run ${basename(upstreamDir)}, whose status is ${upstream.status}`);
    }
    source = { kind: "run", stage: "clarify", runId: basename(upstreamDir), runDir: upstreamDir, file: "02-aligned.json", sha256: "" };
    createdAt = now().toISOString();
  }

  const alignedPath = join(source.runDir, source.file);
  if (!existsSync(alignedPath)) throw new Error(`No Aligned Brief at ${alignedPath}`);
  const alignedText = readFileSync(alignedPath, "utf8");
  const alignedSha256 = sha256(alignedText);
  if (existing && source.sha256 !== alignedSha256) {
    throw new Error(`The Aligned Brief of Clarify Run ${source.runId} changed since Write Run ${basename(runDir)} was written; start a new Write Run from it`);
  }
  source = { ...source, sha256: alignedSha256 };
  const read = JSON.parse(alignedText) as AlignedBrief;
  const language = existing?.outputLanguage ?? opts.outputLanguage ?? read.outputLanguage;
  if (!existing && language !== read.outputLanguage) warnings.push(`Write writes in ${LANGUAGE_NAMES[language]} but the Aligned Brief was written in ${LANGUAGE_NAMES[read.outputLanguage]}`);
  const aligned: AlignedBrief = { ...read, outputLanguage: language };
  if (!existing && aligned.termination && aligned.termination !== "converged") {
    const open = aligned.agenda.filter((a) => a.status === "unresolved" || a.status === "deferred").length;
    warnings.push(`Clarify Run ${source.runId} ended with ${aligned.termination}: ${open} item(s) still open are written as @open or @deferred`);
  }
  log(`Write Run ${basename(runDir)} ← Clarify Run ${source.runId}, Aligned Brief sha ${alignedSha256.slice(0, 8)}${rewriting ? `, rewriting ${opts.only!.join(", ")}` : ""}`);

  const sets = coverageSets(aligned);
  const lib = new PromptLibrary(config.promptsDir);
  const thinking = thinkingFor(config, "write");
  const reviewThinking = thinkingForWriteRole(config, "review");
  const traceDir = join(runDir, "traces");
  const agents: AgentRecord[] = existing?.agents ?? [];
  const features: Record<string, FeatureRecord> = { ...(existing?.features ?? {}) };
  const failures: string[] = [];
  let backend: AgentBackend | undefined;
  const getBackend = async () => (backend ??= await opts.backend());

  const writeRun = (status: string) => {
    const telemetry = runTelemetry(existing?.telemetry);
    writeJson(runPath, {
      status,
      stage: "write",
      createdAt,
      updatedAt: now().toISOString(),
      source,
      model: config.provider.model,
      thinking: { outline: thinking, writer: thinking, review: reviewThinking },
      outputLanguage: language,
      promptHashes: lib.hashes(),
      agents,
      features,
      warnings,
      failures,
      ...(telemetry ? { telemetry } : {}),
    });
  };
  const fail = (message: string): WriteReport => {
    failures.push(message);
    writeRun("failed");
    return { status: "failed", failures, warnings, runDir, unwritten: [] };
  };
  const recordAgent = (label: string, outcome: TaskOutcome<unknown>) => {
    const input = outcome.metrics.tokens.input;
    agents.push({
      label,
      status: outcome.status,
      ...(outcome.status === "failed" ? { reason: outcome.reason } : {}),
      metrics: outcome.metrics,
      cacheReadRatio: input ? Number((outcome.metrics.tokens.cacheRead / input).toFixed(3)) : 0,
    });
  };
  const count = (issues: FeatureIssue[]) => issues.reduce((n, i) => n + i.errors.length, 0);
  const retry = (tool: string, issues: FeatureIssue[]) => ({ retry: validationFeedback(lib, tool, formatRoundIssues(issues), count(issues)) });

  writeRun("running");

  // Outline: planned once per Run; a rewrite keeps it, and with it every SCN id.
  let outline: WriteOutline;
  let outlineRejected: OutlineRejected[];
  if (existing) {
    outline = readJson<WriteOutline>(join(runDir, "03-outline.json"));
    outlineRejected = existsSync(join(runDir, "03-rejected.json")) ? readJson<{ outline: OutlineRejected[] }>(join(runDir, "03-rejected.json")).outline : [];
    const unknown = opts.only!.filter((id) => !outline.features.some((f) => f.id === id));
    if (unknown.length) throw new Error(`${unknown.join(", ")} not in the outline of Write Run ${basename(runDir)}; its Features are ${outline.features.map((f) => f.id).join(", ")}`);
  } else {
    const label = "write-outline";
    const prompt = buildOutlinePrompt(lib, aligned, sets);
    savePrompt(runDir, label, prompt);
    log(`[${label}] planning ${sets.features.length} Feature(s), ${sets.mustCover.length} item(s) to cover`);
    const outcome = await runTraced<OutlineSubmission, OutlineCheckResult>(
      await getBackend(),
      {
        label,
        ...prompt,
        nudge: buildNudge(lib, "submit_outline"),
        thinking,
        maxSubmitAttempts: MAX_SUBMIT_ATTEMPTS,
        maxNudges: MAX_NUDGES,
        tool: {
          name: "submit_outline",
          description: "Submit the Features, Rules and scenarios with what each stands on. Call exactly once; call again with the complete corrected result if errors are returned.",
          parameters: OutlineSubmissionSchema,
          check: (params, { isLast }) => {
            const result = checkOutline(params, { aligned, sets, isLast, language });
            return count(result.issues) && !isLast ? retry("submit_outline", result.issues) : { accept: result };
          },
        },
      },
      traceDir,
    );
    recordAgent(label, outcome);
    if (outcome.status === "failed") return fail(`${label} failed (${outcome.reason}): ${outcome.message}`);
    const result = outcome.value;
    outline = applyOutline(result.accepted, aligned, result.uncovered);
    outlineRejected = result.rejected;
    if (result.uncovered.length) warnings.push(`${label}: ${result.uncovered.join(", ")} still uncovered after the last attempt; listed in 03-spec.md`);
    if (result.rejected.length) warnings.push(`${label}: ${result.rejected.length} part(s) set aside after the last attempt; see 03-rejected.json`);
    if (result.languageWarnings.length) warnings.push(`${label}: still not written in ${LANGUAGE_NAMES[language]}, kept: ${result.languageWarnings.join(", ")}`);
    writeJson(join(runDir, "03-outline.json"), outline);
    log(`[${label}] ${outline.features.length} Feature(s), ${outline.scenarios.length} scenario(s)`);
  }

  const previous = existing ? readJson<WrittenFile>(join(runDir, "03-written.json")) : { features: {}, reviews: {}, rejected: {} };
  const written = new Map(Object.entries(previous.features));
  const reviews: Record<string, ScenarioReviewRecord[]> = { ...previous.reviews };
  const rejected: Record<string, FeatureRejected[]> = { ...previous.rejected };

  /** Scenario Review of one writer submission (ADR 0018); returns the findings, or the failure message. */
  const runReview = async (label: string, units: ReviewUnit[]): Promise<ReviewSubmission | string> => {
    const prompt = buildReviewPrompt(lib, aligned, units);
    savePrompt(runDir, label, prompt);
    const outcome = await runTraced<ReviewSubmission, ReviewSubmission>(
      await getBackend(),
      {
        label,
        ...prompt,
        nudge: buildNudge(lib, "submit_review"),
        thinking: reviewThinking,
        maxSubmitAttempts: MAX_SUBMIT_ATTEMPTS,
        maxNudges: MAX_NUDGES,
        tool: {
          name: "submit_review",
          description: "Submit your review of every line. Call exactly once; call again with the complete corrected result if errors are returned.",
          parameters: ReviewSubmissionSchema,
          check: (params) => {
            const errors = reviewErrors(params, units);
            return errors.length ? { retry: validationFeedback(lib, "submit_review", errors.map((e) => `- ${e}`).join("\n"), errors.length) } : { accept: params };
          },
        },
      },
      traceDir,
    );
    recordAgent(label, outcome);
    return outcome.status === "failed" ? `${label} failed (${outcome.reason}): ${outcome.message}` : outcome.value;
  };

  interface WriterResult {
    feature: WrittenFeature;
    reviews: ScenarioReviewRecord[];
    rejected: FeatureRejected[];
    missing: string[];
    languageWarnings: string[];
  }

  /**
   * One Feature's writer; returns its accepted result, or the failure message. Every submission that passes the
   * check goes through Scenario Review before it is accepted, and the review's findings come back as errors.
   */
  const runWriter = async (featureId: string): Promise<WriterResult | string> => {
    const label = `write-${featureId}${labelSuffix}`;
    const prompt = buildWriterPrompt(lib, aligned, sets, outline, featureId);
    savePrompt(runDir, label, prompt);
    const records: ScenarioReviewRecord[] = [];
    let reviewFailure: string | undefined;
    let reviewCount = 0;
    const memo = reviewMemo();
    const outcome = await runTraced<FeatureSubmission, WriterResult>(
      await getBackend(),
      {
        label,
        ...prompt,
        nudge: buildNudge(lib, "submit_feature"),
        thinking,
        maxSubmitAttempts: MAX_SUBMIT_ATTEMPTS,
        maxNudges: MAX_NUDGES,
        tool: {
          name: "submit_feature",
          description: "Submit the steps of every scenario of this Feature. Call exactly once; call again with the complete corrected result if errors are returned.",
          parameters: FeatureSubmissionSchema,
          check: async (params, { attempt, isLast }) => {
            const result = checkFeature(params, { aligned, sets, outline, featureId, isLast, language });
            if (count(result.issues) && !isLast) return retry("submit_feature", result.issues);
            const accepted = (feature: WrittenFeature) => ({
              accept: { feature, reviews: records, rejected: result.rejected, missing: result.missing, languageWarnings: result.languageWarnings },
            });

            const units = underReview(result.accepted, outline);
            if (!units.length) return accepted(result.accepted);
            const fresh = memo.fresh(units);
            const review = fresh.length ? await runReview(`${label}-review${++reviewCount}`, fresh) : { reviews: [] };
            if (typeof review === "string") {
              reviewFailure = review;
              return accepted(result.accepted);
            }
            const paths = new Map<string, string>([["background", "background"]]);
            params.scenarios.forEach((s, i) => paths.has(s.id) || paths.set(s.id, `scenarios[${i}]`));
            const judged = judgeReview(units, memo.merge(units, review), { attempt, paths });
            records.push(...judged.records);
            if (count(judged.issues) && !isLast) return retry("submit_feature", judged.issues);
            return accepted(judged.flagged.size ? markUnverified(result.accepted, judged) : result.accepted);
          },
        },
      },
      traceDir,
    );
    recordAgent(label, outcome);
    if (outcome.status === "failed") return `${label} failed (${outcome.reason}): ${outcome.message}`;
    return reviewFailure ?? outcome.value;
  };

  const targets = rewriting ? [...new Set(opts.only!)] : outline.features.map((f) => f.id);
  const scenarioIds = (featureId: string) => outline.scenarios.filter((s) => s.featureId === featureId).map((s) => s.id);
  await mapLimit(targets, config.concurrency ?? 2, async (featureId) => {
    log(`[write-${featureId}] writing ${scenarioIds(featureId).length} scenario(s)`);
    const result = await inSpan("write.feature", { "xplan.feature": featureId, "xplan.batch": batch }, async (span) => {
      const r = await runWriter(featureId);
      if (typeof r === "string") failSpan(span, r);
      return r;
    });
    if (typeof result === "string" && written.has(featureId)) {
      // A failed rewrite keeps what the earlier batch wrote.
      warnings.push(`${result}; ${featureId} keeps what batch ${features[featureId]?.batch ?? "initial"} wrote`);
      log(`[write-${featureId}] failed, kept the earlier version: ${result}`);
      return;
    }
    if (typeof result === "string") {
      delete reviews[featureId];
      delete rejected[featureId];
      features[featureId] = { status: "failed", batch, unwritten: scenarioIds(featureId), reason: result };
      log(`[write-${featureId}] failed: ${result}`);
      return;
    }
    written.set(featureId, result.feature);
    reviews[featureId] = result.reviews;
    rejected[featureId] = result.rejected;
    features[featureId] = { status: "written", batch, unwritten: result.missing };
    const unverified = result.feature.scenarios.filter((s) => s.unverified?.length).map((s) => s.id);
    if (unverified.length) warnings.push(`write-${featureId}: ${unverified.join(", ")} kept as @unverified; see 03-spec.md`);
    if (result.missing.length) warnings.push(`write-${featureId}: ${result.missing.join(", ")} not written; rendered @unwritten`);
    if (result.languageWarnings.length) warnings.push(`write-${featureId}: still not written in ${LANGUAGE_NAMES[language]}, kept: ${result.languageWarnings.join(", ")}`);
  });

  for (const feature of outline.features) {
    const text = renderFeature(feature, { aligned, outline, written: written.get(feature.id), language });
    const errors = gherkinErrors(text);
    if (errors.length) return fail(`Rendering ${feature.id} produced invalid Gherkin, a bug in x-plan: ${errors.join("; ")}`);
    writeText(join(runDir, "features", `${feature.id}.feature`), text);
  }
  const trace = buildTrace(outline, written);
  for (const ids of duplicateScenarios(trace)) {
    const warning = `${ids.join(", ")} have the same Given and Then; see 03-spec.md`;
    if (!warnings.includes(warning)) warnings.push(warning); // a rewrite with --only starts from the earlier warnings
  }
  writeText(join(runDir, "03-spec.md"), renderSpec({ aligned, outline, written }));
  writeJson(join(runDir, "03-trace.json"), { ...trace, reviews });
  writeJson(join(runDir, "03-written.json"), { features: Object.fromEntries(written), reviews, rejected } satisfies WrittenFile);
  writeJson(join(runDir, "03-rejected.json"), { outline: outlineRejected, features: rejected });

  const failed = outline.features.filter((f) => features[f.id]?.status !== "written");
  for (const f of failed) failures.push(`${f.id}: ${features[f.id]?.reason ?? "not written"}; rewrite it with --only ${f.id}`);
  const unwritten = outline.features.flatMap((f) => (features[f.id]?.status === "written" ? features[f.id]!.unwritten : [f.id]));
  const status = failed.length ? "failed" : "succeeded";
  writeRun(status);
  return { status, failures, warnings, runDir, unwritten };
}

/** `20261001-120000`: a time that is safe in file names. */
function compactTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function readJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`Missing ${path}; the Write Run is incomplete, start a new one`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++] as T);
  });
  await Promise.all(workers);
}
