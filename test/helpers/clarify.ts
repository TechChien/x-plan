import { createState, recordAnswers, type UserInput } from "../../src/clarify/agenda.ts";
import { applyRound, markAsked } from "../../src/clarify/apply.ts";
import type { AcceptedRound, ClarifyState, Decision, Prepared } from "../../src/clarify/schema.ts";
import { returnsBrief } from "./brief.ts";

export const meta = { via: "test", at: "2026-09-30T00:00:00.000Z" };

export const prep = (id: string, extra: Partial<Prepared> = {}): Prepared => ({
  id,
  question: `${id}？`,
  recommendation: `建議 ${id}`,
  basis: "convention",
  options: [],
  ...extra,
});

export const dec = (id: string, answerRef: string, resolves: string[], extra: Partial<Decision> = {}): Decision => ({
  id,
  round: 0,
  status: "active",
  answerRef,
  resolves,
  conclusion: `結論 ${id}`,
  supersedes: [],
  confirms: [],
  revises: [],
  relatedIds: [],
  ...extra,
});

export const accepted = (extra: Partial<AcceptedRound> = {}): AcceptedRound => ({ decisions: [], followUps: [], prepared: [], ...extra });

/** Round `n` prepares and asks `ids`. */
export function ask(state: ClarifyState, ids: string[], extra: Partial<AcceptedRound> = {}): ClarifyState {
  const n = state.rounds.length + 1;
  const applied = applyRound(state, { n, final: false, prepare: ids, accepted: accepted({ prepared: ids.map((id) => prep(id)), ...extra }), ordering: "test" });
  const followUpIds = applied.agenda.filter((i) => i.kind === "FQ" && i.status === "pending").map((i) => i.id);
  return markAsked(applied, [...followUpIds, ...ids], "test");
}

/** Round 1 asks CTR-1, OQ-1, OQ-2 and OQ-3; the user answers CTR-1 and OQ-3, accepts OQ-2 and puts OQ-1 off. */
export function afterRoundOne(): ClarifyState {
  const inputs: UserInput[] = [
    { type: "response", itemId: "CTR-1", kind: "text", text: "以 7 天為準，3 天是舊版；VIP 是 14 天" },
    { type: "response", itemId: "OQ-1", kind: "later", text: "" },
    { type: "response", itemId: "OQ-2", kind: "accept", text: "" },
    { type: "response", itemId: "OQ-3", kind: "text", text: "鑑賞期就是 7 天那個" },
  ];
  return recordAnswers(ask(createState(returnsBrief(), "sha", "zh"), ["CTR-1", "OQ-1", "OQ-2", "OQ-3"]), inputs, meta);
}
