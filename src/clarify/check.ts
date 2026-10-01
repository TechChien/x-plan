import { FACT_SECTION_NAMES, type RequirementBrief } from "../extract/schema.ts";
import { languageErrors, type OutputLanguage } from "../shared/language.ts";
import { ancestors, contentAnswer, findItem } from "./agenda.ts";
import {
  awaitsInterpretation,
  isTerminal,
  type AcceptedFollowUp,
  type AcceptedRound,
  type ClarifyRejected,
  type ClarifyState,
  type Decision,
  type DecisionOp,
  type FinalSubmission,
  type FollowUp,
  type Prepared,
  type RoundSubmission,
} from "./schema.ts";

export interface RoundCheckContext {
  brief: RequirementBrief;
  round: number;
  /** Items the orderer assigned for preparation; empty in the closing round. */
  prepare: string[];
  /** The closing round: followed-up items must be decided too, and nothing can be asked. */
  final: boolean;
  /** No retry is left: accept what is usable. */
  isLast: boolean;
  language: OutputLanguage;
  limits: { batchSize: number; maxGapsPerRound: number; maxFollowUpDepth: number };
  /** Answered items Grounding Review found nothing to decide on and that cannot be asked again: they may stay undecided. */
  leaveOpen?: ReadonlySet<string>;
}

export interface RoundIssue {
  /** `decisions[0]`, `followUps[1]`, `prepared[2]` or `round`. */
  path: string;
  errors: string[];
}

export interface RoundCheckResult {
  /** Everything wrong with the submission, language included: the feedback for a retry. */
  issues: RoundIssue[];
  /** The usable part: items without errors other than language. */
  accepted: AcceptedRound;
  rejected: ClarifyRejected[];
  /** Accepted items still in the wrong language. */
  languageWarnings: string[];
}

/**
 * Validates one round's submission against the state (ADR 0007): every Decision stands on a real Answer, only
 * answered items are closed, no Answer is left uninterpreted, and the assigned items are prepared exactly.
 */
