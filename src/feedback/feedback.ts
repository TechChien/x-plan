import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { findItem, itemTrace, locate, openRun, runTrace } from "./run-view.ts";
import { MAX_SCORE, MIN_SCORE, verdictsFor, type FeedbackEntry, type Verdict } from "./schema.ts";
import { appendFeedback, nextFeedbackId, readFeedback, replacedBy, standing } from "./store.ts";

export type FeedbackRequest =
  | { type: "item"; target: string; verdict: Verdict; note?: string }
  | { type: "missing"; text: string; at?: string }
  | { type: "score"; score: number; note?: string }
  | { type: "retract"; id: string; note?: string };

export interface Recorded {
  entry: FeedbackEntry;
  /** The id of the same author's earlier entry this one supersedes. */
  replaces?: string;
  warnings: string[];
}

/**
 * Validates a request against the Run and appends it to `feedback.jsonl`, with a snapshot of the item and the span
 * that produced it. A second verdict by the same author on the same item, or a second score, supersedes the first.
 */
export function recordFeedback(runDir: string, request: FeedbackRequest, by: { author: string; now: Date }): Recorded {
  const run = openRun(runDir);
  const entries = readFeedback(runDir);
  const base = { id: nextFeedbackId(entries), createdAt: by.now.toISOString(), author: by.author };
  const warnings = run.status === "failed" ? [`Run ${run.id} has status failed; the Feedback is recorded against its output as it is`] : [];
  const note = (text?: string) => (text?.trim() ? { note: text.trim() } : {});
  let entry: FeedbackEntry;
  let replaces: string | undefined;

  switch (request.type) {
    case "item": {
      const { section, item } = findItem(run, request.target);
      const allowed = verdictsFor(request.target);
      if (!allowed.includes(request.verdict)) throw new Error(`${request.target} takes ${allowed.map((v) => `--${v}`).join(", ")}, not --${request.verdict}`);
      if (request.verdict !== "ok" && !request.note?.trim()) throw new Error(`--${request.verdict} needs a note saying what is wrong`);
      replaces = replacedBy(entries, by.author, { type: "item", target: request.target })?.id;
      const trace = itemTrace(run, request.target);
      entry = { ...base, type: "item", target: request.target, section, verdict: request.verdict, ...note(request.note), snapshot: item, ...(trace ? { trace } : {}), ...(replaces ? { supersedes: replaces } : {}) };
      break;
    }
    case "missing": {
      if (!request.text.trim()) throw new Error("--missing needs the fact that is missing");
      const trace = runTrace(run, request.at ? locate(run, request.at) : []);
      entry = { ...base, type: "missing", text: request.text.trim(), ...(request.at ? { at: request.at } : {}), ...(trace ? { trace } : {}) };
      break;
    }
    case "score": {
      if (!Number.isInteger(request.score) || request.score < MIN_SCORE || request.score > MAX_SCORE) {
        throw new Error(`--score takes a whole number from ${MIN_SCORE} to ${MAX_SCORE}`);
      }
      replaces = replacedBy(entries, by.author, { type: "score" })?.id;
      const trace = runTrace(run);
      entry = { ...base, type: "score", score: request.score, ...note(request.note), ...(trace ? { trace } : {}), ...(replaces ? { supersedes: replaces } : {}) };
      break;
    }
    case "retract": {
      const target = entries.find((e) => e.id === request.id);
      if (!target || target.type === "retract") throw new Error(`No Feedback ${request.id} in Run ${run.id}`);
      if (!standing(entries).some((e) => e.id === request.id)) throw new Error(`${request.id} was already superseded or retracted`);
      entry = { ...base, type: "retract", retracts: request.id, ...note(request.note) };
      break;
    }
  }
  appendFeedback(runDir, entry);
  return { entry, ...(replaces ? { replaces } : {}), warnings };
}

