import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { TaskMetrics, TaskOutcome } from "../agent/submit-task.ts";
import type { AgentBackend } from "../agent/types.ts";
import { thinkingFor, type XPlanConfig } from "../config.ts";
import type { RequirementBrief } from "../extract/schema.ts";
import { PromptLibrary, sha256 } from "../prompts/template.ts";
import { LANGUAGE_NAMES, type OutputLanguage } from "../shared/language.ts";
import { savePrompt, writeJson, writeText, type BuiltPrompt } from "../shared/run-files.ts";
import { readRunMeta, type RunSource } from "../shared/runs.ts";
import { buildNudge, runTraced, validationFeedback } from "../shared/traced.ts";
import { close, createState, inputError, item, openItems, recordAnswers, type UserInput } from "./agenda.ts";
import { buildAligned } from "./aligned.ts";
import type { AskedQuestion, Answerer } from "./answerer.ts";
import { applyRound, markAsked } from "./apply.ts";
import { checkRound, formatRoundIssues, type RoundCheckResult } from "./check.ts";
import { checkSelection, ruleOrderer, type QuestionOrderer } from "./ordering.ts";
import { buildFinalPrompt, buildRoundPrompt } from "./prompts.ts";
import { renderAlignedMarkdown, renderTranscript } from "./render.ts";
import {
  awaitsInterpretation,
  CLARIFY_LIMITS,
  FinalSubmissionSchema,
  RoundSubmissionSchema,
  type ClarifyState,
  type FinalSubmission,
  type RoundSubmission,
  type Termination,
} from "./schema.ts";

/** Submit calls per round: the first plus two retries, as in Extract. */
export const MAX_SUBMIT_ATTEMPTS = 3;
export const MAX_NUDGES = 2;

export interface ClarifyOptions {
  /** This Clarify Run's directory. One holding a clarify `run.json` is resumed; otherwise a new Run starts there. */
  runDir: string;
  /** The Extract Run a new Clarify Run starts from (ADR 0010). When resuming, it must be the recorded one if given. */
  sourceRunDir?: string;
  /** Start from an Extract Run whose status is not succeeded. */
  allowFailedExtract?: boolean;
  config: XPlanConfig;
  /** Overrides the language the Brief was written in. */
  outputLanguage?: OutputLanguage;
  /** Discards any saved progress and starts over. */
  restart?: boolean;
  maxRounds?: number;
  batchSize?: number;
  answerer: Answerer;
  orderer?: QuestionOrderer;
  /** Created on demand: a finished or answer-only resume needs no API key. */
  backend: () => Promise<AgentBackend>;
  log: (message: string) => void;
  now?: () => Date;
}

export interface ClarifyReport {
  status: "succeeded" | "failed";
  failures: string[];
  warnings: string[];
  runDir: string;
  termination?: Termination;
}

type UpstreamRun = Extract<RunSource, { kind: "run" }>;

interface AgentRecord {
  label: string;
  status: TaskOutcome<unknown>["status"];
  reason?: string;
  metrics: TaskMetrics;
  /** Share of input tokens served from the provider's prefix cache. */
  cacheReadRatio: number;
}