export function checkRound(state: ClarifyState, submission: RoundSubmission | FinalSubmission, ctx: RoundCheckContext): RoundCheckResult {
  const issues: RoundIssue[] = [];
  const rejected: ClarifyRejected[] = [];
  const languageWarnings: string[] = [];
  const report = (path: string, errors: string[]) => errors.length && issues.push({ path, errors });

  const briefIds = collectBriefIds(ctx.brief);
  const factIds = new Set(FACT_SECTION_NAMES.flatMap((s) => ctx.brief[s].map((i) => i.id)));
  const asmIds = new Set(ctx.brief.assumptions.map((a) => a.id));
  const knownIds = new Set([...briefIds, ...state.agenda.map((i) => i.id), ...state.decisions.map((d) => d.id)]);
  /** Items whose Answer is interpreted in this round. */
  const interpreting = state.agenda.filter((i) => i.status === "answered" || (ctx.final && i.status === "followed-up")).map((i) => i.id);
  const interpretingSet = new Set(interpreting);
  const active = state.decisions.filter((d) => d.status === "active");

  /** Checks one item's language; returns true when it is wrong. */
  const wrongLanguage = (path: string, value: unknown): boolean => {
    const errors = languageErrors(value, ctx.language);
    report(path, errors);
    return errors.length > 0;
  };

  // Decisions.
  let nextDec = nextDecisionNumber(state);
  const decisions = submission.decisions.map((op, i) => ({ op, index: i, id: `DEC-${nextDec++}`, errors: [] as string[], wrongLanguage: false }));
  const revisedHere = new Set(decisions.flatMap((d) => d.op.revises));
  const supersededBy = new Map<string, string>();
  for (const d of active) if (!revisedHere.has(d.id)) for (const id of d.supersedes) supersededBy.set(id, d.id);

  for (const d of decisions) {
    d.errors.push(...decisionErrors(state, d.op, { interpretingSet, factIds, asmIds, knownIds, supersededBy, active }));
    d.wrongLanguage = languageErrors({ conclusion: d.op.conclusion }, ctx.language).length > 0;
  }

  // Rule 5: every contradiction or conflict closed here is settled explicitly by at least one of its Decisions:
  // one side superseded (a Brief fact) or revised (a Decision), or every side named to state when each applies.
  const isConflict = (id: string) => findItem(state, id)?.kind === "CTR" || findItem(state, id)?.origin === "conflict";
  for (const ctrId of new Set(decisions.flatMap((d) => d.op.resolves.filter(isConflict)))) {
    const sides = findItem(state, ctrId)?.relatedIds ?? [];
    const onIt = decisions.filter((d) => !d.errors.length && d.op.resolves.includes(ctrId));
    const replaced = (d: (typeof decisions)[number]) => [...d.op.supersedes, ...d.op.revises];
    const settled = onIt.some((d) => replaced(d).some((id) => sides.includes(id)) || sides.every((id) => d.op.relatedIds.includes(id) || replaced(d).includes(id)));
    if (!settled && onIt.length) {
      for (const d of onIt) {
        d.errors.push(
          `resolves ${ctrId} but no Decision on it supersedes (Brief facts) or revises (Decisions) one side (${sides.join(", ")}), or names every side in relatedIds to state when each applies`,
        );
      }
    }
  }

  for (const d of decisions) {
    report(`decisions[${d.index}]`, d.errors);
    wrongLanguage(`decisions[${d.index}]`, { conclusion: d.op.conclusion });
  }
  const okDecisions = decisions.filter((d) => !d.errors.length);
  const acceptedDecisions: Decision[] = okDecisions.map((d) => ({ ...d.op, id: d.id, round: ctx.round, status: "active" }));
  for (const d of okDecisions) if (d.wrongLanguage) languageWarnings.push(`decisions[${d.index}]`);
  for (const d of decisions) if (d.errors.length) rejected.push({ round: ctx.round, kind: "decision", item: { id: d.id, ...d.op }, errors: d.errors });

  // Follow-ups and prepared questions (not in the closing round).
  const followUps: AcceptedFollowUp[] = [];
  const prepared: Prepared[] = [];
  if ("followUps" in submission) {
    let nextFq = nextNumber(state.agenda.filter((i) => i.kind === "FQ").map((i) => i.id));
    let gaps = 0;
    submission.followUps.forEach((f, i) => {
      const errors = followUpErrors(state, f, { interpretingSet, factIds, knownIds, limits: ctx.limits });
      if (f.origin === "gherkin-gap" && ++gaps > ctx.limits.maxGapsPerRound) errors.push(`at most ${ctx.limits.maxGapsPerRound} gherkin-gap questions per round`);
      if (i >= ctx.limits.batchSize) errors.push(`at most ${ctx.limits.batchSize} follow-up questions per round`);
      report(`followUps[${i}]`, errors);
      const badLanguage = wrongLanguage(`followUps[${i}]`, questionFields(f));
      if (errors.length) rejected.push({ round: ctx.round, kind: "followUp", item: f, errors });
      else {
        followUps.push({ ...f, id: `FQ-${nextFq++}` });
        if (badLanguage) languageWarnings.push(`followUps[${i}]`);
      }
    });

    const assigned = new Set(ctx.prepare);
    const coverable = new Set([...active.map((d) => d.id), ...acceptedDecisions.map((d) => d.id)]);
    const seen = new Set<string>();
    submission.prepared.forEach((p, i) => {
      const errors: string[] = [];
      if (!assigned.has(p.id)) errors.push(`${p.id} was not assigned in <prepare>`);
      else if (seen.has(p.id)) errors.push(`${p.id} is prepared twice`);
      seen.add(p.id);
      const badCover = p.coveredBy !== undefined && !coverable.has(p.coveredBy);
      const coverError = badCover ? [`coveredBy ${p.coveredBy} is not an active or accepted Decision`] : [];
      report(`prepared[${i}]`, [...errors, ...coverError]);
      const badLanguage = wrongLanguage(`prepared[${i}]`, questionFields(p));
      if (errors.length) rejected.push({ round: ctx.round, kind: "prepared", item: p, errors });
      else {
        const { coveredBy: _, ...rest } = p;
        prepared.push(badCover ? rest : p);
        if (badLanguage) languageWarnings.push(`prepared[${i}]`);
      }
    });
    const missing = ctx.prepare.filter((id) => !seen.has(id));
    report("round", missing.map((id) => `prepared is missing ${id}`));
  }

  // Rule 1: every Answer being interpreted is resolved or followed up, unless Grounding Review left it open.
  const resolved = new Set(acceptedDecisions.flatMap((d) => d.resolves));
  const followedUp = new Set(followUps.flatMap((f) => (f.parentId ? [f.parentId] : [])));
  const leftOpen = interpreting.filter((id) => ctx.leaveOpen?.has(id) && !resolved.has(id) && !followedUp.has(id));
  report(
    "round",
    interpreting
      .filter((id) => !resolved.has(id) && !followedUp.has(id) && !leftOpen.includes(id))
      .map((id) => `${contentAnswer(state, id)?.ref ?? id} (the Answer to ${id}) is neither resolved by a Decision nor followed up`),
  );

  // Rule 8: a followed-up item whose follow-ups all finish here must be closed here too.
  if (!ctx.final) {
    const finishedNow = (id: string) => resolved.has(id) || isTerminal(findItem(state, id)?.status ?? "pending");
    const stuck = state.agenda.filter(
      (i) => i.status === "followed-up" && !resolved.has(i.id) && !followedUp.has(i.id) && i.children.every(finishedNow) && i.children.some((c) => resolved.has(c)),
    );
    report(
      "round",
      stuck.map((i) => `all follow-ups of ${i.id} are finished but no Decision resolves ${i.id}: add it to the resolves of the Decision that finishes them`),
    );
  }

  return { issues, accepted: { decisions: acceptedDecisions, followUps, prepared, ...(leftOpen.length ? { leftOpen } : {}) }, rejected, languageWarnings };
}

