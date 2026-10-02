import type { AlignedBrief } from "../clarify/aligned.ts";
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
  const notBehavioralAllowed = active
    .filter((d) => d.effect === "new" || (d.effect === "replace" && !d.supersedes.some((id) => BEHAVIOURAL.test(id))))
    .map((d) => d.id);

  return { features, mustCover, citable, forbidden, notBehavioralAllowed };
}

/** What must be covered and is neither cited nor marked not behavioural, in `mustCover` order. */
export function uncovered(sets: CoverageSets, covered: Iterable<string>): string[] {
  const seen = new Set(covered);
  return sets.mustCover.filter((id) => !seen.has(id));
}
