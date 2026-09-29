import { normalize } from "./evidence.ts";
import { FACT_SECTION_NAMES, type Evidence, type FactSectionName, type Facts } from "./schema.ts";
import { itemsOf, prefixOf, REF_FIELDS, type ItemSection } from "./validate.ts";

export const ITEM_SECTIONS: ItemSection[] = [...FACT_SECTION_NAMES, "openQuestions"];

type Item = { id: string; evidence?: Evidence[] } & Record<string, unknown>;

export function emptyFacts(): Facts {
  return Object.fromEntries(ITEM_SECTIONS.map((s) => [s, []])) as unknown as Facts;
}

/** Fields whose exact (normalized, case-insensitive) match means two items are the same thing. */
const IDENTITY_FIELD: Partial<Record<FactSectionName, string>> = {
  actors: "name",
  domainEntities: "name",
  glossary: "term",
  dependencies: "name",
};

export interface MergeResult {
  facts: Facts;
  /** Old id per bin → new id, for tracing. */
  idMaps: Map<string, string>[];
  /** Items folded into an exact-name duplicate: dropped id → kept id. */
  deduped: Map<string, string>;
}

/**
 * Concatenates per-bin Facts: gives every item a Run-wide id, rewrites each bin's internal references,
 * then folds exact-name duplicates (keeping the first item's text and uniting Evidence).
 */
export function mergeFacts(perBin: Partial<Facts>[]): MergeResult {
  const merged = emptyFacts();
  const counters = new Map<string, number>();
  const idMaps: Map<string, string>[] = [];

  for (const binFacts of perBin) {
    const map = new Map<string, string>();
    for (const section of ITEM_SECTIONS) {
      for (const item of itemsOf(binFacts, section)) {
        const prefix = prefixOf(section);
        const n = (counters.get(prefix) ?? 0) + 1;
        counters.set(prefix, n);
        map.set(item.id, `${prefix}-${n}`);
      }
    }
    const renamed = redirectRefs(binFacts, map);
    for (const section of ITEM_SECTIONS) {
      for (const item of itemsOf(renamed, section)) {
        (merged[section] as unknown as Item[]).push({ ...item, id: map.get(item.id) as string });
      }
    }
    idMaps.push(map);
  }

  const deduped = new Map<string, string>();
  for (const [section, field] of Object.entries(IDENTITY_FIELD) as [FactSectionName, string][]) {
    const byKey = new Map<string, Item>();
    for (const item of itemsOf(merged, section)) {
      const key = normalize(String(item[field] ?? "")).toLowerCase();
      const keep = byKey.get(key);
      if (keep) {
        keep.evidence = uniqueEvidence([...(keep.evidence ?? []), ...(item.evidence ?? [])]);
        deduped.set(item.id, keep.id);
      } else byKey.set(key, item);
    }
    (merged as Record<string, unknown>)[section] = [...byKey.values()];
  }

  return { facts: redirectRefs(merged, deduped) as Facts, idMaps, deduped };
}

/** Rewrites every cross-reference through `redirect` and removes duplicates the rewrite creates. Ids themselves are untouched. */
export function redirectRefs<T extends Partial<Facts>>(facts: T, redirect: Map<string, string>): T {
  const next = structuredClone(facts);
  const to = (id: string) => redirect.get(id) ?? id;
  for (const section of Object.keys(next) as ItemSection[]) {
    for (const item of itemsOf(next, section)) {
      for (const ref of REF_FIELDS[section] ?? []) {
        if (ref.field === "relationships") {
          item.relationships = ((item.relationships ?? []) as { targetId: string; kind: string }[]).map((r) => ({ ...r, targetId: to(r.targetId) }));
        } else if (ref.single) {
          if (typeof item[ref.field] === "string") item[ref.field] = to(item[ref.field] as string);
        } else {
          item[ref.field] = [...new Set(((item[ref.field] ?? []) as string[]).map(to))];
        }
      }
    }
  }
  return next;
}

export function uniqueEvidence(list: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return list.filter((e) => {
    const key = `${e.file}:${e.lineStart}:${e.lineEnd}:${normalize(e.quote)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