export function formatRoundIssues(issues: RoundIssue[]): string {
  return issues.map((i) => `- ${i.path}:\n${i.errors.map((e) => `    - ${e}`).join("\n")}`).join("\n");
}

interface DecisionContext {
  interpretingSet: Set<string>;
  factIds: Set<string>;
  asmIds: Set<string>;
  knownIds: Set<string>;
  supersededBy: Map<string, string>;
  active: Decision[];
}

function decisionErrors(state: ClarifyState, op: DecisionOp, c: DecisionContext): string[] {
  const errors: string[] = [];
  if (!op.conclusion.trim()) errors.push("conclusion is empty");

  // Rule 2: the Decision stands on an Answer with content that is being interpreted now.
  const answer = state.answers.find((a) => a.ref === op.answerRef);
  const answered = answer && contentAnswer(state, answer.itemId) === answer ? answer : undefined;
  if (!answered || !c.interpretingSet.has(answered.itemId)) {
    errors.push(`answerRef ${op.answerRef} is not an Answer awaiting interpretation; use a ref from <pending-answers>`);
  }

  // Rule 3: only the answered item, the items it follows up, or a note's target can be closed.
  if (answered) {
    const it = findItem(state, answered.itemId);
    const allowed = new Set([answered.itemId, ...ancestors(state, answered.itemId)]);
    if (it?.kind === "NOTE" && it.target && findItem(state, it.target)) allowed.add(it.target);
    for (const id of op.resolves) {
      const target = findItem(state, id);
      if (!target) errors.push(`resolves ${id}, which is not an Agenda Item`);
      else if (target.status === "decided") errors.push(`resolves ${id}, which is already decided; revise its Decision instead`);
      else if (!allowed.has(id)) {
        errors.push(
          awaitsInterpretation(target.status)
            ? `resolves ${id}, but ${id} is not the item ${op.answerRef} answers or one it follows up`
            : `resolves ${id}, but ${id} has no Answer; if an earlier Answer covers it, mark it coveredBy in prepared and let the user confirm`,
        );
      }
    }
  }

  // Rule 4: references.
  for (const id of op.supersedes) {
    if (!c.factIds.has(id) && !c.asmIds.has(id)) errors.push(`supersedes ${id}, which is not a fact or assumption in the Brief`);
    else if (c.supersededBy.has(id)) errors.push(`supersedes ${id}, already superseded by ${c.supersededBy.get(id)}; revise ${c.supersededBy.get(id)} instead`);
  }
  for (const id of op.confirms) {
    if (!c.asmIds.has(id)) errors.push(`confirms ${id}, which is not an assumption in the Brief`);
    else if (c.supersededBy.has(id)) errors.push(`confirms ${id}, which ${c.supersededBy.get(id)} superseded`);
  }
  for (const id of op.revises) if (!c.active.some((d) => d.id === id)) errors.push(`revises ${id}, which is not an active Decision`);
  for (const id of op.relatedIds) if (!c.knownIds.has(id)) errors.push(`relatedIds ${id} does not exist`);
  return errors;
}

