import type { AlignedBrief } from "../clarify/aligned.ts";
import { FACT_SECTION_NAMES, type Evidence } from "../extract/schema.ts";

/**
 * The items `ids` name, as an agent reads them: every fact field with Evidence reduced to its quotes, an Assumption's
 * statement, a Decision's conclusion with the user's Answer. In Aligned Brief order; unknown ids are left out.
 */
export function sourcesView(aligned: AlignedBrief, ids: Iterable<string>): Record<string, unknown>[] {
  const wanted = new Set(ids);
  const out: Record<string, unknown>[] = [];
  const facts = [...FACT_SECTION_NAMES.flatMap((s) => aligned.brief[s] as unknown as Record<string, unknown>[]), ...(aligned.brief.assumptions as unknown as Record<string, unknown>[])];
  for (const item of facts) {
    if (!wanted.has(item.id as string)) continue;
    const view: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item)) {
      if (k === "evidence") {
        if (Array.isArray(v) && v.length) view.evidence = (v as Evidence[]).map((e) => e.quote);
      } else if (!(Array.isArray(v) && !v.length) && v !== "" && v !== undefined) view[k] = v;
    }
    out.push(view);
  }
  for (const d of aligned.decisions) if (wanted.has(d.id)) out.push({ id: d.id, conclusion: d.conclusion, answer: d.answerText });
  return out;
}
