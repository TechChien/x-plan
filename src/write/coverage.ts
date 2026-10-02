import type { AlignedBrief } from "../clarify/aligned.ts";
import type { AgendaStatus } from "../clarify/schema.ts";
import { FACT_SECTION_NAMES } from "../extract/schema.ts";

/** Why an id cannot be cited; the check turns it into the message that tells the agent what to cite instead. */
export type ForbiddenReason =
  | { kind: "superseded"; by: string[] }
  | { kind: "cancelled-feature"; featureIds: string[]; by: string[] }
  | { kind: "unconfirmed-assumption" }
  | { kind: "revised-decision"; by?: string };

/** What Write must and may cite, computed once from the Aligned Brief (ADR 0016). */
export interface CoverageSets {
  /** FEAT ids that get a `.feature`: every Feature not superseded. */
  features: string[];
  /** Ids some scenario must cite, or the outline mark not behavioural; in Brief order. */
  mustCover: string[];
  /** Ids a scenario or step may cite. */
  citable: Set<string>;
  forbidden: Map<string, ForbiddenReason>;
  /** Decisions the outline may mark not behavioural instead of covering. */
  notBehavioralAllowed: string[];
  /**
   * Decisions that replace only named items (a Term, Actor, Entity or Dependency) but cannot be marked not behavioural
   * because something that must be covered uses one of the names: the scenario for it needs the new definition.
   */
  notBehavioralBlocked: Map<string, { terms: string[]; mentionedIn: string[] }>;
  /** Each Agenda Item's final status: open and deferred scenarios name these, never cite them. */
  agenda: Map<string, AgendaStatus>;
}

/** Items that describe behaviour: a Decision replacing one of these, or reconciling them, has behaviour to write. */
const BEHAVIOURAL = /^(FEAT|BR|AC|ASM)-/;

export function coverageSets(aligned: AlignedBrief): CoverageSets {
  const { brief, supersededBy, confirmedBy } = aligned;
  const forbidden = new Map<string, ForbiddenReason>();
  for (const [id, by] of Object.entries(supersededBy)) forbidden.set(id, { kind: "superseded", by: [...by] });

  const features = brief.features.map((f) => f.id).filter((id) => !forbidden.has(id));
  // Rules and criteria of a Feature the user cancelled go with it; a rule that also applies elsewhere stays.
  const cancelled = (featureIds: string[]) => featureIds.length > 0 && featureIds.every((id) => supersededBy[id]);
  const cancel = (id: string, featureIds: string[]) => {
    if (forbidden.has(id) || !cancelled(featureIds)) return;
    forbidden.set(id, { kind: "cancelled-feature", featureIds: [...featureIds], by: [...new Set(featureIds.flatMap((f) => supersededBy[f]!))] });
  };
  for (const r of brief.businessRules) cancel(r.id, r.featureIds);
  for (const ac of brief.acceptanceCriteria) cancel(ac.id, [ac.featureId]);

  for (const a of brief.assumptions) if (!confirmedBy[a.id] && !forbidden.has(a.id)) forbidden.set(a.id, { kind: "unconfirmed-assumption" });
  for (const d of aligned.decisions) if (d.status !== "active") forbidden.set(d.id, { kind: "revised-decision", ...(d.revisedBy ? { by: d.revisedBy } : {}) });

  const active = aligned.decisions.filter((d) => d.status === "active");
  const citable = new Set(
    [...FACT_SECTION_NAMES.flatMap((s) => brief[s].map((it) => it.id)), ...brief.assumptions.map((a) => a.id), ...active.map((d) => d.id)].filter((id) => !forbidden.has(id)),
  );

  const notForbidden = (id: string) => !forbidden.has(id);
  const mustCover = [
    ...features,
    ...brief.businessRules.map((r) => r.id).filter(notForbidden),
    ...brief.acceptanceCriteria.map((ac) => ac.id).filter(notForbidden),
    ...active.filter((d) => d.effect !== "confirm").map((d) => d.id),
  ];

  // A Decision that redefines a name others use changes their behaviour too, e.g. a new length for 鑑賞期 changes the
  // return window of every rule that says 鑑賞期. A plain substring match errs toward requiring the citation.
  const names = namesById(aligned);
  const texts = mustCoverTexts(aligned, mustCover);
  const notBehavioralAllowed: string[] = [];
  const notBehavioralBlocked: CoverageSets["notBehavioralBlocked"] = new Map();
  for (const d of active) {
    if (d.effect === "new") notBehavioralAllowed.push(d.id);
    if (d.effect !== "replace" || d.supersedes.some((id) => BEHAVIOURAL.test(id))) continue;
    const terms = [...new Set(d.supersedes.flatMap((id) => names.get(id) ?? []))];
    const mentionedIn = [...texts].filter(([id, text]) => id !== d.id && terms.some((t) => text.includes(t.toLowerCase()))).map(([id]) => id);
    if (mentionedIn.length) notBehavioralBlocked.set(d.id, { terms, mentionedIn });
    else notBehavioralAllowed.push(d.id);
  }

  const agenda = new Map(aligned.agenda.map((it) => [it.id, it.status]));
  return { features, mustCover, citable, forbidden, notBehavioralAllowed, notBehavioralBlocked, agenda };
}

