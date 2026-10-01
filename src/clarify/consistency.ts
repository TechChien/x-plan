import { stringify } from "yaml";
import { FACT_SECTION_NAMES, type RequirementBrief } from "../extract/schema.ts";
import type { PromptLibrary } from "../prompts/template.ts";
import { languageErrors, LANGUAGE_NAMES, type OutputLanguage } from "../shared/language.ts";
import type { BuiltPrompt } from "../shared/run-files.ts";
import { findItem } from "./agenda.ts";
import type { RoundIssue } from "./check.ts";
import { isTerminal, type AcceptedConflict, type AgendaItem, type ClarifyState, type ConflictOp, type ConsistencySubmission, type Decision } from "./schema.ts";

/**
 * Consistency Check (ADR 0012): after a round's Decisions are written, a third agent compares them with every
 * Decision and Brief fact still in force. A conflict becomes a question for the user, asked first in the next
 * batch; the user's Answer is then interpreted like any other, revising or superseding a side.
 */

/** The Decisions written in the latest round. */
export function newDecisions(state: ClarifyState): Decision[] {
  const ids = new Set(state.rounds.at(-1)?.accepted.decisions.map((d) => d.id) ?? []);
  return state.decisions.filter((d) => ids.has(d.id) && d.status === "active");
}

export function buildConsistencyPrompt(lib: PromptLibrary, brief: RequirementBrief, state: ClarifyState): BuiltPrompt {
  return {
    systemPrompt: lib.render("clarify/consistency.system", { outputLanguage: LANGUAGE_NAMES[state.outputLanguage] }),
    userMessage: lib.render("clarify/consistency.user", { input: consistencyToYaml(brief, state) }),
  };
}

/** Brief facts no active Decision supersedes. Questions and assumptions are not facts: they are being asked. */
export function factsInForce(brief: RequirementBrief, state: ClarifyState): Map<string, Record<string, unknown>> {
  const superseded = new Set(state.decisions.filter((d) => d.status === "active").flatMap((d) => d.supersedes));
  const facts = new Map<string, Record<string, unknown>>();
  for (const section of FACT_SECTION_NAMES) {
    for (const item of brief[section] as unknown as Record<string, unknown>[]) {
      if (typeof item.id === "string" && !superseded.has(item.id)) facts.set(item.id, item);
    }
  }
  return facts;
}

export function consistencyToYaml(brief: RequirementBrief, state: ClarifyState): string {
  const fresh = newDecisions(state);
  const freshIds = new Set(fresh.map((d) => d.id));
  const earlier = state.decisions.filter((d) => d.status === "active" && !freshIds.has(d.id));
  const facts = factsInForce(brief, state);
  const open = state.agenda.filter((i) => i.origin === "conflict" && !isTerminal(i.status));
  return yaml({
    new: fresh.map(decisionView),
    ...(earlier.length ? { decided: earlier.map(decisionView) } : {}),
    brief: [...facts.values()].map(({ evidence: _evidence, ...rest }) => rest),
    ...(open.length ? { openConflicts: open.map((i) => ({ id: i.id, ids: i.relatedIds, conflict: i.text })) } : {}),
  });
}

function decisionView(d: Decision) {
  return {
    id: d.id,
    conclusion: d.conclusion,
    ...(d.supersedes.length ? { supersedes: d.supersedes } : {}),
    ...(d.revises.length ? { revises: d.revises } : {}),
    ...(d.relatedIds.length ? { relatedIds: d.relatedIds } : {}),
  };
}

export interface ConsistencyCheckResult {
  issues: RoundIssue[];
  /** Conflicts without errors other than language. */
  accepted: ConflictOp[];
  /** Accepted conflicts still in the wrong language. */
  languageWarnings: string[];
}

