import type { RequirementBrief } from "../extract/schema.ts";
import { close, createState, item, recordAnswers, settle, type UserInput } from "./agenda.ts";
import { restoreConflicts } from "./consistency.ts";
import type { AcceptedRound, AgendaItem, Answer, ClarifyState, Prepared, QuestionView, ReviewRecord } from "./schema.ts";

export interface RoundInput {
  n: number;
  final: boolean;
  /** Items the orderer assigned for preparation. */
  prepare: string[];
  /** The part of the submission that passed the check. */
  accepted: AcceptedRound;
  /** The orderer's rationale for `prepare`. */
  ordering: string;
  /** Grounding Review's findings for this round. */
  reviews?: ReviewRecord[];
}

/** Applies one round's accepted submission. Pure: returns a new state. */
export function applyRound(current: ClarifyState, input: RoundInput): ClarifyState {
  const state = structuredClone(current);
  const decisions = input.accepted.decisions.map(({ revisedBy: _, ...d }) => ({ ...d, round: input.n, status: "active" as const }));

  for (const decision of decisions) {
    state.decisions.push(decision);
    for (const id of decision.revises) {
      const old = state.decisions.find((d) => d.id === id);
      if (!old) throw new Error(`${decision.id} revises unknown ${id}`);
      old.status = "revised";
      old.revisedBy = decision.id;
    }
    for (const id of decision.resolves) {
      const it = item(state, id);
      it.status = "decided";
      it.resolvedBy = [...(it.resolvedBy ?? []), decision.id];
    }
  }

  for (const f of input.accepted.followUps) {
    const parent = f.parentId ? item(state, f.parentId) : undefined;
    const fq: AgendaItem = {
      id: f.id,
      kind: "FQ",
      origin: f.origin,
      status: "pending",
      text: f.question,
      relatedIds: [...f.relatedIds],
      depth: parent ? parent.depth + 1 : 0,
      children: [],
      laterCount: 0,
      askedIn: [],
      view: viewOf(f),
    };
    if (parent) {
      fq.parentId = parent.id;
      parent.children.push(f.id);
      if (parent.status === "answered") parent.status = "followed-up";
    }
    state.agenda.push(fq);
  }

  for (const p of input.accepted.prepared) item(state, p.id).view = viewOf(p);
  for (const id of input.accepted.leftOpen ?? []) item(state, id).status = "unresolved";

  state.rounds.push({
    n: input.n,
    final: input.final,
    prepare: [...input.prepare],
    accepted: structuredClone({ ...input.accepted, decisions }),
    asked: [],
    ordering: { prepare: input.ordering, batch: "" },
    ...(input.reviews ? { reviews: structuredClone(input.reviews) } : {}),
  });
  return settle(state);
}

/** Shows `ids` to the user as the latest round's batch. An empty batch goes straight on to the next round. */
export function markAsked(current: ClarifyState, ids: string[], rationale: string): ClarifyState {
  const state = structuredClone(current);
  const round = state.rounds.at(-1);
  if (!round) throw new Error("No round to ask in");
  for (const id of ids) {
    const it = item(state, id);
    if (it.status !== "pending" || !it.view) throw new Error(`${id} cannot be asked: it is ${it.status}${it.view ? "" : " and has no prepared question"}`);
    it.status = "asked";
    it.askedIn.push(round.n);
    round.asked.push({ id, ...structuredClone(it.view) });
  }
  round.ordering.batch = rationale;
  state.phase = ids.length ? "answer" : "interpret";
  return state;
}

/**
 * Rebuilds a state from the Brief, its recorded rounds and Answers. The live state must always equal its replay:
 * the Agenda is derived data, the rounds and Answers are the record.
 */
export function replay(brief: RequirementBrief, recorded: ClarifyState): ClarifyState {
  let state = createState(brief, recorded.briefSha256, recorded.outputLanguage);
  if (recorded.source) state.source = structuredClone(recorded.source);
  for (const round of recorded.rounds) {
    state = applyRound(state, {
      n: round.n,
      final: round.final,
      prepare: round.prepare,
      accepted: round.accepted,
      ordering: round.ordering.prepare,
      ...(round.reviews ? { reviews: round.reviews } : {}),
    });
    if (round.conflicts) state = restoreConflicts(state, round.conflicts);
    if (round.final) continue;
    state = markAsked(state, round.asked.map((q) => q.id), round.ordering.batch);
    for (const answer of recorded.answers.filter((a) => a.round === round.n)) {
      state = recordAnswers(state, [inputOf(answer)], { via: answer.via, at: answer.at });
    }
  }
  if (recorded.phase === "closed" && recorded.termination) state = close(state, recorded.termination);
  state.rejected = structuredClone(recorded.rejected);
  state.doneRequested = recorded.doneRequested;
  return state;
}

function inputOf(answer: Answer): UserInput {
  if (answer.itemId.startsWith("NOTE-")) return { type: "note", text: answer.text, ...(answer.target ? { target: answer.target } : {}) };
  return { type: "response", itemId: answer.itemId, kind: answer.kind, text: answer.text };
}

function viewOf(q: Omit<Prepared, "id"> & { id?: string }): QuestionView {
  const view: QuestionView = { question: q.question, recommendation: q.recommendation, basis: q.basis, options: [...q.options] };
  if (q.coveredBy) view.coveredBy = q.coveredBy;
  return view;
}