/** Why `id` cannot be cited, phrased as feedback that says what to cite instead; undefined when it can be. */
export function citationError(sets: CoverageSets, id: string): string | undefined {
  if (sets.citable.has(id)) return undefined;
  const reason = sets.forbidden.get(id);
  switch (reason?.kind) {
    case "superseded":
      return `${id} was replaced by ${reason.by.join(", ")}; cite ${reason.by.join(", ")} instead`;
    case "cancelled-feature":
      return `${id} was cancelled with ${reason.featureIds.join(", ")} (${reason.by.join(", ")}); it cannot appear`;
    case "unconfirmed-assumption":
      return `${id} is an Assumption the user never confirmed; it cannot be cited`;
    case "revised-decision":
      return reason.by ? `${id} was corrected by ${reason.by}; cite ${reason.by} instead` : `${id} was corrected; cite the Decision that corrected it`;
  }
  if (sets.agenda.has(id)) return `${id} is an Agenda Item: list it in agendaIds of an open or deferred scenario, not in sourceIds`;
  return `${id} is not an id in <aligned>`;
}

/** The names a Decision replacing the item redefines: a Term with its aliases, or an Actor, Entity or Dependency. */
function namesById(aligned: AlignedBrief): Map<string, string[]> {
  const { brief } = aligned;
  const named = [
    ...brief.glossary.map((t) => [t.id, [t.term, ...t.aliases]] as const),
    ...[...brief.actors, ...brief.domainEntities, ...brief.dependencies].map((it) => [it.id, [it.name]] as const),
  ];
  return new Map(named.map(([id, list]) => [id, list.map((n) => n.trim()).filter(Boolean)]));
}

/** The wording of each item that must be covered, lower-cased for matching. */
function mustCoverTexts(aligned: AlignedBrief, mustCover: string[]): Map<string, string> {
  const { brief } = aligned;
  const all = new Map<string, string[]>([
    ...brief.features.map((f) => [f.id, [f.name, f.description, ...f.inputs, ...f.outputs]] as [string, string[]]),
    ...brief.businessRules.map((r) => [r.id, [r.rule, ...r.conditions]] as [string, string[]]),
    ...brief.acceptanceCriteria.map((ac) => [ac.id, [ac.text, ac.given ?? "", ac.when ?? "", ac.then ?? ""]] as [string, string[]]),
    ...aligned.decisions.map((d) => [d.id, [d.conclusion]] as [string, string[]]),
  ]);
  return new Map(mustCover.map((id) => [id, (all.get(id) ?? []).join("\n").toLowerCase()]));
}

/** What must be covered and is neither cited nor marked not behavioural, in `mustCover` order. */
export function uncovered(sets: CoverageSets, covered: Iterable<string>): string[] {
  const seen = new Set(covered);
  return sets.mustCover.filter((id) => !seen.has(id));
}
