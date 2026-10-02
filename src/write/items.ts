import type { AlignedBrief } from "../clarify/aligned.ts";
import { FACT_SECTION_NAMES, type Evidence } from "../extract/schema.ts";

/** One fact or Assumption as an agent reads it: every non-empty field, Evidence reduced to its quotes. */
export function factView(item: Record<string, unknown>): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (k === "evidence") {
      if (Array.isArray(v) && v.length) view.evidence = (v as Evidence[]).map((e) => e.quote);
    } else if (!(Array.isArray(v) && !v.length) && v !== "" && v !== undefined) view[k] = v;
  }
  return view;
}

/**
 * The items `ids` name, as an agent reads them: facts and Assumptions as in `factView`, a Decision's conclusion
 * with the user's Answer. In Aligned Brief order; unknown ids are left out.
 */
export function sourcesView(aligned: AlignedBrief, ids: Iterable<string>): Record<string, unknown>[] {
  const wanted = new Set(ids);
  const facts = [...FACT_SECTION_NAMES.flatMap((s) => aligned.brief[s] as unknown as Record<string, unknown>[]), ...(aligned.brief.assumptions as unknown as Record<string, unknown>[])];
  return [
    ...facts.filter((item) => wanted.has(item.id as string)).map(factView),
    ...aligned.decisions.filter((d) => wanted.has(d.id)).map((d) => ({ id: d.id, conclusion: d.conclusion, answer: d.answerText })),
  ];
}