export async function runClarify(opts: ClarifyOptions): Promise<ClarifyReport> {
  const { config, runDir, log } = opts;
  const now = opts.now ?? (() => new Date());
  const limits = { ...CLARIFY_LIMITS, batchSize: opts.batchSize ?? CLARIFY_LIMITS.batchSize, maxRounds: opts.maxRounds ?? CLARIFY_LIMITS.maxRounds };
  const orderer = opts.orderer ?? ruleOrderer;
  const warnings: string[] = [];
  const failures: string[] = [];
  const statePath = join(runDir, "02-state.json");
  const runPath = join(runDir, "run.json");

  // Which Extract Run this Clarify Run reads (ADR 0010).
  const existing = readRunMeta(runDir);
  let source: UpstreamRun;
  let createdAt: string;
  if (existing) {
    if (existing.stage !== "clarify") throw new Error(`${runDir} is an ${existing.stage} Run, not a Clarify Run`);
    if (existing.source?.kind !== "run") throw new Error(`${runPath} does not record the Extract Run it started from`);
    source = existing.source;
    if (opts.sourceRunDir && resolve(opts.sourceRunDir) !== resolve(source.runDir)) {
      throw new Error(`Clarify Run ${basename(runDir)} belongs to Extract Run ${source.runId}, not ${basename(resolve(opts.sourceRunDir))}`);
    }
    createdAt = existing.createdAt ?? now().toISOString();
  } else {
    if (!opts.sourceRunDir) throw new Error(`${runDir} is not a Clarify Run; to start one, give the Extract Run to start from`);
    const upstreamDir = resolve(opts.sourceRunDir);
    const upstream = readRunMeta(upstreamDir);
    if (upstream?.stage !== "extract") throw new Error(`${upstreamDir} is not an Extract Run`);
    if (upstream.status !== "succeeded") {
      if (!opts.allowFailedExtract) {
        throw new Error(`Extract Run ${basename(upstreamDir)} has status ${upstream.status}, so its Brief may be incomplete; pass --allow-failed-extract to use it anyway`);
      }
      warnings.push(`Started from Extract Run ${basename(upstreamDir)}, whose status is ${upstream.status}`);
    }
    source = { kind: "run", stage: "extract", runId: basename(upstreamDir), runDir: upstreamDir, file: "01-brief.json", sha256: "" };
    createdAt = now().toISOString();
  }

  const briefPath = join(source.runDir, source.file);
  if (!existsSync(briefPath)) throw new Error(`No Requirement Brief at ${briefPath}`);
  const briefText = readFileSync(briefPath, "utf8");
  const brief = JSON.parse(briefText) as RequirementBrief;
  const briefSha256 = sha256(briefText);
  const upstream = readRunMeta(source.runDir);
  const briefLanguage = upstream?.outputLanguage;
  if (existing && !opts.restart && source.sha256 !== briefSha256) {
    throw new Error(
      `The Brief of Extract Run ${source.runId} changed since Clarify Run ${basename(runDir)} started; rerun with --restart to start over from the current Brief (its progress will be discarded)`,
    );
  }
  source = { ...source, sha256: briefSha256 };

  let state: ClarifyState;
  if (existing && existsSync(statePath) && !opts.restart) {
    state = JSON.parse(readFileSync(statePath, "utf8")) as ClarifyState;
    if (opts.outputLanguage && opts.outputLanguage !== state.outputLanguage) {
      warnings.push(`Resuming in ${LANGUAGE_NAMES[state.outputLanguage]}, the language this session started in; --lang ${opts.outputLanguage} is ignored`);
    }
    log(`Resuming Clarify Run ${basename(runDir)} after ${state.rounds.length} round(s)`);
  } else {
    const language = opts.outputLanguage ?? briefLanguage ?? config.outputLanguage ?? "en";
    if (briefLanguage && language !== briefLanguage) {
      warnings.push(`Clarify writes in ${LANGUAGE_NAMES[language]} but the Brief was written in ${LANGUAGE_NAMES[briefLanguage]}`);
    }
    state = { ...createState(brief, briefSha256, language), source: { stage: "extract", runId: source.runId, sha256: briefSha256 } };
  }
  log(
    `Clarify Run ${basename(runDir)} ← Extract Run ${source.runId}${upstream?.createdAt ? ` (extracted ${upstream.createdAt})` : ""}, Brief sha ${briefSha256.slice(0, 8)}, ${state.agenda.length} Agenda Item(s)`,
  );

  const lib = new PromptLibrary(config.promptsDir);
  const agents: AgentRecord[] = existing && !opts.restart ? ((existing as { agents?: AgentRecord[] }).agents ?? []) : [];
  const thinking = thinkingFor(config, "clarify");
  const traceDir = join(runDir, "traces");
  let backend: AgentBackend | undefined;
  const getBackend = async () => (backend ??= await opts.backend());

  const save = () => {
    writeJson(statePath, state);
    writeText(join(runDir, "02-transcript.md"), renderTranscript(state));
  };
  const writeRun = (status: string) =>
    writeJson(runPath, {
      status,
      stage: "clarify",
      createdAt,
      updatedAt: now().toISOString(),
      source,
      model: config.provider.model,
      thinking,
      outputLanguage: state.outputLanguage,
      limits,
      promptHashes: lib.hashes(),
      rounds: state.rounds.map((r) => ({ n: r.n, final: r.final, prepare: r.prepare, asked: r.asked.map((q) => q.id), ordering: r.ordering })),
      agents,
      ...(state.termination ? { termination: state.termination } : {}),
      counts: countStatuses(state),
      rejectedCount: state.rejected.length,
      warnings,
      failures,
    });
  const fail = (message: string): ClarifyReport => {
    failures.push(message);
    save();
    writeRun("failed");
    return { status: "failed", failures, warnings, runDir };
  };

  /** Runs one round's agent; returns the accepted check result, or the failure message. */
  const runAgent = async <P extends RoundSubmission | FinalSubmission>(
    label: string,
    prompt: BuiltPrompt,
    final: boolean,
    prepare: string[],
  ): Promise<RoundCheckResult | string> => {
    savePrompt(runDir, label, prompt);
    const toolName = final ? "submit_final" : "submit_round";
    const round = state.rounds.length + 1;
    const outcome = await runTraced<P, RoundCheckResult>(
      await getBackend(),
      {
        label,
        ...prompt,
        nudge: buildNudge(lib, toolName),
        thinking,
        maxSubmitAttempts: MAX_SUBMIT_ATTEMPTS,
        maxNudges: MAX_NUDGES,
        tool: {
          name: toolName,
          description: final
            ? "Submit the Decisions drawn from the pending Answers. Call exactly once; call again with the complete corrected result if errors are returned."
            : "Submit this round's Decisions, follow-up questions and prepared questions. Call exactly once; call again with the complete corrected result if errors are returned.",
          parameters: final ? FinalSubmissionSchema : RoundSubmissionSchema,
          check: (params, { isLast }) => {
            const result = checkRound(state, params, { brief, round, prepare, final, isLast, language: state.outputLanguage, limits });
            const count = result.issues.reduce((n, i) => n + i.errors.length, 0);
            if (count && !isLast) return { retry: validationFeedback(lib, toolName, formatRoundIssues(result.issues), count) };
            return { accept: result };
          },
        },
      },
      traceDir,
    );
    const input = outcome.metrics.tokens.input;
    agents.push({
      label,
      status: outcome.status,
      ...(outcome.status === "failed" ? { reason: outcome.reason } : {}),
      metrics: outcome.metrics,
      cacheReadRatio: input ? Number((outcome.metrics.tokens.cacheRead / input).toFixed(3)) : 0,
    });
    if (outcome.status === "failed") return `${label} failed (${outcome.reason}): ${outcome.message}`;
    const result = outcome.value;
    state.rejected.push(...result.rejected);
    if (result.rejected.length) warnings.push(`${label}: ${result.rejected.length} item(s) rejected after the last attempt; see 02-rejected.json`);
    if (result.languageWarnings.length) {
      warnings.push(`${label}: ${result.languageWarnings.length} item(s) still not written in ${LANGUAGE_NAMES[state.outputLanguage]} after the last attempt, kept: ${result.languageWarnings.join(", ")}`);
    }
    return result;
  };

  save();
  writeRun("running");

  try {
    while (state.phase !== "closed") {
      if (state.phase === "answer") {
        await collectAnswers(
          state,
          opts.answerer,
          (next) => {
            state = next;
            save();
          },
          now,
        );
        continue;
      }

      const asked = state.rounds.filter((r) => !r.final).length;
      if (state.doneRequested || asked >= limits.maxRounds) {
        const termination: Termination = state.doneRequested ? "done" : "cap";
        if (termination === "cap") warnings.push(`Stopped after ${limits.maxRounds} rounds with ${openItems(state).length} item(s) still open`);
        if (state.agenda.some((i) => awaitsInterpretation(i.status))) {
          log(`[clarify-final] interpreting the last Answers`);
          const result = await runAgent<FinalSubmission>("clarify-final", buildFinalPrompt(lib, brief, state), true, []);
          if (typeof result === "string") return fail(result);
          state = applyRound(state, { n: state.rounds.length + 1, final: true, prepare: [], accepted: result.accepted, ordering: "" });
        }
        state = close(state, termination);
        break;
      }

      if (!openItems(state).length) {
        state = close(state, "converged");
        break;
      }

      const n = state.rounds.length + 1;
      const pending = state.agenda.filter((i) => i.status === "pending").map((i) => i.id);
      const selection = await orderer.selectPrepare(state, limits.batchSize);
      const selectionErrors = checkSelection(selection.ids, pending, limits.batchSize);
      if (selectionErrors.length) throw new Error(`Question orderer returned an invalid selection: ${selectionErrors.join("; ")}`);
      if (!selection.ids.length && !state.agenda.some((i) => i.status === "answered")) {
        throw new Error(`Nothing to ask or interpret, but ${openItems(state).map((i) => i.id).join(", ")} are still open`);
      }

      const label = `clarify-r${n}`;
      log(`[${label}] interpreting ${state.agenda.filter((i) => i.status === "answered").length} Answer(s), preparing ${selection.ids.length} question(s)`);
      const result = await runAgent<RoundSubmission>(label, buildRoundPrompt(lib, brief, state, selection.ids, { maxGaps: limits.maxGapsPerRound }), false, selection.ids);
      if (typeof result === "string") return fail(result);
      state = applyRound(state, { n, final: false, prepare: selection.ids, accepted: result.accepted, ordering: selection.rationale });

      const candidates = {
        followUps: result.accepted.followUps.filter((f) => f.origin === "follow-up").map((f) => f.id),
        prepared: selection.ids.filter((id) => item(state, id).status === "pending" && result.accepted.prepared.some((p) => p.id === id)),
        gaps: result.accepted.followUps.filter((f) => f.origin === "gherkin-gap").map((f) => f.id),
      };
      const batch = await orderer.composeBatch(state, candidates, limits.batchSize);
      const batchErrors = checkSelection(batch.ids, [...candidates.followUps, ...candidates.prepared, ...candidates.gaps], limits.batchSize);
      if (batchErrors.length) throw new Error(`Question orderer returned an invalid batch: ${batchErrors.join("; ")}`);
      state = markAsked(state, batch.ids, batch.rationale);
      save();
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    opts.answerer.close?.();
  }

  save();
  const aligned = buildAligned(brief, state);
  writeJson(join(runDir, "02-aligned.json"), aligned);
  writeText(join(runDir, "02-aligned.md"), renderAlignedMarkdown(aligned));
  writeJson(join(runDir, "02-rejected.json"), state.rejected);
  writeRun("succeeded");
  return { status: "succeeded", failures, warnings, runDir, ...(state.termination ? { termination: state.termination } : {}) };
}

/** Shows the current batch and commits each input as it comes, so an interruption loses nothing already said. */
async function collectAnswers(start: ClarifyState, answerer: Answerer, commit: (state: ClarifyState) => void, now: () => Date): Promise<void> {
  let state = start;
  const round = state.rounds.at(-1);
  if (!round) throw new Error("No round to answer");
  const questions: AskedQuestion[] = round.asked
    .filter((q) => item(state, q.id).status === "asked")
    .map((q) => {
      const it = item(state, q.id);
      return { ...q, kind: it.kind, origin: it.origin, relatedIds: it.relatedIds, ...(it.parentId ? { parentId: it.parentId } : {}) };
    });
  await answerer.ask(questions, {
    round: round.n,
    record: (input: UserInput) => {
      const error = inputError(state, input);
      if (error) return error;
      state = recordAnswers(state, [input], { via: answerer.via, at: now().toISOString() });
      commit(state);
      return undefined;
    },
  });
  if (state.phase === "answer") throw new Error(`The answerer stopped before answering ${state.agenda.filter((i) => i.status === "asked").map((i) => i.id).join(", ")}`);
}

function countStatuses(state: ClarifyState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const i of state.agenda) counts[i.status] = (counts[i.status] ?? 0) + 1;
  return counts;
}
