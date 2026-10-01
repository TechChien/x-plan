import { compareIds, findItem } from "./agenda.ts";
import type { AgendaItem, ClarifyState } from "./schema.ts";

export interface OrderingResult {
  ids: string[];
  /** Why this selection; recorded with the round. */
  rationale: string;
}

/** Candidates for the batch shown to the user after a round's submission, each list already in order. */
export interface BatchCandidates {
  /** Conflicts Consistency Check found in this round (ADR 0012). */
  conflicts: string[];
  followUps: string[];
  prepared: string[];
  gaps: string[];
}

/**
 * Decides which Agenda Items are asked and in what order (ADR 0009). Kept behind this interface so the
 * provisional rule can be replaced, possibly by a model; asynchronous for that reason. Callers check every
 * result with `checkSelection`, whoever produced it.
 */
export interface QuestionOrderer {
  /** Pending items the round's agent should prepare, at most `limit`. */
  selectPrepare(state: ClarifyState, limit: number): Promise<OrderingResult>;
  /** The batch the user sees, at most `limit`; what is left out stays pending. */
  composeBatch(state: ClarifyState, candidates: BatchCandidates, limit: number): Promise<OrderingResult>;
}

const SEVERITY = ["blocking", "high", "medium", "low"];
const CONFIDENCE = ["low", "medium", "high"];

/**
 * Provisional rule: conflicts between Decisions (an unsettled one may undermine everything asked after it), then
 * contradictions, then open questions by severity, then assumptions least confident first,
 * then gherkin gaps. A follow-up ranks with the item it follows up, right after it.
 */
export const ruleOrderer: QuestionOrderer = {
  async selectPrepare(state, limit) {
    const ranked = state.agenda
      .filter((i) => i.status === "pending")
      .map((i) => ({ id: i.id, key: rankKey(state, i) }))
      .sort((a, b) => compareKeys(a.key, b.key));
    return {
      ids: ranked.slice(0, limit).map((r) => r.id),
      rationale: "Provisional rule: conflicts, then CTR, then OQ by severity, then ASM least confident first, then gherkin gaps; follow-ups with their origin",
    };
  },
  async composeBatch(_state, { conflicts, followUps, prepared, gaps }, limit) {
    return {
      ids: [...conflicts, ...followUps, ...prepared, ...gaps].slice(0, limit),
      rationale: "Provisional rule: conflicts, then new follow-ups, then prepared items in order, then gherkin gaps",
    };
  },
};

type Key = (number | string)[];

/** [rank of the root item, depth, id path] so a follow-up sorts right after the item it follows up. */
function rankKey(state: ClarifyState, it: AgendaItem): Key {
  const path: AgendaItem[] = [it];
  let parent = it.parentId ? findItem(state, it.parentId) : undefined;
  while (parent) {
    path.unshift(parent);
    parent = parent.parentId ? findItem(state, parent.parentId) : undefined;
  }
  const root = path[0] as AgendaItem;
  return [rootRank(root), ...path.map((p) => p.id)];
}

function rootRank(it: AgendaItem): number {
  if (it.origin === "conflict") return -1;
  if (it.kind === "CTR") return 0;
  if (it.kind === "OQ") return 1 + SEVERITY.indexOf(it.severity ?? "low");
  if (it.kind === "ASM") return 5 + CONFIDENCE.indexOf(it.confidence ?? "high");
  return 8;
}

function compareKeys(a: Key, b: Key): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : compareIds(String(x), String(y));
    if (c) return c;
  }
  return 0;
}

/** Problems with an orderer's selection. */
export function checkSelection(ids: string[], candidates: string[], limit: number): string[] {
  const allowed = new Set(candidates);
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const id of ids) {
    if (!allowed.has(id)) errors.push(`${id} is not a candidate`);
    else if (seen.has(id)) errors.push(`${id} is selected twice`);
    seen.add(id);
  }
  if (ids.length > limit) errors.push(`${ids.length} items selected, at most ${limit} allowed`);
  return errors;
}
