import { Type, type Static } from "typebox";
import { stringify } from "yaml";
import type { Evidence, RequirementBrief } from "../extract/schema.ts";
import type { PromptLibrary } from "../prompts/template.ts";
import type { BuiltPrompt } from "../shared/run-files.ts";
import { ancestors, contentAnswer, findItem } from "./agenda.ts";
import { nextDecisionNumber, type RoundCheckResult, type RoundIssue } from "./check.ts";
import type { AcceptedFollowUp, Answer, ClarifyState, Decision, ReviewRecord, ReviewVerdict } from "./schema.ts";

/**
 * Grounding Review (ADR 0011): a second agent checks every Decision the interpreter submits against the Answers it
 * stands on, before the Decision is written. It only reports; the interpreter rewrites, so interpreting Answers
 * stays one role's job.
 */

const Str = (description: string) => Type.String({ description });

const ClaimSource = Type.Union(
  [Type.Literal("answer"), Type.Literal("entailed"), Type.Literal("recommendation"), Type.Literal("brief"), Type.Literal("decision"), Type.Literal("none")],
  { description: "Where the claim comes from; see the Process for each value" },
);

export const ReviewSubmissionSchema = Type.Object(
  {
    reviews: Type.Array(
      Type.Object(
        {
          decision: Str("The id of the Decision in <review>, e.g. decisions[0]"),
          claims: Type.Array(Type.Object({ text: Str("One statement of the conclusion, in its own words"), source: ClaimSource }, { additionalProperties: false }), {
            minItems: 1,
          }),
          addressesQuestion: Type.Boolean({ description: "false only when the Answer is about something else entirely" }),
          unanswered: Type.Array(Type.String(), { description: "Parts of the questions in resolves that no listed Answer settles; empty when all are settled" }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ReviewSubmission = Static<typeof ReviewSubmissionSchema>;

/** A Decision the interpreter submitted, as accepted by the round check, with its place in the submission. */
export interface UnderReview {
  path: string;
  decision: Decision;
}

/** The accepted Decisions with their paths: the check numbers Decisions in submission order from the next free id. */
export function underReview(state: ClarifyState, decisions: Decision[]): UnderReview[] {
  const first = nextDecisionNumber(state);
  return decisions.map((d) => ({ path: `decisions[${Number(d.id.slice("DEC-".length)) - first}]`, decision: d }));
}

export function buildReviewPrompt(lib: PromptLibrary, brief: RequirementBrief, state: ClarifyState, items: UnderReview[]): BuiltPrompt {
  return {
    systemPrompt: lib.render("clarify/review.system", {}),
    userMessage: lib.render("clarify/review.user", { review: reviewToYaml(brief, state, items) }),
  };
}

/** Everything the reviewer may count as a source, and nothing else: no log, no other questions. */
export function reviewToYaml(brief: RequirementBrief, state: ClarifyState, items: UnderReview[]): string {
  const answers = new Map<string, Answer>();
  const questionIds = new Set<string>();
  const briefIds = new Set<string>();
  const add = (a: Answer | undefined) => a && answers.set(a.ref, a);

  for (const { decision: d } of items) {
    const answer = state.answers.find((a) => a.ref === d.answerRef);
    add(answer);
    if (answer) {
      for (const id of ancestors(state, answer.itemId)) add(contentAnswer(state, id));
      if (answer.target) add(contentAnswer(state, answer.target));
    }
    for (const id of d.resolves) questionIds.add(id);
    for (const id of [...d.supersedes, ...d.confirms, ...d.relatedIds, ...d.resolves.flatMap((id) => findItem(state, id)?.relatedIds ?? [])]) briefIds.add(id);
  }
  const answered = new Set([...answers.values()].map((a) => a.itemId));

  return yaml({
    decisions: items.map(({ path, decision: d }) => ({
      id: path,
      answerRef: d.answerRef,
      resolves: d.resolves,
      conclusion: d.conclusion,
      ...(d.supersedes.length ? { supersedes: d.supersedes } : {}),
      ...(d.confirms.length ? { confirms: d.confirms } : {}),
      ...(d.revises.length ? { revises: d.revises } : {}),
    })),
    answers: [...answers.values()].map((a) => answerView(state, a)),
    ...([...questionIds].some((id) => !answered.has(id))
      ? { questions: [...questionIds].filter((id) => !answered.has(id)).map((id) => ({ item: id, question: shownQuestion(state, id).question })) }
      : {}),
    ...(briefIds.size ? { brief: briefItems(brief, briefIds) } : {}),
    ...(state.decisions.some((d) => d.status === "active")
      ? { decided: state.decisions.filter((d) => d.status === "active").map((d) => ({ id: d.id, conclusion: d.conclusion })) }
      : {}),
  });
}

function answerView(state: ClarifyState, a: Answer) {
  const it = findItem(state, a.itemId);
  if (it?.kind === "NOTE") return { ref: a.ref, item: a.itemId, note: true, ...(a.target ? { about: a.target } : {}), kind: a.kind, answer: a.text };
  const shown = shownQuestion(state, a.itemId, a.round);
  return {
    ref: a.ref,
    item: a.itemId,
    ...(it?.parentId ? { followsUp: it.parentId } : {}),
    question: shown.question,
    recommendation: shown.recommendation,
    ...(shown.options.length ? { options: shown.options } : {}),
    kind: a.kind,
    answer: a.text,
  };
}

/** The question as the user saw it in `round`, else as last prepared, else the item's own text. */
function shownQuestion(state: ClarifyState, id: string, round?: number): { question: string; recommendation: string; options: string[] } {
  const asked = state.rounds.find((r) => r.n === round)?.asked.find((q) => q.id === id);
  const view = asked ?? findItem(state, id)?.view;
  return view ? { question: view.question, recommendation: view.recommendation, options: view.options } : { question: findItem(state, id)?.text ?? id, recommendation: "", options: [] };
}

function briefItems(brief: RequirementBrief, ids: Set<string>): unknown[] {
  const out: unknown[] = [];
  for (const [section, list] of Object.entries(brief)) {
    if (section === "traceability" || !Array.isArray(list)) continue;
    for (const entry of list as Record<string, unknown>[]) {
      if (typeof entry.id !== "string" || !ids.has(entry.id)) continue;
      const { evidence, ...rest } = entry;
      out.push({ ...rest, ...(Array.isArray(evidence) && evidence.length ? { evidence: (evidence as Evidence[]).map((e) => e.quote) } : {}) });
    }
  }
  return out;
}

/** Errors that make the reviewer resubmit: every Decision reviewed exactly once. */
export function reviewErrors(submission: ReviewSubmission, items: UnderReview[]): string[] {
  const paths = new Set(items.map((i) => i.path));
  const seen = new Map<string, number>();
  for (const r of submission.reviews) seen.set(r.decision, (seen.get(r.decision) ?? 0) + 1);
  return [
    ...[...seen.keys()].filter((p) => !paths.has(p)).map((p) => `${p} is not a Decision in <review>`),
    ...[...seen.entries()].filter(([, n]) => n > 1).map(([p]) => `${p} is reviewed more than once`),
    ...items.filter((i) => !seen.has(i.path)).map((i) => `${i.path} has no review`),
  ];
}

export interface ReviewOutcome {
  /** Feedback for the interpreter, one issue per Decision that cannot stand as submitted. */
  issues: RoundIssue[];
  /** Paths of those Decisions. */
  flagged: Set<string>;
  /** Answered items that get no Decision and cannot be asked again. */
  leaveOpen: Set<string>;
  records: ReviewRecord[];
}

export interface JudgeContext {
  attempt: number;
  /** The closing round: nothing can be asked. */
  final: boolean;
  maxFollowUpDepth: number;
  /** Follow-ups accepted in the same submission. */
  followUps: AcceptedFollowUp[];
}

/**
 * Turns the reviewer's findings into verdicts. What may be asked again decides how a gap is handled: an Answer
 * that misses its question, or settles only part of it, becomes a follow-up when one is still possible; otherwise
 * the Decision keeps only what the user said, and an off-topic Answer leaves its item unresolved.
 */
export function judgeReview(state: ClarifyState, items: UnderReview[], submission: ReviewSubmission, ctx: JudgeContext): ReviewOutcome {
  const outcome: ReviewOutcome = { issues: [], flagged: new Set(), leaveOpen: new Set(), records: [] };
  for (const { path, decision: d } of items) {
    const review = submission.reviews.find((r) => r.decision === path);
    if (!review) continue;
    const answer = state.answers.find((a) => a.ref === d.answerRef);
    const itemId = answer?.itemId ?? d.resolves[0] ?? "";
    const it = findItem(state, itemId);
    const canFollowUp = !ctx.final && !!it && it.status === "answered" && !it.children.length && it.depth + 1 <= ctx.maxFollowUpDepth;
    const followedUpNow = ctx.followUps.some((f) => f.parentId === itemId);
    const unsupported = review.claims.filter((c) => c.source === "none").map((c) => c.text);
    const verdicts: ReviewVerdict[] = [];
    const errors: string[] = [];
    const askAgain = `ask a follow-up (origin "follow-up", parentId ${itemId})`;

    if (!review.addressesQuestion) {
      verdicts.push("off-topic");
      errors.push(
        `${d.answerRef} does not respond to the question of ${itemId}, so nothing can be decided from it: remove this Decision` +
          (canFollowUp ? ` and ${askAgain} that puts the question to the user again` : `; ${itemId} cannot be asked again and stays unresolved`),
      );
      if (!canFollowUp) outcome.leaveOpen.add(itemId);
    } else {
      if (unsupported.length) {
        verdicts.push("embellished");
        errors.push(`states what the user did not say: ${unsupported.map((c) => `"${c}"`).join(", ")}. Remove it: a conclusion holds only what the Answer says or necessarily implies`);
      }
      if (review.unanswered.length && canFollowUp && !followedUpNow) {
        verdicts.push("partial");
        errors.push(
          `${d.answerRef} leaves part of ${itemId} unanswered: ${review.unanswered.join("; ")}. ${askAgain[0]!.toUpperCase()}${askAgain.slice(1)} asking exactly that; keep a Decision only for what the user did say`,
        );
      }
    }

    outcome.records.push({ attempt: ctx.attempt, path, answerRef: d.answerRef, resolves: d.resolves, conclusion: d.conclusion, verdicts, unsupported, unanswered: review.unanswered });
    if (errors.length) {
      outcome.flagged.add(path);
      outcome.issues.push({ path, errors });
    }
  }
  return outcome;
}

/**
 * The result of the interpreter's last attempt: the Decisions the review still flags are dropped and recorded as
 * rejected, so no ungrounded Decision is written. Their Answers are interpreted again in the next round, or, when
 * they cannot be asked again, left open.
 */
export function withoutFlagged(
  state: ClarifyState,
  result: RoundCheckResult,
  outcome: ReviewOutcome,
  ctx: { round: number; final: boolean; leaveOpen: ReadonlySet<string> },
): RoundCheckResult {
  if (!outcome.flagged.size) return result;
  const items = underReview(state, result.accepted.decisions);
  const kept = items.filter((i) => !outcome.flagged.has(i.path)).map((i) => i.decision);
  const dropped = items.filter((i) => outcome.flagged.has(i.path));
  const droppedIds = new Set(dropped.map((i) => i.decision.id));

  const resolved = new Set(kept.flatMap((d) => d.resolves));
  const followedUp = new Set(result.accepted.followUps.flatMap((f) => (f.parentId ? [f.parentId] : [])));
  const leftOpen = state.agenda
    .filter((i) => (i.status === "answered" || (ctx.final && i.status === "followed-up")) && ctx.leaveOpen.has(i.id) && !resolved.has(i.id) && !followedUp.has(i.id))
    .map((i) => i.id);

  return {
    ...result,
    issues: [...result.issues, ...outcome.issues],
    accepted: {
      decisions: kept,
      followUps: result.accepted.followUps,
      prepared: result.accepted.prepared.map(({ coveredBy, ...p }) => (coveredBy && !droppedIds.has(coveredBy) ? { ...p, coveredBy } : p)),
      ...(leftOpen.length ? { leftOpen } : {}),
    },
    rejected: [
      ...result.rejected,
      ...dropped.map(({ path, decision: { round: _round, status: _status, revisedBy: _revisedBy, ...op } }) => ({
        round: ctx.round,
        kind: "decision" as const,
        item: op,
        errors: outcome.issues.find((i) => i.path === path)?.errors ?? [],
      })),
    ],
  };
}

function yaml(value: unknown): string {
  return stringify(value, { lineWidth: 0 }).trimEnd();
}
