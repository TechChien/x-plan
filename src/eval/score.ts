import { normalize } from "../extract/evidence.ts";
import type { OpenQuestion, RequirementBrief } from "../extract/schema.ts";
import type { Expected } from "./expected.ts";

type Item = { id: string } & Record<string, unknown>;

export interface QuestionRef {
  id: string;
  question: string;
}

export interface QuestionScore {
  /** `mustBeRaised` labels matched by an open question in the Brief. */
  raised: string[];
  neverRaised: string[];
  /** `shouldNotBeRaised` labels matched: questions the documents already answer. */
  unwanted: { label: string; questions: QuestionRef[] }[];
}

export interface CaseScore {
  recall: { found: string[]; missing: string[] };
  contradictions: { found: string[]; missing: string[] };
  questions: QuestionScore;
  /** `unexpected` labels that matched, with the matching item ids, out of `labels`. */
  noise: { hits: { label: string; itemIds: string[] }[]; labels: number };
  /** Items in the Brief, every section. */
  items: number;
}

/** Text of an item for keyword matching: every string value except Evidence and ids. */
export function itemText(item: unknown): string {
  const parts: string[] = [];
  const walk = (value: unknown, key?: string) => {
    if (key === "evidence" || key === "id") return;
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach((v) => walk(v));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(item);
  return normalize(parts.join(" ")).toLowerCase();
}

const has = (text: string, keyword: string) => text.includes(normalize(keyword).toLowerCase());
const matchesAll = (item: unknown, keywords: string[]) => keywords.every((k) => has(itemText(item), k));

export function scoreCase(expected: Expected, brief: RequirementBrief): CaseScore {
  const sections = brief as unknown as Record<string, Item[]>;
  const byId = new Map(Object.values(sections).flatMap((list) => list.map((item) => [item.id, item] as const)));

  const recall = { found: [] as string[], missing: [] as string[] };
  for (const e of expected.expect) {
    const names = Array.isArray(e.section) ? e.section : [e.section];
    const hit = names.some((s) => (sections[s] ?? []).some((item) => matchesAll(item, e.all)));
    (hit ? recall.found : recall.missing).push(e.id);
  }

  const contradictions = { found: [] as string[], missing: [] as string[] };
  for (const c of expected.contradictions ?? []) {
    const hit = brief.contradictions.some((ctr) => {
      const related = ctr.relatedIds.map((id) => byId.get(id)).filter(Boolean);
      return c.between.every((group) => related.some((item) => matchesAll(item, group)));
    });
    (hit ? contradictions.found : contradictions.missing).push(c.id);
  }

  const itemSections = Object.keys(sections).filter((s) => s !== "traceability");
  const hits: CaseScore["noise"]["hits"] = [];
  for (const u of expected.unexpected ?? []) {
    const names = u.section ? (Array.isArray(u.section) ? u.section : [u.section]) : itemSections;
    const itemIds = names.flatMap((s) => (sections[s] ?? []).filter((item) => u.any.some((k) => has(itemText(item), k))).map((item) => item.id));
    if (itemIds.length) hits.push({ label: u.id, itemIds });
  }
  const items = itemSections.reduce((n, s) => n + (sections[s]?.length ?? 0), 0);

  return { recall, contradictions, questions: scoreQuestions(expected, brief.openQuestions), noise: { hits, labels: expected.unexpected?.length ?? 0 }, items };
}

/** Open questions are never removed by Analysis, so the Brief's questions are everything that was raised. */
export function scoreQuestions(expected: Expected, open: OpenQuestion[]): QuestionScore {
  const must = expected.openQuestions?.mustBeRaised ?? [];
  const unwantedLabels = expected.openQuestions?.shouldNotBeRaised ?? [];
  const matching = (keywords: string[]) => open.filter((q) => keywords.some((k) => has(normalize(q.question).toLowerCase(), k)));

  const raised = must.filter((l) => matching(l.any).length).map((l) => l.id);
  // A real question (e.g. "VIP 會員是什麼？") is never counted as unwanted, even when it also matches a shouldNotBeRaised label.
  const isMust = (q: OpenQuestion) => must.some((l) => matching(l.any).includes(q));
  const unwanted = unwantedLabels
    .map((l) => ({ label: l.id, questions: matching(l.any).filter((q) => !isMust(q)).map((q) => ({ id: q.id, question: q.question })) }))
    .filter((u) => u.questions.length);
  return { raised, neverRaised: must.map((l) => l.id).filter((id) => !raised.includes(id)), unwanted };
}
