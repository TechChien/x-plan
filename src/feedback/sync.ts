import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeJson } from "../shared/run-files.ts";
import type { LangfuseCredentials } from "../shared/langfuse.ts";
import type { Assessment } from "./schema.ts";
import { readFeedback, standing } from "./store.ts";

/** A score as an observability backend stores it, attached to a trace and optionally one span of it. */
export interface Score {
  id: string;
  traceId: string;
  observationId?: string;
  name: "item-verdict" | "missing" | "run-score";
  dataType: "CATEGORICAL" | "NUMERIC";
  value: string | number;
  comment?: string;
  metadata: Record<string, string>;
}

/** Where Feedback is mirrored. Creating a score with an id that exists replaces it, so a retry is harmless. */
export interface ScoreSink {
  create(score: Score): Promise<void>;
  /** Succeeds when the score is already gone. */
  delete(id: string): Promise<void>;
}

/** Langfuse's public scores API. */
export class LangfuseScores implements ScoreSink {
  constructor(
    private readonly creds: LangfuseCredentials,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async create(score: Score): Promise<void> {
    await this.call("POST", "/api/public/scores", score);
  }

  async delete(id: string): Promise<void> {
    await this.call("DELETE", `/api/public/scores/${encodeURIComponent(id)}`, undefined, [404]);
  }

  private async call(method: string, path: string, body: unknown, alsoFine: number[] = []): Promise<void> {
    const response = await this.fetchFn(`${this.creds.baseUrl}${path}`, {
      method,
      headers: { Authorization: this.creds.authorization, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok && !alsoFine.includes(response.status)) {
      throw new Error(`Langfuse ${method} ${path} returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
  }
}

/** `feedback-sync.json`: which entries reached the backend. Machine state, so unlike `feedback.jsonl` it is rewritten. */
export type SyncState = Record<string, { scoreId: string; syncedAt: string; deletedAt?: string }>;

const syncPath = (runDir: string) => join(runDir, "feedback-sync.json");

export function readSyncState(runDir: string): SyncState {
  return existsSync(syncPath(runDir)) ? (JSON.parse(readFileSync(syncPath(runDir), "utf8")) as SyncState) : {};
}

/** For `--list`: synced, not synced yet, or never sent because the Run was not traced. */
export function syncStatus(entry: Assessment, state: SyncState): string {
  if (!entry.trace) return "no trace";
  return state[entry.id] && !state[entry.id]!.deletedAt ? "synced" : "not synced";
}

export interface SyncReport {
  created: string[];
  deleted: string[];
  /** Standing entries without a trace: there is nothing to attach them to. */
  untraced: string[];
  /** The first failure; the rest waits for the next sync. */
  error?: string;
}

/**
 * Makes the backend match the standing Feedback (ADR 0014): removes the scores of superseded or retracted entries,
 * then sends what has not been sent. State is saved after every call, so a failure loses nothing already done.
 */
export async function syncFeedback(runDir: string, sink: ScoreSink, now: () => Date = () => new Date()): Promise<SyncReport> {
  const runId = basename(runDir);
  const live = standing(readFeedback(runDir));
  const liveIds = new Set(live.map((e) => e.id));
  const state = readSyncState(runDir);
  const report: SyncReport = { created: [], deleted: [], untraced: live.filter((e) => !e.trace).map((e) => e.id) };
  const save = () => writeJson(syncPath(runDir), state);

  try {
    for (const [id, sent] of Object.entries(state)) {
      if (sent.deletedAt || liveIds.has(id)) continue;
      await sink.delete(sent.scoreId);
      sent.deletedAt = now().toISOString();
      report.deleted.push(id);
      save();
    }
    for (const entry of live) {
      if (!entry.trace || state[entry.id]) continue;
      const score = toScore(runId, entry);
      await sink.create(score);
      state[entry.id] = { scoreId: score.id, syncedAt: now().toISOString() };
      report.created.push(entry.id);
      save();
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  return report;
}

export function toScore(runId: string, entry: Assessment): Score {
  if (!entry.trace) throw new Error(`${entry.id} has no trace`);
  const others = entry.trace.otherSources?.length ? `Also from: ${entry.trace.otherSources.join(", ")}` : undefined;
  const comment = (...parts: (string | undefined)[]) => parts.filter(Boolean).join("\n") || undefined;
  const base = {
    id: `xplan-${runId}-${entry.id}`,
    traceId: entry.trace.traceId,
    ...(entry.trace.spanId ? { observationId: entry.trace.spanId } : {}),
    metadata: { feedbackId: entry.id, runId, author: entry.author, ...(entry.type === "item" ? { target: entry.target, section: entry.section } : {}) },
  };
  const withComment = (text: string | undefined) => (text ? { comment: text } : {});
  switch (entry.type) {
    case "item":
      return { ...base, name: "item-verdict", dataType: "CATEGORICAL", value: entry.verdict, ...withComment(comment(`${entry.target}${entry.note ? `: ${entry.note}` : ""}`, others)) };
    case "missing":
      return { ...base, name: "missing", dataType: "CATEGORICAL", value: "missing", ...withComment(comment(`${entry.text}${entry.at ? ` (${entry.at})` : ""}`, others)) };
    case "score":
      return { ...base, name: "run-score", dataType: "NUMERIC", value: entry.score, ...withComment(comment(entry.note)) };
  }
}
