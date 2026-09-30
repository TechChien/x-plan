import type { SourceIndex } from "./evidence.ts";
import { languageErrors, type OutputLanguage } from "./language.ts";
import { FACT_SECTIONS, type Evidence, type FactSectionName, type Facts } from "./schema.ts";

export type ItemSection = FactSectionName | "openQuestions";

export interface ItemIssue {
  section: ItemSection;
  index: number;
  id?: string;
  errors: string[];
}

interface RefField {
  /** Property holding one id (string) or several (string[]); `relationships` is special-cased. */
  field: string;
  prefixes: string[] | "any";
  single?: boolean;
}

/** Cross-references between items, by section. */
export const REF_FIELDS: Partial<Record<ItemSection, RefField[]>> = {
  features: [
    { field: "actorIds", prefixes: ["ACT"] },
    { field: "dependsOn", prefixes: ["FEAT", "DEP"] },
  ],
  businessRules: [{ field: "featureIds", prefixes: ["FEAT"] }],
  acceptanceCriteria: [{ field: "featureId", prefixes: ["FEAT"], single: true }],
  domainEntities: [{ field: "relationships", prefixes: ["ENT"] }],
  openQuestions: [{ field: "relatedIds", prefixes: "any" }],
};

export function prefixOf(section: ItemSection): string {
  return section === "openQuestions" ? "OQ" : FACT_SECTIONS[section].prefix;
}

type Item = { id: string; evidence?: Evidence[] } & Record<string, unknown>;

export function itemsOf(facts: Partial<Facts>, section: ItemSection): Item[] {
  return (facts[section] ?? []) as unknown as Item[];
}

export function refsOf(item: Item, ref: RefField): string[] {
  const value = item[ref.field];
  if (ref.field === "relationships") return ((value ?? []) as { targetId: string }[]).map((r) => r.targetId);
  if (ref.single) return typeof value === "string" ? [value] : [];
  return (value ?? []) as string[];
}

export interface CheckContext {
  index: SourceIndex;
  /** Documents the agent was shown; Evidence must cite one of them. */
  allowedFiles: Set<string>;
}

export interface CheckResult {
  /** The submission with relocated Evidence line numbers applied. */
  facts: Partial<Facts>;
  issues: ItemIssue[];
  relocated: number;
}

/** L3 checks for one Facts submission: Evidence quotes, id format and uniqueness, reference integrity. */
export function checkFacts(submission: Partial<Facts>, ctx: CheckContext): CheckResult {
  const facts = structuredClone(submission);
  const issues: ItemIssue[] = [];
  let relocated = 0;
  const sections = Object.keys(facts) as ItemSection[];

  const idCounts = new Map<string, number>();
  for (const section of sections) for (const item of itemsOf(facts, section)) idCounts.set(item.id, (idCounts.get(item.id) ?? 0) + 1);

  for (const section of sections) {
    itemsOf(facts, section).forEach((item, index) => {
      const errors: string[] = [];
      const prefix = prefixOf(section);
      if (!new RegExp(`^${prefix}-\\d+$`).test(item.id)) errors.push(`id "${item.id}" must match ${prefix}-<number>`);
      if ((idCounts.get(item.id) ?? 0) > 1) errors.push(`id "${item.id}" is used more than once`);

      item.evidence?.forEach((ev, i) => {
        if (!ctx.allowedFiles.has(ev.file)) {
          errors.push(`evidence[${i}]: file "${ev.file}" was not provided in this batch`);
          return;
        }
        const result = ctx.index.verify(ev);
        if (!result.ok) errors.push(`evidence[${i}]: ${result.error}`);
        else if (result.relocated) {
          item.evidence![i] = result.evidence;
          relocated++;
        }
      });

      for (const ref of REF_FIELDS[section] ?? []) {
        for (const target of refsOf(item, ref)) {
          if (!idCounts.has(target)) errors.push(`${ref.field}: "${target}" does not exist`);
          else if (ref.prefixes !== "any" && !ref.prefixes.some((p) => target.startsWith(`${p}-`))) {
            errors.push(`${ref.field}: "${target}" must be a ${ref.prefixes.join(" or ")} id`);
          }
        }
      }

      if (errors.length) issues.push({ section, index, id: item.id, errors });
    });
  }
  return { facts, issues, relocated };
}

/**
 * Removes items that have issues, then strips references to removed ids from the survivors.
 * An item whose single required reference was removed is removed too.
 */
export function dropInvalid(facts: Partial<Facts>, issues: ItemIssue[]): { facts: Partial<Facts>; dropped: { section: ItemSection; item: unknown; errors: string[] }[] } {
  const result = structuredClone(facts);
  const dropped: { section: ItemSection; item: unknown; errors: string[] }[] = [];
  const removed = new Set<string>();

  for (const issue of issues) {
    const item = itemsOf(result, issue.section)[issue.index];
    if (item) {
      dropped.push({ section: issue.section, item, errors: issue.errors });
      removed.add(item.id);
    }
  }
  const sections = Object.keys(result) as ItemSection[];
  for (const section of sections) {
    (result as Record<string, unknown>)[section] = itemsOf(result, section).filter((item) => !removed.has(item.id));
  }

  // Cascade: single-reference items lose their anchor and must go; multi-reference fields are pruned.
  let changed = true;
  while (changed) {
    changed = false;
    for (const section of sections) {
      const kept: Item[] = [];
      for (const item of itemsOf(result, section)) {
        const orphaned = (REF_FIELDS[section] ?? []).find((ref) => ref.single && refsOf(item, ref).some((id) => removed.has(id)));
        if (orphaned) {
          dropped.push({ section, item, errors: [`${orphaned.field} points to a rejected item`] });
          removed.add(item.id);
          changed = true;
        } else kept.push(pruneRefs(section, item, removed));
      }
      (result as Record<string, unknown>)[section] = kept;
    }
  }
  return { facts: result, dropped };
}

function pruneRefs(section: ItemSection, item: Item, removed: Set<string>): Item {
  const next: Item = { ...item };
  for (const ref of REF_FIELDS[section] ?? []) {
    if (ref.single) continue;
    if (ref.field === "relationships") {
      next.relationships = ((item.relationships ?? []) as { targetId: string }[]).filter((r) => !removed.has(r.targetId));
    } else next[ref.field] = ((item[ref.field] ?? []) as string[]).filter((id) => !removed.has(id));
  }
  return next;
}

/** Items not written in the output language. Unlike other issues these never drop an item. */
export function checkLanguage(facts: Partial<Facts>, lang: OutputLanguage): ItemIssue[] {
  return (Object.keys(facts) as ItemSection[]).flatMap((section) =>
    itemsOf(facts, section).flatMap((item, index) => {
      const errors = languageErrors(item, lang);
      return errors.length ? [{ section, index, id: item.id, errors }] : [];
    }),
  );
}

/** One entry per item, errors of both lists combined. */
export function mergeIssues(a: ItemIssue[], b: ItemIssue[]): ItemIssue[] {
  const byItem = new Map<string, ItemIssue>();
  for (const issue of [...a, ...b]) {
    const key = `${issue.section}[${issue.index}]`;
    const seen = byItem.get(key);
    byItem.set(key, seen ? { ...seen, errors: [...seen.errors, ...issue.errors] } : issue);
  }
  return [...byItem.values()];
}

export function formatIssues(issues: ItemIssue[]): string {
  return issues
    .map((i) => `- ${i.section}[${i.index}]${i.id ? ` (${i.id})` : ""}:\n${i.errors.map((e) => `    - ${e}`).join("\n")}`)
    .join("\n");
}