/** XPLAN_AUTHOR, else `git config user.name`, else the OS user. */
export function resolveAuthor(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  if (env.XPLAN_AUTHOR?.trim()) return env.XPLAN_AUTHOR.trim();
  try {
    const name = execFileSync("git", ["config", "user.name"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (name) return name;
  } catch {
    // No git, or no user.name: fall through.
  }
  return userInfo().username;
}

/** One line per standing assessment, for `--list`. `status` says whether and how it reached the backend. */
export function formatFeedback(entries: FeedbackEntry[], status: (id: string) => string): string[] {
  return standing(entries).map((e) => {
    const what =
      e.type === "item"
        ? `${e.target} ${e.verdict}${e.note ? `: ${e.note}` : ""}`
        : e.type === "missing"
          ? `missing${e.at ? ` (${e.at})` : ""}: ${e.text}`
          : `score ${e.score}${e.note ? `: ${e.note}` : ""}`;
    return `${e.id}  ${what}  — ${e.author}, ${e.createdAt.slice(0, 10)}  [${status(e.id)}]`;
  });
}

export interface FeedbackOptions {
  ok?: boolean;
  wrong?: string;
  partial?: string;
  redundant?: string;
  note?: string;
  missing?: string;
  at?: string;
  score?: number;
  retract?: string;
  list?: boolean;
  sync?: boolean;
}

export type FeedbackAction = { action: "record"; request: FeedbackRequest } | { action: "list" } | { action: "sync" };

/** Turns `x-plan feedback <run> [item] --…` into exactly one action, or explains why it is not one. */
export function feedbackAction(item: string | undefined, opts: FeedbackOptions): FeedbackAction {
  const verdicts = (["ok", "wrong", "partial", "redundant"] as const).filter((v) => opts[v] !== undefined && opts[v] !== false);
  const actions = [
    ...(item || verdicts.length ? ["<item> --verdict"] : []),
    ...(opts.missing !== undefined ? ["--missing"] : []),
    ...(opts.score !== undefined ? ["--score"] : []),
    ...(opts.retract !== undefined ? ["--retract"] : []),
    ...(opts.list ? ["--list"] : []),
    ...(opts.sync ? ["--sync"] : []),
  ];
  if (actions.length !== 1) {
    throw new Error(
      actions.length
        ? `Give one thing at a time, not ${actions.join(" and ")}`
        : "Nothing to do: give an item and a verdict (--ok, --wrong, --partial, --redundant), --missing, --score, --retract, --list or --sync",
    );
  }
  if (opts.at !== undefined && opts.missing === undefined) throw new Error("--at goes with --missing");
  if (opts.note !== undefined && !(opts.ok || opts.score !== undefined || opts.retract !== undefined)) {
    throw new Error("--note goes with --ok, --score or --retract; the other verdicts take their note directly, e.g. --wrong \"why\"");
  }

  if (opts.list) return { action: "list" };
  if (opts.sync) return { action: "sync" };
  if (opts.missing !== undefined) return { action: "record", request: { type: "missing", text: opts.missing, ...(opts.at ? { at: opts.at } : {}) } };
  if (opts.score !== undefined) return { action: "record", request: { type: "score", score: opts.score, ...(opts.note ? { note: opts.note } : {}) } };
  if (opts.retract !== undefined) return { action: "record", request: { type: "retract", id: opts.retract, ...(opts.note ? { note: opts.note } : {}) } };
  if (!item) throw new Error(`--${verdicts[0]} needs the item it is about, e.g. x-plan feedback <run> ACT-3 --${verdicts[0]} …`);
  if (verdicts.length !== 1) throw new Error(`Give ${item} one verdict: --ok, --wrong, --partial or --redundant`);
  const verdict = verdicts[0]!;
  const note = verdict === "ok" ? opts.note : (opts[verdict] as string);
  return { action: "record", request: { type: "item", target: item, verdict, ...(note ? { note } : {}) } };
}