/** Each conflict involves a new Decision, names only what is in force, is not already settled or asked. */
export function checkConflicts(
  brief: RequirementBrief,
  state: ClarifyState,
  submission: ConsistencySubmission,
  ctx: { language: OutputLanguage; limit: number },
): ConsistencyCheckResult {
  const fresh = new Map(newDecisions(state).map((d) => [d.id, d]));
  const active = new Set(state.decisions.filter((d) => d.status === "active").map((d) => d.id));
  const facts = factsInForce(brief, state);
  const asked = state.agenda.filter((i) => i.origin === "conflict").map((i) => ({ id: i.id, key: key(i.relatedIds) }));
  const result: ConsistencyCheckResult = { issues: [], accepted: [], languageWarnings: [] };
  const seen = new Set<string>();

  submission.conflicts.forEach((c, i) => {
    const path = `conflicts[${i}]`;
    const errors: string[] = [];
    if (new Set(c.ids).size !== c.ids.length) errors.push("ids lists an id twice");
    for (const id of c.ids) if (!active.has(id) && !facts.has(id)) errors.push(`${id} is neither an active Decision nor a Brief fact in force`);
    const own = c.ids.filter((id) => fresh.has(id));
    if (!own.length) errors.push("names no Decision from <new>: only conflicts involving this round's Decisions are checked");
    for (const id of own) {
      const d = fresh.get(id)!;
      for (const other of c.ids) {
        if (d.revises.includes(other)) errors.push(`${id} already revises ${other}: that is a correction, not a conflict`);
        if (d.supersedes.includes(other)) errors.push(`${id} already supersedes ${other}: that is a correction, not a conflict`);
      }
    }
    const decisionsHere = c.ids.map((id) => state.decisions.find((d) => d.id === id)).filter((d) => d !== undefined);
    if (decisionsHere.length === c.ids.length && new Set(decisionsHere.map((d) => d.answerRef)).size === 1) {
      errors.push(`all of ${c.ids.join(", ")} come from the same Answer ${decisionsHere[0]!.answerRef}: they are one statement of the user, read together`);
    }
    const k = key(c.ids);
    const before = asked.find((a) => a.key === k);
    if (before) errors.push(`this conflict was already raised as ${before.id}`);
    else if (seen.has(k)) errors.push("the same conflict is listed twice");
    seen.add(k);
    if (i >= ctx.limit) errors.push(`at most ${ctx.limit} conflicts per round`);
    // Language is only warned about: a stray character must not cost a retry, let alone fail the round.
    const language = languageErrors({ conflict: c.conflict, question: c.question, recommendation: c.recommendation, options: c.options }, ctx.language);
    if (errors.length) result.issues.push({ path, errors });
    else {
      result.accepted.push(c);
      if (language.length) result.languageWarnings.push(path);
    }
  });
  return result;
}

/**
 * Adds a round's conflicts to the Agenda as questions and records them with the round. Pure: returns a new state.
 * In the closing round, or past the chain limit, a conflict cannot be asked and becomes unresolved at once.
 */
export function addConflicts(state: ClarifyState, conflicts: ConflictOp[], ctx: { final: boolean; maxDepth: number }): ClarifyState {
  let next = 1 + Math.max(0, ...state.agenda.filter((i) => i.kind === "FQ").map((i) => Number(/-(\d+)$/.exec(i.id)?.[1] ?? 0)));
  const accepted: AcceptedConflict[] = conflicts.map((c) => {
    const depth = 1 + Math.max(0, ...c.ids.map((id) => settledConflictDepth(state, id)));
    return { ...c, id: `FQ-${next++}`, depth, status: ctx.final || depth > ctx.maxDepth ? "unresolved" : "pending" };
  });
  return restoreConflicts(state, accepted);
}

/** Puts a round's recorded conflicts on the Agenda and records them with the latest round. Pure; replay uses it. */
export function restoreConflicts(current: ClarifyState, conflicts: AcceptedConflict[]): ClarifyState {
  const state = structuredClone(current);
  const round = state.rounds.at(-1);
  if (!round) throw new Error("No round to add conflicts to");
  round.conflicts = structuredClone(conflicts);
  for (const c of conflicts) {
    const item: AgendaItem = {
      id: c.id,
      kind: "FQ",
      origin: "conflict",
      status: c.status,
      text: c.conflict,
      relatedIds: [...c.ids],
      depth: c.depth,
      children: [],
      laterCount: 0,
      askedIn: [],
      view: { question: c.question, recommendation: c.recommendation, basis: c.basis, options: [...c.options] },
    };
    state.agenda.push(item);
  }
  return state;
}

/** The depth of the deepest conflict a Decision settled, 0 for Decisions and facts that settled none. */
function settledConflictDepth(state: ClarifyState, id: string): number {
  const d = state.decisions.find((x) => x.id === id);
  if (!d) return 0;
  return Math.max(0, ...d.resolves.map((r) => findItem(state, r)).filter((i) => i?.origin === "conflict").map((i) => i!.depth));
}

/** What the user sees above a conflict question: each side as it stands. */
export function conflictSides(brief: RequirementBrief, state: ClarifyState, item: AgendaItem): { id: string; text: string; answer?: string }[] {
  return item.relatedIds.map((id) => {
    const d = state.decisions.find((x) => x.id === id);
    if (d) {
      const answer = state.answers.find((a) => a.ref === d.answerRef);
      return { id, text: d.conclusion, ...(answer ? { answer: `${answer.ref}: ${answer.text}` } : {}) };
    }
    const fact = FACT_SECTION_NAMES.flatMap((s) => brief[s] as unknown as Record<string, unknown>[]).find((f) => f.id === id);
    return { id, text: fact ? factText(fact) : id };
  });
}

function factText(fact: Record<string, unknown>): string {
  return Object.entries(fact)
    .filter(([k, v]) => k !== "id" && typeof v === "string" && v)
    .map(([, v]) => v as string)
    .join(" — ");
}

const key = (ids: string[]) => [...ids].sort().join("|");

function yaml(value: unknown): string {
  return stringify(value, { lineWidth: 0 }).trimEnd();
}
