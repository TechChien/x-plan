import { stringify } from "yaml";
import type { Evidence, RequirementBrief } from "../extract/schema.ts";
import type { PromptLibrary } from "../prompts/template.ts";
import { LANGUAGE_NAMES } from "../shared/language.ts";
import type { BuiltPrompt } from "../shared/run-files.ts";
import { contentAnswer, item } from "./agenda.ts";
import { nextDecisionNumber } from "./check.ts";
import type { ClarifyState, Decision, RoundRecord } from "./schema.ts";

/**
 * The user message puts what changes least first, so consecutive rounds share a prefix the provider can cache
 * (ADR 0006): the Brief never changes and the log only grows at its end; state and this round's task come last.
 */
export function buildRoundPrompt(lib: PromptLibrary, brief: RequirementBrief, state: ClarifyState, prepare: string[], opts: { maxGaps: number }): BuiltPrompt {
  return {
    systemPrompt: lib.render("clarify/round.system", { outputLanguage: LANGUAGE_NAMES[state.outputLanguage], maxGaps: String(opts.maxGaps) }),
    userMessage: lib.render("clarify/round.user", {
      brief: briefToYaml(brief),
      log: logToYaml(state),
      state: stateToYaml(state),
      pendingAnswers: pendingAnswersToYaml(state, false),
      prepare: prepareToYaml(state, prepare),
    }),
  };
}

export function buildFinalPrompt(lib: PromptLibrary, brief: RequirementBrief, state: ClarifyState): BuiltPrompt {
  return {
    systemPrompt: lib.render("clarify/final.system", { outputLanguage: LANGUAGE_NAMES[state.outputLanguage] }),
    userMessage: lib.render("clarify/final.user", {
      brief: briefToYaml(brief),
      log: logToYaml(state),
      state: stateToYaml(state),
      pendingAnswers: pendingAnswersToYaml(state, true),
    }),
  };
}

/** Every Brief section with items, in the Brief's order. Evidence keeps file and quote; line numbers are dropped. */
export function briefToYaml(brief: RequirementBrief): string {
  const view: Record<string, unknown[]> = {};
  for (const [section, list] of Object.entries(brief)) {
    if (section === "traceability" || !Array.isArray(list) || !list.length) continue;
    view[section] = (list as Record<string, unknown>[]).map(({ evidence, ...rest }) => ({
      ...rest,
      ...(Array.isArray(evidence) && evidence.length ? { evidence: (evidence as Evidence[]).map((e) => ({ file: e.file, quote: e.quote })) } : {}),
    }));
  }
  return yaml(view);
}

/**
 * One block per round, rendered only from what never changes once the round is over, so the log of round k is
 * a prefix of the log of round k + 1. Empty before the first round.
 */
export function logToYaml(state: ClarifyState): string {
  return state.rounds.map((round) => yaml([roundView(state, round)]) + "\n").join("");
}

function roundView(state: ClarifyState, round: RoundRecord) {
  const answers = state.answers.filter((a) => a.round === round.n);
  return {
    round: round.n,
    ...(round.accepted.decisions.length ? { decisions: round.accepted.decisions.map(decisionView) } : {}),
    ...(round.accepted.followUps.length
      ? { newQuestions: round.accepted.followUps.map((f) => ({ id: f.id, origin: f.origin, ...(f.parentId ? { parentId: f.parentId } : {}), question: f.question })) }
      : {}),
    ...(round.asked.length
      ? { asked: round.asked.map((q) => ({ id: q.id, question: q.question, recommendation: q.recommendation, ...(q.options.length ? { options: q.options } : {}) })) }
      : {}),
    ...(answers.length ? { answers: answers.map((a) => ({ ref: a.ref, kind: a.kind, ...(a.target ? { about: a.target } : {}), text: a.text })) } : {}),
  };
}

function decisionView(d: Decision) {
  return {
    id: d.id,
    answerRef: d.answerRef,
    resolves: d.resolves,
    conclusion: d.conclusion,
    ...(d.supersedes.length ? { supersedes: d.supersedes } : {}),
    ...(d.confirms.length ? { confirms: d.confirms } : {}),
    ...(d.revises.length ? { revises: d.revises } : {}),
    ...(d.relatedIds.length ? { relatedIds: d.relatedIds } : {}),
  };
}

export function stateToYaml(state: ClarifyState): string {
  const active = state.decisions.filter((d) => d.status === "active");
  const superseded: Record<string, string[]> = {};
  for (const d of active) for (const id of d.supersedes) (superseded[id] ??= []).push(d.id);
  const revised = Object.fromEntries(state.decisions.filter((d) => d.revisedBy).map((d) => [d.id, d.revisedBy]));
  return yaml({
    agenda: state.agenda.map((i) => ({
      id: i.id,
      status: i.status,
      ...(i.parentId ? { parentId: i.parentId } : {}),
      ...(i.target ? { about: i.target } : {}),
      ...(i.resolvedBy ? { resolvedBy: i.resolvedBy } : {}),
    })),
    ...(Object.keys(superseded).length ? { supersededBriefItems: superseded } : {}),
    ...(Object.keys(revised).length ? { revisedDecisions: revised } : {}),
    firstNewDecisionId: `DEC-${nextDecisionNumber(state)}`,
  });
}

/** The Answers to interpret now: answered items, plus followed-up ones in the closing round. */
export function pendingAnswersToYaml(state: ClarifyState, final: boolean): string {
  const items = state.agenda.filter((i) => i.status === "answered" || (final && i.status === "followed-up"));
  if (!items.length) return "[]";
  return yaml(
    items.map((it) => {
      const answer = contentAnswer(state, it.id);
      return {
        ref: answer?.ref ?? `?/${it.id}`,
        item: it.id,
        ...(it.parentId ? { followsUp: it.parentId } : {}),
        ...(it.target ? { about: it.target } : {}),
        ...(it.status === "followed-up" ? { note: `its follow-ups ${it.children.join(", ")} were not all answered` } : {}),
        question: it.view?.question ?? it.text,
        kind: answer?.kind ?? "text",
        answer: answer?.text ?? "",
      };
    }),
  );
}

export function prepareToYaml(state: ClarifyState, ids: string[]): string {
  if (!ids.length) return "[]";
  return yaml(
    ids.map((id) => {
      const it = item(state, id);
      return {
        id: it.id,
        kind: it.kind,
        ...(it.origin !== "brief" ? { origin: it.origin } : {}),
        ...(it.parentId ? { followsUp: it.parentId } : {}),
        text: it.text,
        ...(it.severity ? { severity: it.severity } : {}),
        ...(it.confidence ? { confidence: it.confidence } : {}),
        ...(it.relatedIds.length ? { relatedIds: it.relatedIds } : {}),
        ...(it.askedIn.length && it.view ? { askedBefore: { rounds: it.askedIn, question: it.view.question } } : {}),
      };
    }),
  );
}

function yaml(value: unknown): string {
  return stringify(value, { lineWidth: 0 }).trimEnd();
}
