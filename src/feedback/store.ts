import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Assessment, FeedbackEntry } from "./schema.ts";

/**
 * `feedback.jsonl` in the Run's directory: append-only, like Answers (ADR 0014). Changing one's mind appends an entry
 * that supersedes or retracts the earlier one, so who said what and when is never lost.
 */
export function feedbackPath(runDir: string): string {
  return join(runDir, "feedback.jsonl");
}

export function readFeedback(runDir: string): FeedbackEntry[] {
  const path = feedbackPath(runDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, i) => {
      try {
        return JSON.parse(line) as FeedbackEntry;
      } catch {
        throw new Error(`${path} line ${i + 1} is not valid JSON`);
      }
    });
}

export function appendFeedback(runDir: string, entry: FeedbackEntry): void {
  appendFileSync(feedbackPath(runDir), `${JSON.stringify(entry)}\n`);
}

export function nextFeedbackId(entries: FeedbackEntry[]): string {
  return `FB-${Math.max(0, ...entries.map((e) => Number(e.id.slice(3)) || 0)) + 1}`;
}

/** The assessments that still stand: neither superseded nor retracted. */
export function standing(entries: FeedbackEntry[]): Assessment[] {
  const withdrawn = new Set<string>();
  for (const e of entries) {
    if (e.type === "retract") withdrawn.add(e.retracts);
    else if (e.type !== "missing" && e.supersedes) withdrawn.add(e.supersedes);
  }
  return entries.filter((e): e is Assessment => e.type !== "retract" && !withdrawn.has(e.id));
}

/**
 * What a new assessment by `author` replaces: their standing verdict on the same item, or their standing score.
 * Missing entries never replace each other, each names a different fact; other authors' Feedback stands beside it.
 */
export function replacedBy(entries: FeedbackEntry[], author: string, next: { type: "item"; target: string } | { type: "score" }): Assessment | undefined {
  return standing(entries).find(
    (e) => e.author === author && e.type === next.type && (e.type !== "item" || (next.type === "item" && e.target === next.target)),
  );
}
