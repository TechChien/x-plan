import type { RequirementBrief } from "./schema.ts";

/** Which agent sessions (task labels) an item of the final Brief came from. */
export interface ItemProvenance {
  /** The session whose text the item kept: a merge keeps the kept item's text. */
  text: string;
  /** Every session that contributed Evidence, `text` first. */
  evidence: string[];
  /** Set when other items were folded into this one. */
  mergedBy?: ("dedup" | "analysis")[];
}

export type Provenance = Record<string, ItemProvenance>;

export interface ProvenanceInput {
  /** Per facts session: the id the model gave → the Run-wide id after merging. */
  idMaps: Record<string, Record<string, string>>;
  /** Exact-name duplicates: dropped id → kept id. */
  deduped: Record<string, string>;
  /** Analysis merges that were applied. */
  merges: { keepId: string; dropIds: string[] }[];
  brief: RequirementBrief;
  /** Label of the Analysis session, the source of every item it added. */
  analysisLabel: string;
}

/**
 * Traces every item of the final Brief to the sessions that produced it, following the same folds Extract made:
 * exact-name dedup, then Analysis merges. Feedback looks items up here instead of re-deriving the merge rules.
 */
export function buildProvenance({ idMaps, deduped, merges, brief, analysisLabel }: ProvenanceInput): Provenance {
  const sources = new Map<string, ItemProvenance>();
  for (const [label, map] of Object.entries(idMaps)) {
    for (const id of Object.values(map)) sources.set(id, { text: label, evidence: [label] });
  }

  const fold = (droppedId: string, keptId: string, by: "dedup" | "analysis") => {
    const dropped = sources.get(droppedId);
    const kept = sources.get(keptId);
    sources.delete(droppedId);
    if (!dropped || !kept) return;
    kept.evidence = [...new Set([...kept.evidence, ...dropped.evidence])];
    if (!kept.mergedBy?.includes(by)) kept.mergedBy = [...(kept.mergedBy ?? []), by];
  };
  for (const [dropped, kept] of Object.entries(deduped)) fold(dropped, kept, "dedup");
  for (const m of merges) for (const dropped of m.dropIds) fold(dropped, m.keepId, "analysis");

  const provenance: Provenance = {};
  for (const [section, items] of Object.entries(brief)) {
    if (section === "traceability") continue;
    for (const { id } of items as { id: string }[]) provenance[id] = sources.get(id) ?? { text: analysisLabel, evidence: [analysisLabel] };
  }
  return provenance;
}
