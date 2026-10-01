import { findItem } from "../../clarify/agenda.ts";
import type { ClarifyState, Decision } from "../../clarify/schema.ts";
import { normalize } from "../../extract/evidence.ts";
import type { RequirementBrief } from "../../extract/schema.ts";
import { itemText } from "../score.ts";
import type { AnswerLogEntry } from "./answerer.ts";
import type { ClarifyCase, ExpectedDecision } from "./cases.ts";

export interface ClarifyScore {
  /** Expected Decisions found, as `<label>#<n>` (`<label>/follow-up#<n>` for a follow-up's). */
  interpretation: { hit: string[]; missed: string[] };
  /** Brief items superseded although no label expects them to be. */
  wrongSupersedes: { decision: string; item: string }[];
  followUps: {
    /** Ambiguous labels whose item was followed up. */
    raised: string[];
    /** Ambiguous labels never followed up. */
    missed: string[];
    /** Follow-ups of labels whose Answer was clear. */
    unneeded: { label: string; questions: string[] }[];
  };
  gaps: { raised: string[]; missed: string[] };
  /** Questions no label matched, answered with `unmatchedReply` (conflict questions are counted under `conflicts`). */
  noise: { id: string; question: string }[];
  conflicts: {
    /** Conflict labels surfaced as a question, or settled by the interpreter revising the Decision. */
    handled: string[];
    missed: string[];
    /** Conflict questions no label matched. */
    unneeded: { id: string; question: string }[];
  };
  /** `goodRecommendation` labels whose first recommendation matched. */
  recommendations: { good: string[]; bad: string[] };
  /** Submissions refused for deciding without an Answer (rules 2 and 3). */
  selfAnswerBlocked: number;
  /** Decisions Grounding Review sent back, by verdict, over every attempt (one Decision can count under several). */
  review: { embellished: number; partial: number; offTopic: number };
  rounds: number;
  questionsAsked: number;
  termination?: string;
}

const has = (text: string, keyword: string) => text.includes(normalize(keyword).toLowerCase());
const norm = (text: string) => normalize(text).toLowerCase();

export function scoreClarify(labels: ClarifyCase, brief: RequirementBrief, state: ClarifyState, log: AnswerLogEntry[], selfAnswerBlocked = 0): ClarifyScore {
  const briefItems = new Map(
    Object.entries(brief)
      .filter(([k, v]) => k !== "traceability" && Array.isArray(v))
      .flatMap(([, list]) => (list as { id: string }[]).map((i) => [i.id, i] as const)),
  );
  /** The Brief item at the top of an item's follow-up chain. */
  const root = (id: string): string => {
    let current = findItem(state, id);
    while (current?.parentId) current = findItem(state, current.parentId);
    return current?.id ?? id;
  };
  const followUpsOf = (target: string) => state.agenda.filter((i) => i.kind === "FQ" && i.origin === "follow-up" && root(i.id) === target);

  const linked = (items: Set<string>): Decision[] =>
    state.decisions.filter((d) => d.resolves.some((id) => items.has(id)) || items.has(d.answerRef.split("/")[1] ?? ""));
  const matches = (d: Decision, e: ExpectedDecision, target: string) =>
    e.all.every((k) => has(norm(d.conclusion), k)) &&
    (e.supersedes ?? []).every((group) => d.supersedes.some((id) => group.every((k) => has(itemText(briefItems.get(id)), k)))) &&
    (!e.confirms || d.confirms.includes(target));

  const interpretation = { hit: [] as string[], missed: [] as string[] };
  for (const label of labels.answers) {
    const fqs = followUpsOf(label.target).map((i) => i.id);
    const pools: [string, ExpectedDecision[] | undefined, Set<string>][] = [
      [label.id, label.expectDecisions, new Set([label.target])],
      [`${label.id}/follow-up`, label.followUpReply?.expectDecisions, new Set([label.target, ...fqs])],
    ];
    for (const [name, expected, items] of pools) {
      const candidates = linked(items);
      (expected ?? []).forEach((e, n) => (candidates.some((d) => matches(d, e, label.target)) ? interpretation.hit : interpretation.missed).push(`${name}#${n + 1}`));
    }
  }

  const expectedGroups = labels.answers.flatMap((a) => [...(a.expectDecisions ?? []), ...(a.followUpReply?.expectDecisions ?? [])]).flatMap((e) => e.supersedes ?? []);
  const wrongSupersedes = state.decisions.flatMap((d) =>
    d.supersedes.filter((id) => !expectedGroups.some((group) => group.every((k) => has(itemText(briefItems.get(id)), k)))).map((item) => ({ decision: d.id, item })),
  );

  const followUps = { raised: [] as string[], missed: [] as string[], unneeded: [] as { label: string; questions: string[] }[] };
  for (const label of labels.answers) {
    const fqs = followUpsOf(label.target);
    if (label.ambiguous) (fqs.length ? followUps.raised : followUps.missed).push(label.id);
    else if (fqs.length) followUps.unneeded.push({ label: label.id, questions: fqs.map((i) => `${i.id}「${i.text}」`) });
  }

  const gapItems = state.agenda.filter((i) => i.origin === "gherkin-gap");
  const gaps = { raised: [] as string[], missed: [] as string[] };
  for (const g of labels.gaps ?? []) (gapItems.some((i) => g.relatedIds.every((id) => i.relatedIds.includes(id))) ? gaps.raised : gaps.missed).push(g.id);

  const recommendations = { good: [] as string[], bad: [] as string[] };
  for (const label of labels.answers) {
    if (!label.goodRecommendation) continue;
    const first = log.find((e) => e.role === "target" && e.label === label.id);
    const good = first && label.goodRecommendation.any.some((k) => has(norm(first.recommendation), k));
    (good ? recommendations.good : recommendations.bad).push(label.id);
  }

  return {
    interpretation,
    wrongSupersedes,
    followUps,
    gaps,
    noise: log.filter((e) => e.role === "unmatched" && e.origin !== "conflict").map((e) => ({ id: e.questionId, question: e.question })),
    conflicts: scoreConflicts(labels, state, log),
    recommendations,
    selfAnswerBlocked,
    review: countReviews(state),
    rounds: state.rounds.filter((r) => !r.final).length,
    questionsAsked: log.length,
    ...(state.termination ? { termination: state.termination } : {}),
  };
}

function countReviews(state: ClarifyState): ClarifyScore["review"] {
  const records = state.rounds.flatMap((r) => r.reviews ?? []);
  const count = (v: string) => records.filter((r) => r.verdicts.some((x) => x === v)).length;
  return { embellished: count("embellished"), partial: count("partial"), offTopic: count("off-topic") };
}

function scoreConflicts(labels: ClarifyCase, state: ClarifyState, log: AnswerLogEntry[]): ClarifyScore["conflicts"] {
  const revised = state.decisions.flatMap((d) => d.revises).map((id) => state.decisions.find((d) => d.id === id)?.conclusion ?? "");
  const handled: string[] = [];
  const missed: string[] = [];
  for (const c of labels.conflicts ?? []) {
    const asked = log.some((e) => e.role === "conflict" && e.label === c.id);
    const fixed = revised.some((text) => c.any.some((k) => has(norm(text), k)));
    (asked || fixed ? handled : missed).push(c.id);
  }
  const unneeded = log.filter((e) => e.origin === "conflict" && e.role === "unmatched").map((e) => ({ id: e.questionId, question: e.question }));
  return { handled, missed, unneeded };
}
