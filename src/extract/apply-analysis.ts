import { ITEM_SECTIONS, redirectRefs, uniqueEvidence } from "./merge.ts";
import type { AnalysisSubmission, Evidence, Facts, OpenQuestion, RequirementBrief, TraceabilityEntry } from "./schema.ts";
import { itemsOf, type ItemSection } from "./validate.ts";

type Item = { id: string; evidence?: Evidence[] } & Record<string, unknown>;

export interface OpIssue {
  /** e.g. "merges[0]" */
  op: string;
  errors: string[];
}

/** What Analysis removed from the Brief, with the full removed items, so people and evals can judge each decision. */
export interface AnalysisLog {
  merged: { keepId: string; dropIds: string[]; reason: string; dropped: unknown[] }[];
  resolved: { questionId: string; answeredByIds: string[]; reason: string; question: OpenQuestion }[];
}

interface Lookup {
  sectionOf: Map<string, ItemSection>;
  items: Map<string, Item>;
}

function lookup(facts: Facts): Lookup {
  const sectionOf = new Map<string, ItemSection>();
  const items = new Map<string, Item>();
  for (const section of ITEM_SECTIONS) {
    for (const item of itemsOf(facts, section)) {
      sectionOf.set(item.id, section);
      items.set(item.id, item);
    }
  }
  return { sectionOf, items };
}

/**
 * Validates Analysis operations against the merged Facts. Merges are checked first; the accepted ones
 * define how ids are redirected when the remaining operations are checked.
 */
export function checkAnalysis(facts: Facts, ops: AnalysisSubmission): { issues: OpIssue[]; redirect: Map<string, string> } {
  const { sectionOf } = lookup(facts);
  const issues: OpIssue[] = [];
  const add = (op: string, errors: string[]) => errors.length && issues.push({ op, errors });
  const missing = (ids: string[]) => ids.filter((id) => !sectionOf.has(id)).map((id) => `"${id}" does not exist`);

  const keepIds = new Set(ops.merges.map((m) => m.keepId));
  const dropCount = new Map<string, number>();
  for (const m of ops.merges) for (const id of m.dropIds) dropCount.set(id, (dropCount.get(id) ?? 0) + 1);

  const redirect = new Map<string, string>();
  ops.merges.forEach((m, i) => {
    const errors = missing([m.keepId, ...m.dropIds]);
    const keepSection = sectionOf.get(m.keepId);
    for (const id of m.dropIds) {
      if (id === m.keepId) errors.push(`"${id}" cannot be merged into itself`);
      else if (sectionOf.has(id) && keepSection && sectionOf.get(id) !== keepSection) {
        errors.push(`"${id}" (${sectionOf.get(id)}) and keepId "${m.keepId}" (${keepSection}) are in different sections`);
      }
      if ((dropCount.get(id) ?? 0) > 1) errors.push(`"${id}" appears in dropIds of more than one merge`);
      if (keepIds.has(id)) errors.push(`"${id}" is dropped here but kept in another merge; merge chains are not allowed, merge everything into one keepId`);
    }
    if (dropCount.has(m.keepId)) errors.push(`keepId "${m.keepId}" is dropped by another merge; merge chains are not allowed`);
    add(`merges[${i}]`, errors);
    if (!errors.length) for (const id of m.dropIds) redirect.set(id, m.keepId);
  });

  ops.resolvedQuestions.forEach((r, i) => {
    const errors = missing([r.questionId, ...r.answeredByIds]);
    if (sectionOf.has(r.questionId) && sectionOf.get(r.questionId) !== "openQuestions") errors.push(`questionId "${r.questionId}" is not an open question`);
    if (redirect.has(r.questionId) || keepIds.has(r.questionId)) errors.push(`"${r.questionId}" is both merged and resolved; choose one`);
    for (const id of r.answeredByIds) if (sectionOf.get(id) === "openQuestions") errors.push(`"${id}" is an open question and cannot answer one`);
    add(`resolvedQuestions[${i}]`, errors);
  });

  ops.contradictions.forEach((c, i) => {
    const errors = missing(c.relatedIds);
    for (const id of c.relatedIds) if (sectionOf.get(id) === "openQuestions") errors.push(`"${id}" is an open question; contradictions relate facts`);
    const distinct = new Set(c.relatedIds.map((id) => redirect.get(id) ?? id));
    if (!errors.length && distinct.size < 2) {
      const merge = ops.merges.findIndex((m) => c.relatedIds.some((id) => m.dropIds.includes(id) || m.keepId === id));
      errors.push(
        `after merges these ids are the same item (merges[${merge}]); an item cannot contradict itself. Either they are duplicates (keep the merge) or they conflict (remove the merge)`,
      );
    }
    add(`contradictions[${i}]`, errors);
  });

  ops.openQuestions.forEach((q, i) => add(`openQuestions[${i}]`, missing(q.relatedIds)));
  ops.assumptions.forEach((a, i) => add(`assumptions[${i}]`, missing(a.relatedIds)));

  return { issues, redirect };
}