interface FollowUpContext {
  interpretingSet: Set<string>;
  factIds: Set<string>;
  knownIds: Set<string>;
  limits: RoundCheckContext["limits"];
}

function followUpErrors(state: ClarifyState, f: FollowUp, c: FollowUpContext): string[] {
  const errors: string[] = [];
  if (f.origin === "follow-up") {
    if (!f.parentId) errors.push("a follow-up needs parentId: the item whose Answer it follows up");
    else if (!c.interpretingSet.has(f.parentId)) errors.push(`parentId ${f.parentId} has no Answer being interpreted in this round`);
    else {
      const parent = findItem(state, f.parentId);
      if (parent && parent.depth + 1 > c.limits.maxFollowUpDepth) {
        errors.push(`${f.parentId} is already a follow-up of a follow-up; decide on the Answer you have instead of asking again`);
      }
    }
  } else {
    if (f.parentId) errors.push("a gherkin-gap question has no parentId; name the facts in relatedIds");
    if (!f.relatedIds.some((id) => c.factIds.has(id))) errors.push("a gherkin-gap question must name the facts it concerns in relatedIds");
  }
  for (const id of f.relatedIds) if (!c.knownIds.has(id)) errors.push(`relatedIds ${id} does not exist`);
  return errors;
}

function questionFields(q: { question: string; recommendation: string; options: string[] }) {
  return { question: q.question, recommendation: q.recommendation, options: q.options };
}

function collectBriefIds(brief: RequirementBrief): Set<string> {
  const ids = new Set<string>();
  for (const [key, list] of Object.entries(brief)) {
    if (key === "traceability" || !Array.isArray(list)) continue;
    for (const entry of list as { id?: unknown }[]) if (typeof entry.id === "string") ids.add(entry.id);
  }
  return ids;
}

/** Decisions are numbered after every id used so far, rejected ones included, so an id never means two things. */
export function nextDecisionNumber(state: ClarifyState): number {
  return nextNumber([...state.decisions.map((d) => d.id), ...state.rejected.filter((r) => r.kind === "decision").map((r) => idOf(r.item))]);
}

function idOf(item: unknown): string {
  return item && typeof item === "object" && "id" in item && typeof item.id === "string" ? item.id : "";
}

/** 1 + the highest number among `ids` of the form `<PREFIX>-<n>`. */
function nextNumber(ids: string[]): number {
  return 1 + Math.max(0, ...ids.map((id) => Number(/-(\d+)$/.exec(id)?.[1] ?? 0)));
}
