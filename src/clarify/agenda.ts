import type { RequirementBrief } from "../extract/schema.ts";
import type { OutputLanguage } from "../shared/language.ts";
import { CLARIFY_LIMITS, hasContent, isTerminal, type AgendaItem, type Answer, type ClarifyState, type ResponseKind } from "./schema.ts";

/** One thing the user entered while answering a batch. */
export type UserInput =
  | { type: "response"; itemId: string; kind: ResponseKind; text: string }
  | { type: "note"; text: string; target?: string }
  | { type: "done" };

export function createState(brief: RequirementBrief, briefSha256: string, outputLanguage: OutputLanguage): ClarifyState {
  const base = { origin: "brief" as const, status: "pending" as const, depth: 0, children: [], laterCount: 0, askedIn: [] };
  return {
    version: 1,
    briefSha256,
    outputLanguage,
    agenda: [
      ...brief.openQuestions.map((q): AgendaItem => ({ ...base, id: q.id, kind: "OQ", text: q.question, severity: q.severity, relatedIds: [...q.relatedIds] })),
      ...brief.contradictions.map((c): AgendaItem => ({ ...base, id: c.id, kind: "CTR", text: c.conflict, relatedIds: [...c.relatedIds] })),
      ...brief.assumptions.map((a): AgendaItem => ({ ...base, id: a.id, kind: "ASM", text: a.assumption, confidence: a.confidence, relatedIds: [...a.relatedIds] })),
    ].map((i) => ({ ...i, children: [], askedIn: [] })),
    answers: [],
    decisions: [],
    rounds: [],
    rejected: [],
    phase: "interpret",
    doneRequested: false,
  };
}

export function item(state: ClarifyState, id: string): AgendaItem {
  const found = state.agenda.find((i) => i.id === id);
  if (!found) throw new Error(`Unknown Agenda Item ${id}`);
  return found;
}

export function findItem(state: ClarifyState, id: string): AgendaItem | undefined {
  return state.agenda.find((i) => i.id === id);
}

/** Items that are not finished: they still need an Answer or a Decision. */
export function openItems(state: ClarifyState): AgendaItem[] {
  return state.agenda.filter((i) => !isTerminal(i.status));
}

/** The Answer with content a Decision on `itemId` would be drawn from. */
export function contentAnswer(state: ClarifyState, itemId: string): Answer | undefined {
  return state.answers.findLast((a) => a.itemId === itemId && hasContent(a.kind));
}

/** Why an input cannot be recorded, or undefined when it can. Answerers use it to re-prompt instead of failing. */
export function inputError(state: ClarifyState, input: UserInput): string | undefined {
  if (input.type === "response") {
    const it = findItem(state, input.itemId);
    if (it?.status !== "asked") return `${input.itemId} was not asked in this round`;
    if (input.kind === "text" && !input.text.trim()) return "an answer cannot be empty";
  }
  if (input.type === "note") {
    if (!input.text.trim()) return "a note cannot be empty";
    if (input.target && !findItem(state, input.target) && !state.decisions.some((d) => d.id === input.target)) {
      return `${input.target} is neither an Agenda Item nor a Decision`;
    }
  }
  return undefined;
}

/** Records what the user entered for the current round's batch. Pure: returns a new state. */
export function recordAnswers(current: ClarifyState, inputs: UserInput[], meta: { via: string; at: string }): ClarifyState {
  const state = structuredClone(current);
  const round = state.rounds.at(-1)?.n;
  if (round === undefined) throw new Error("No round has been asked yet");
  const answer = (it: AgendaItem, kind: ResponseKind, text: string) =>
    state.answers.push({ ref: `R${round}/${it.id}`, itemId: it.id, round, kind, text, ...meta });

  for (const input of inputs) {
    const error = inputError(state, input);
    if (error) throw new Error(error);
    if (input.type === "done") {
      state.doneRequested = true;
    } else if (input.type === "note") {
      const id = `NOTE-${state.agenda.filter((i) => i.kind === "NOTE").length + 1}`;
      const note: AgendaItem = { id, kind: "NOTE", origin: "user", status: "answered", text: input.text, relatedIds: [], depth: 0, children: [], laterCount: 0, askedIn: [round] };
      if (input.target) note.target = input.target;
      state.agenda.push(note);
      answer(note, "text", input.text);
    } else {
      const it = item(state, input.itemId);
      if (input.kind === "accept") {
        if (!it.view) throw new Error(`${it.id} has no recommendation to accept`);
        answer(it, "accept", it.view.recommendation);
        it.status = "answered";
      } else {
        answer(it, input.kind, input.text);
        if (input.kind === "text") it.status = "answered";
        if (input.kind === "defer") it.status = "deferred";
        if (input.kind === "na") it.status = "dismissed";
        if (input.kind === "later") {
          it.laterCount++;
          it.status = it.laterCount >= CLARIFY_LIMITS.maxLater ? "deferred" : "pending";
        }
      }
    }
  }
  state.phase = "interpret";
  return settle(state);
}

/**
 * A followed-up item whose follow-ups have all ended without a Decision closing it goes back to "answered":
 * its own Answer still has to become a Decision, and rule 1 of the round check then forces that.
 */
export function settle(current: ClarifyState): ClarifyState {
  const state = structuredClone(current);
  for (const it of state.agenda) {
    if (it.status === "followed-up" && it.children.every((c) => isTerminal(item(state, c).status))) it.status = "answered";
  }
  return state;
}

/** Ends the Run: every item still open becomes unresolved. */
export function close(current: ClarifyState, termination: NonNullable<ClarifyState["termination"]>): ClarifyState {
  const state = structuredClone(current);
  for (const it of state.agenda) if (!isTerminal(it.status)) it.status = "unresolved";
  state.phase = "closed";
  state.termination = termination;
  return state;
}

/** Ancestors of an item through `parentId`, nearest first. */
export function ancestors(state: ClarifyState, id: string): string[] {
  const chain: string[] = [];
  let parent = findItem(state, id)?.parentId;
  while (parent) {
    chain.push(parent);
    parent = findItem(state, parent)?.parentId;
  }
  return chain;
}

/** `OQ-2` < `OQ-10`. */
export function compareIds(a: string, b: string): number {
  const [pa, na] = splitId(a);
  const [pb, nb] = splitId(b);
  return pa === pb ? na - nb : pa.localeCompare(pb);
}

function splitId(id: string): [string, number] {
  const match = /^(.*?)-(\d+)$/.exec(id);
  return match ? [match[1] as string, Number(match[2])] : [id, 0];
}
