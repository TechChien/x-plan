import type { RequirementBrief } from "../extract/schema.ts";
import type { OutputLanguage } from "../shared/language.ts";
import { findItem } from "./agenda.ts";
import type { AgendaItem, AgendaStatus, ClarifyState, Decision, ResponseKind, Termination } from "./schema.ts";

/** How a Decision changes the Brief, derived from its lists. */
export type DecisionEffect = "replace" | "confirm" | "reconcile" | "new";

export interface AlignedDecision extends Decision {
  effect: DecisionEffect;
  /** The user's words the Decision is drawn from. */
  answerText: string;
}

export interface AlignedAgendaItem {
  id: string;
  kind: AgendaItem["kind"];
  origin: AgendaItem["origin"];
  status: AgendaStatus;
  /** The question as last shown to the user, or the item as first stated if it was never asked. */
  question: string;
  relatedIds: string[];
  parentId?: string;
  target?: string;
  resolvedBy?: string[];
  answers: { ref: string; kind: ResponseKind; text: string }[];
}

/** Clarify's output and Write's only input (ADR 0008): the Brief unchanged, plus what the user decided. */
export interface AlignedBrief {
  /** The Extract Run and Brief this was aligned from (ADR 0010). */
  source?: ClarifyState["source"];
  outputLanguage: OutputLanguage;
  termination?: Termination;
  brief: RequirementBrief;
  /** Brief ids replaced by active Decisions. */
  supersededBy: Record<string, string[]>;
  /** Assumption ids confirmed by active Decisions. */
  confirmedBy: Record<string, string[]>;
  /** Every Decision, revised ones included. */
  decisions: AlignedDecision[];
  agenda: AlignedAgendaItem[];
}

export function buildAligned(brief: RequirementBrief, state: ClarifyState): AlignedBrief {
  const active = state.decisions.filter((d) => d.status === "active");
  return {
    ...(state.source ? { source: structuredClone(state.source) } : {}),
    outputLanguage: state.outputLanguage,
    ...(state.termination ? { termination: state.termination } : {}),
    brief: structuredClone(brief),
    supersededBy: invert(active, (d) => d.supersedes),
    confirmedBy: invert(active, (d) => d.confirms),
    decisions: state.decisions.map((d) => ({
      ...structuredClone(d),
      effect: effectOf(state, d),
      answerText: state.answers.find((a) => a.ref === d.answerRef)?.text ?? "",
    })),
    agenda: state.agenda.map((it) => ({
      id: it.id,
      kind: it.kind,
      origin: it.origin,
      status: it.status,
      question: it.view?.question ?? it.text,
      relatedIds: [...it.relatedIds],
      ...(it.parentId ? { parentId: it.parentId } : {}),
      ...(it.target ? { target: it.target } : {}),
      ...(it.resolvedBy ? { resolvedBy: [...it.resolvedBy] } : {}),
      answers: state.answers.filter((a) => a.itemId === it.id).map((a) => ({ ref: a.ref, kind: a.kind, text: a.text })),
    })),
  };
}

function effectOf(state: ClarifyState, d: Decision): DecisionEffect {
  if (d.supersedes.length) return "replace";
  if (d.confirms.length) return "confirm";
  if (d.resolves.some((id) => findItem(state, id)?.kind === "CTR" || findItem(state, id)?.origin === "conflict")) return "reconcile";
  return "new";
}

function invert(decisions: Decision[], ids: (d: Decision) => string[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const d of decisions) for (const id of ids(d)) (map[id] ??= []).push(d.id);
  return map;
}