/** Applies the valid operations; invalid ones are returned so they can be recorded as Rejected Items. */
export function applyAnalysis(facts: Facts, ops: AnalysisSubmission): { brief: RequirementBrief; rejectedOps: OpIssue[]; log: AnalysisLog } {
  const { issues, redirect } = checkAnalysis(facts, ops);
  const bad = new Set(issues.map((i) => i.op));
  const ok = <T>(kind: string) => (_: T, i: number) => !bad.has(`${kind}[${i}]`);
  const { items } = lookup(facts);

  // 1. Merges: fold dropped items' Evidence into the kept item, remove dropped items, redirect references.
  const merges = ops.merges.filter(ok("merges"));
  const next = structuredClone(facts);
  const nextItems = lookup(next).items;
  for (const m of merges) {
    const keep = nextItems.get(m.keepId) as Item;
    if (keep.evidence) keep.evidence = uniqueEvidence([...keep.evidence, ...m.dropIds.flatMap((id) => items.get(id)?.evidence ?? [])]);
  }
  // 2. Resolved questions are removed.
  const resolved = ops.resolvedQuestions.filter(ok("resolvedQuestions"));
  const removed = new Set([...redirect.keys(), ...resolved.map((r) => r.questionId)]);
  for (const section of ITEM_SECTIONS) {
    (next as Record<string, unknown>)[section] = itemsOf(next, section).filter((item) => !removed.has(item.id));
  }
  const redirected = redirectRefs(next, redirect);
  const to = (id: string) => redirect.get(id) ?? id;
  const dedupe = (ids: string[]) => [...new Set(ids.map(to))];

  // 3. New items get ids after the existing ones.
  const nextNumber = (prefix: string, existing: { id: string }[]) =>
    Math.max(0, ...existing.map((x) => Number(x.id.slice(prefix.length + 1)) || 0)) + 1;

  let oq = nextNumber("OQ", facts.openQuestions);
  const openQuestions = [
    ...redirected.openQuestions,
    ...ops.openQuestions.filter(ok("openQuestions")).map((q) => ({ id: `OQ-${oq++}`, ...q, relatedIds: dedupe(q.relatedIds), evidence: [] })),
  ];
  const contradictions = ops.contradictions.filter(ok("contradictions")).map((c, i) => {
    const relatedIds = dedupe(c.relatedIds);
    return {
      id: `CTR-${i + 1}`,
      conflict: c.conflict,
      relatedIds,
      evidence: uniqueEvidence(relatedIds.flatMap((id) => lookup(redirected).items.get(id)?.evidence ?? [])),
    };
  });
  const assumptions = ops.assumptions
    .filter(ok("assumptions"))
    .map((a, i) => ({ id: `ASM-${i + 1}`, ...a, relatedIds: dedupe(a.relatedIds) }));

  const briefWithoutTrace = { ...redirected, openQuestions, contradictions, assumptions };
  return {
    brief: { ...briefWithoutTrace, traceability: buildTraceability(briefWithoutTrace) },
    rejectedOps: issues,
    log: {
      merged: merges.map((m) => ({ ...m, dropped: m.dropIds.map((id) => items.get(id)) })),
      resolved: resolved.map((r) => ({ ...r, question: items.get(r.questionId) as unknown as OpenQuestion })),
    },
  };
}

/** Source file → ids of every item whose Evidence cites it. Derived, never produced by a model. */
export function buildTraceability(brief: Omit<RequirementBrief, "traceability">): TraceabilityEntry[] {
  const byFile = new Map<string, Set<string>>();
  for (const list of Object.values(brief) as Item[][]) {
    for (const item of list) {
      for (const ev of item.evidence ?? []) {
        if (!byFile.has(ev.file)) byFile.set(ev.file, new Set());
        byFile.get(ev.file)!.add(item.id);
      }
    }
  }
  return [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, ids]) => ({ file, itemIds: [...ids] }));
}
