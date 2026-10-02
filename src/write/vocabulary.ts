import { Type, type Static } from "typebox";
import { languageErrors, type OutputLanguage } from "../shared/language.ts";
import type { WriteOutline, WrittenFeature } from "./schema.ts";
import type { FeatureIssue } from "./writer.ts";

/**
 * Vocabulary Normalization (ADR 0019): after every writer is done, one agent picks a canonical term per concept and
 * says where to replace what; the program applies the replacements literally and records each. A trial: nothing
 * but the schema and the language of definitions is checked.
 */

const Str = (description: string) => Type.String({ description });

export const VocabularySubmissionSchema = Type.Object(
  {
    entries: Type.Array(
      Type.Object(
        {
          canonical: Str("The term to use for this concept everywhere"),
          definition: Str("What it means, in one sentence"),
          avoid: Type.Array(Type.String(), { description: "Other wordings for the same concept that are replaced by the canonical term" }),
          sourceIds: Type.Array(Type.String(), { description: "The Term, Actor, Entity or Decision the canonical term is taken from; empty when taken from the scenarios" }),
        },
        { additionalProperties: false },
      ),
    ),
    replacements: Type.Array(
      Type.Object(
        {
          loc: Str("A location label from <text>, e.g. SCN-3/step/2"),
          from: Str("The exact wording to replace at that location"),
          to: Str("The canonical term"),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type VocabularySubmission = Static<typeof VocabularySubmissionSchema>;
export type VocabularyEntry = VocabularySubmission["entries"][number];

export interface AppliedReplacement {
  loc: string;
  from: string;
  to: string;
  count: number;
  before: string;
  after: string;
}

export interface SkippedReplacement {
  loc: string;
  from: string;
  to: string;
  reason: string;
}

/** The parts of a Gherkin text a replacement may target, keyed by location label. */
interface Location {
  get(): string;
  set(text: string): void;
}

function locations(outline: WriteOutline, written: Map<string, WrittenFeature>): Map<string, Location> {
  const locs = new Map<string, Location>();
  const add = (loc: string, obj: Record<string, unknown> | unknown[], key: string | number) =>
    locs.set(loc, { get: () => (obj as Record<string, string>)[key as string]!, set: (t) => ((obj as Record<string, string>)[key as string] = t) });
  const table = (prefix: string, rows: string[][] | undefined) => rows?.forEach((row, r) => row.forEach((_, c) => add(`${prefix}/table/${r}/${c}`, row, c)));

  for (const f of outline.features) {
    if (f.isNew) add(`${f.id}/name`, f as unknown as Record<string, unknown>, "name");
    f.rules.forEach((r, i) => add(`${f.id}/rule/${i}`, r, "title"));
    const w = written.get(f.id);
    if (!w) continue;
    add(`${f.id}/description`, w as unknown as Record<string, unknown>, "description");
    w.background.forEach((st, j) => {
      add(`${f.id}/background/${j}`, st, "text");
      table(`${f.id}/background/${j}`, st.dataTable);
    });
  }
  for (const p of outline.scenarios) add(`${p.id}/title`, p as unknown as Record<string, unknown>, "title");
  for (const w of written.values()) {
    for (const s of w.scenarios) {
      s.steps.forEach((st, j) => {
        add(`${s.id}/step/${j}`, st, "text");
        table(`${s.id}/step/${j}`, st.dataTable);
      });
      s.examples.forEach((e, j) => {
        add(`${s.id}/examples/${j}/name`, e, "name");
        e.rows.forEach((row, r) => row.cells.forEach((_, c) => add(`${s.id}/examples/${j}/row/${r}/cell/${c}`, row.cells, c)));
      });
    }
  }
  return locs;
}

/** Every text the agent sees in `<text>`, keyed by the location label a replacement names. */
export function vocabularyLocations(outline: WriteOutline, written: Map<string, WrittenFeature>): Map<string, string> {
  return new Map([...locations(outline, written)].map(([loc, l]) => [loc, l.get()]));
}

/** Kept exactly as written: placeholders and quoted values. */
const PROTECTED = /<[^<>]*>|「[^」]*」|『[^』]*』|"[^"]*"|“[^”]*”/g;

/** Replaces `from` with `to` outside protected spans; returns the text and how many were replaced. */
function replaceOutside(text: string, from: string, to: string): { text: string; count: number } {
  let count = 0;
  let out = "";
  let last = 0;
  const swap = (part: string) => {
    const pieces = part.split(from);
    count += pieces.length - 1;
    return pieces.join(to);
  };
  for (const m of text.matchAll(PROTECTED)) {
    out += swap(text.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  return { text: out + swap(text.slice(last)), count };
}

/**
 * Applies the replacements to copies of the outline and the written Features; the inputs stay as accepted, so
 * `03-outline.json` and the trace keep the writers' wording.
 */
export function applyVocabulary(
  outline: WriteOutline,
  written: Map<string, WrittenFeature>,
  submission: VocabularySubmission,
): { outline: WriteOutline; written: Map<string, WrittenFeature>; applied: AppliedReplacement[]; skipped: SkippedReplacement[] } {
  const copy = structuredClone(outline);
  const copied = new Map([...written].map(([id, f]) => [id, structuredClone(f)]));
  const locs = locations(copy, copied);
  const applied: AppliedReplacement[] = [];
  const skipped: SkippedReplacement[] = [];
  for (const r of submission.replacements) {
    const loc = locs.get(r.loc);
    if (!loc) {
      skipped.push({ ...r, reason: "no such location" });
      continue;
    }
    const before = loc.get();
    const { text, count } = r.from ? replaceOutside(before, r.from, r.to) : { text: before, count: 0 };
    if (!count) {
      skipped.push({ ...r, reason: "not found outside placeholders and quotes" });
      continue;
    }
    loc.set(text);
    applied.push({ ...r, count, before, after: text });
  }
  return { outline: copy, written: copied, applied, skipped };
}

/** The only check: definitions in the output language (ADR 0005). Unknown locations are skipped when applied. */
export function checkVocabulary(submission: VocabularySubmission, language: OutputLanguage): { issues: FeatureIssue[] } {
  const issues: FeatureIssue[] = [];
  submission.entries.forEach((e, i) => {
    const errors = languageErrors({ definition: e.definition }, language);
    if (errors.length) issues.push({ path: `entries[${i}]`, errors });
  });
  return { issues };
}

/** `03-vocabulary.md`, in the format of CONTEXT.md. */
export function renderVocabulary(entries: VocabularyEntry[], applied: AppliedReplacement[]): string {
  const out = ["# Vocabulary", ""];
  for (const e of entries) {
    const times = applied.filter((a) => a.to === e.canonical).reduce((n, a) => n + a.count, 0);
    out.push(`**${e.canonical}**:`, e.definition);
    if (e.avoid.length) out.push(`_Avoid_: ${e.avoid.join(", ")}`);
    out.push(`_Sources_: ${e.sourceIds.join(", ") || "—"} · replaced ${times} times`, "");
  }
  return out.join("\n");
}
