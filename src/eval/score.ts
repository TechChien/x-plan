import type { AnalysisLog } from "../extract/apply-analysis.ts";
import { normalize } from "../extract/evidence.ts";
import type { OpenQuestion, RequirementBrief } from "../extract/schema.ts";
import type { Expected } from "./expected.ts";

type Item = { id: string } & Record<string, unknown>;

export interface QuestionRef {
  id: string;
  question: string;
}

export interface ResolutionScore {
  /** Resolved questions that matched `shouldBeResolved`: noise removed. */
  beneficial: (QuestionRef & { label: string })[];
  /** Resolved questions that matched `mustRemainOpen`: real questions lost. */
  harmful: (QuestionRef & { label: string })[];
  /** Resolved questions matching no label: need a human verdict. */
  unlabeled: (QuestionRef & { reason: string; answeredByIds: string[] })[];
  /** `shouldBeResolved` labels that were raised but left open. */
  missed: { label: string; questions: QuestionRef[] }[];
  /** `shouldBeResolved` labels never raised at all (batch info prevented them, or the model did not notice). */
  notRaised: string[];
  /** `mustRemainOpen` outcomes. */
  realOpen: { kept: string[]; wronglyResolved: string[]; neverRaised: string[] };
}

export interface CaseScore {
  recall: { found: string[]; missing: string[] };
  contradictions: { found: string[]; missing: string[] };
  resolution: ResolutionScore;
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
const matchesAny = (q: OpenQuestion, keywords: string[]) => keywords.some((k) => has(normalize(q.question).toLowerCase(), k));

export function scoreCase(expected: Expected, brief: RequirementBrief, log: AnalysisLog): CaseScore {
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

  return { recall, contradictions, resolution: scoreResolution(expected, brief.openQuestions, log) };
}

/**
 * Counterfactual: the question pool without `resolvedQuestions` is the final open questions plus the resolved ones,
 * so one run shows both what resolution removed and what it would have left.
 */
export function scoreResolution(expected: Expected, open: OpenQuestion[], log: AnalysisLog): ResolutionScore {
  const resolved = log.resolved.map((r) => r.question);
  const ref = (q: OpenQuestion): QuestionRef => ({ id: q.id, question: q.question });
  const must = expected.openQuestions?.mustRemainOpen ?? [];
  const should = expected.openQuestions?.shouldBeResolved ?? [];

  const score: ResolutionScore = { beneficial: [], harmful: [], unlabeled: [], missed: [], notRaised: [], realOpen: { kept: [], wronglyResolved: [], neverRaised: [] } };

  for (const r of log.resolved) {
    const good = should.find((l) => matchesAny(r.question, l.any));
    const bad = must.find((l) => matchesAny(r.question, l.any));
    if (bad) score.harmful.push({ ...ref(r.question), label: bad.id });
    else if (good) score.beneficial.push({ ...ref(r.question), label: good.id });
    else score.unlabeled.push({ ...ref(r.question), reason: r.reason, answeredByIds: r.answeredByIds });
  }

  // A question matching a mustRemainOpen label (e.g. "VIP 會員是什麼？") is never credited to a shouldBeResolved label.
  const isMust = (q: OpenQuestion) => must.some((l) => matchesAny(q, l.any));
  for (const l of should) {
    const left = open.filter((q) => !isMust(q) && matchesAny(q, l.any));
    if (left.length) score.missed.push({ label: l.id, questions: left.map(ref) });
    else if (!resolved.some((q) => !isMust(q) && matchesAny(q, l.any))) score.notRaised.push(l.id);
  }

  for (const l of must) {
    if (open.some((q) => matchesAny(q, l.any))) score.realOpen.kept.push(l.id);
    else if (resolved.some((q) => matchesAny(q, l.any))) score.realOpen.wronglyResolved.push(l.id);
    else score.realOpen.neverRaised.push(l.id);
  }
  return score;
}
