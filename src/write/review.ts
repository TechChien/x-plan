import { Type, type Static } from "typebox";
import { stringify } from "yaml";
import type { AlignedBrief } from "../clarify/aligned.ts";
import { sourcesView } from "./items.ts";
import type { ScenarioKind, Step, WriteOutline, WrittenFeature } from "./schema.ts";
import type { FeatureIssue } from "./writer.ts";

/**
 * Scenario Review (ADR 0018): a second agent checks every line a writer wrote against the items the line cites,
 * before the Feature is accepted. It only reports; the writer rewrites.
 */

const Str = (description: string) => Type.String({ description });

export const ReviewSubmissionSchema = Type.Object(
  {
    reviews: Type.Array(
      Type.Object(
        {
          unit: Str("A unit in <review>: a scenario id, or background"),
          lines: Type.Array(
            Type.Object(
              {
                ref: Str("The line's ref in <review>, e.g. steps[0] or examples[0].rows[1]"),
                grounding: Type.Union([Type.Literal("stated"), Type.Literal("entailed"), Type.Literal("other"), Type.Literal("none")], {
                  description: "stated: an item the line cites says it; entailed: necessarily follows from them; other: only an item the line does not cite says it; none: no item says it",
                }),
                contradicts: Type.Boolean({ description: "true when the line says the opposite of an item it cites, e.g. a different number" }),
                values: Type.Array(
                  Type.Object(
                    { value: Str("A concrete value the line states: a number, amount, name or code"), source: Str("The id that gives it, entailed, or none") },
                    { additionalProperties: false },
                  ),
                ),
                actualSourceIds: Type.Array(Type.String(), { description: "grounding other: the ids in <sources> that do say it; otherwise empty" }),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ReviewSubmission = Static<typeof ReviewSubmissionSchema>;

export type ScenarioReviewVerdict = "unsupported" | "contradicts" | "invented-value" | "underived" | "misattributed";

export interface ReviewLine {
  ref: string;
  /** As rendered: the keyword with the step, or `column = value` pairs for an Examples row. */
  text: string;
  sourceIds: string[];
  /** In a derived scenario or a derived Examples block: it may be entailed rather than stated. */
  derived: boolean;
}

/** What one reviewer call covers: the Background, or one written scenario. */
export interface ReviewUnit {
  unit: string;
  title?: string;
  kind: ScenarioKind | "background";
  /** What the scenario stands on in the outline, so the reviewer also sees sources no line cites. */
  sourceIds: string[];
  lines: ReviewLine[];
}

export function underReview(feature: WrittenFeature, outline: WriteOutline): ReviewUnit[] {
  const plans = new Map(outline.scenarios.map((s) => [s.id, s]));
  const stepLines = (steps: Step[], derived: boolean) =>
    steps.map((st, j) => ({ ref: `steps[${j}]`, text: `${st.keyword} ${st.text}`, sourceIds: [...st.sourceIds], derived }));
  const units: ReviewUnit[] = [];
  if (feature.background.length) units.push({ unit: "background", kind: "background", sourceIds: [], lines: stepLines(feature.background, false) });
  for (const s of feature.scenarios) {
    const derived = s.kind === "derived";
    units.push({
      unit: s.id,
      title: plans.get(s.id)?.title ?? s.id,
      kind: s.kind,
      sourceIds: [...(plans.get(s.id)?.effectiveSourceIds ?? [])],
      lines: [
        ...stepLines(s.steps, derived),
        ...s.examples.flatMap((e, j) =>
          e.rows.map((r, k) => ({ ref: `examples[${j}].rows[${k}]`, text: e.header.map((h, i) => `${h} = ${r.cells[i] ?? ""}`).join(", "), sourceIds: [...r.sourceIds], derived: derived || e.derived })),
        ),
      ],
    });
  }
  return units;
}

/** Everything the reviewer may count as a source, and nothing else. */
export function reviewToYaml(aligned: AlignedBrief, units: ReviewUnit[]): string {
  const ids = new Set(units.flatMap((u) => [...u.sourceIds, ...u.lines.flatMap((l) => l.sourceIds)]));
  return stringify(
    {
      scenarios: units.map((u) => ({
        unit: u.unit,
        ...(u.title ? { title: u.title } : {}),
        kind: u.kind,
        lines: u.lines.map((l) => ({ ref: l.ref, text: l.text, sourceIds: l.sourceIds, ...(l.derived && u.kind !== "derived" ? { derived: true } : {}) })),
      })),
      sources: sourcesView(aligned, ids),
    },
    { lineWidth: 0 },
  );
}

/** Errors that make the reviewer resubmit: every unit, and every line of it, reviewed exactly once. */
export function reviewErrors(submission: ReviewSubmission, units: ReviewUnit[]): string[] {
  const byUnit = new Map(units.map((u) => [u.unit, u]));
  const counts = new Map<string, number>();
  for (const r of submission.reviews) counts.set(r.unit, (counts.get(r.unit) ?? 0) + 1);
  const lineErrors = units.flatMap((u) => {
    const review = submission.reviews.find((r) => r.unit === u.unit);
    if (!review) return [];
    const refs = new Set(u.lines.map((l) => l.ref));
    const seen = new Set(review.lines.map((l) => l.ref));
    return [
      ...u.lines.filter((l) => !seen.has(l.ref)).map((l) => `${u.unit}: ${l.ref} has no review`),
      ...review.lines.filter((l) => !refs.has(l.ref)).map((l) => `${u.unit}: ${l.ref} is not a line of ${u.unit}`),
    ];
  });
  return [
    ...[...counts.keys()].filter((id) => !byUnit.has(id)).map((id) => `${id} is not under review`),
    ...[...counts.entries()].filter(([id, n]) => n > 1 && byUnit.has(id)).map(([id]) => `${id} is reviewed more than once`),
    ...units.filter((u) => !counts.has(u.unit)).map((u) => `${u.unit} has no review`),
    ...lineErrors,
  ];
}

export interface ReviewFinding {
  ref: string;
  verdict: ScenarioReviewVerdict;
  text: string;
  sourceIds: string[];
  /** invented-value: the value; misattributed: the ids that do say it. */
  detail?: string;
}

/** Scenario Review's finding on one unit, kept in `03-trace.json` and for the eval. */
export interface ScenarioReviewRecord {
  attempt: number;
  unit: string;
  /** Empty: the unit is grounded. */
  verdicts: ScenarioReviewVerdict[];
  findings: ReviewFinding[];
}

export interface ScenarioReviewOutcome {
  /** Feedback for the writer, one issue per flagged line, at its path in the writer's submission. */
  issues: FeatureIssue[];
  /** Units with a finding. */
  flagged: Set<string>;
  records: ScenarioReviewRecord[];
}

/** Turns the reviewer's line-by-line report into verdicts and feedback; the program decides, not the reviewer. */
export function judgeReview(units: ReviewUnit[], submission: ReviewSubmission, ctx: { attempt: number; paths: Map<string, string> }): ScenarioReviewOutcome {
  const outcome: ScenarioReviewOutcome = { issues: [], flagged: new Set(), records: [] };
  for (const u of units) {
    const review = submission.reviews.find((r) => r.unit === u.unit);
    const findings: ReviewFinding[] = [];
    for (const line of u.lines) {
      const report = review?.lines.find((l) => l.ref === line.ref);
      if (!report) continue;
      const cited = line.sourceIds.join(", ") || "nothing";
      const found = (verdict: ScenarioReviewVerdict, detail?: string) =>
        findings.push({ ref: line.ref, verdict, text: line.text, sourceIds: line.sourceIds, ...(detail ? { detail } : {}) });
      const errors: string[] = [];
      if (report.contradicts) {
        found("contradicts");
        errors.push(`contradicts ${cited}: "${line.text}". Correct it to agree with ${cited}`);
      }
      if (report.grounding === "none" && line.derived) {
        found("underived");
        errors.push(`does not necessarily follow from ${cited}: "${line.text}". Remove what does not follow, or give openReason to make the scenario open`);
      } else if (report.grounding === "none") {
        found("unsupported");
        errors.push(`states what ${cited} does not say: "${line.text}". Remove it: a line holds only what the items it cites say or necessarily imply`);
      } else if (report.grounding === "other") {
        const actual = report.actualSourceIds.join(", ") || "another item";
        found("misattributed", actual);
        errors.push(`comes from ${actual}, not ${cited}: correct its sourceIds`);
      }
      for (const v of report.values.filter((v) => v.source.trim().toLowerCase() === "none")) {
        found("invented-value", v.value);
        errors.push(`states ${v.value}, which no item gives: write <…> for it`);
      }
      if (errors.length) outcome.issues.push({ path: linePath(ctx.paths.get(u.unit) ?? u.unit, line.ref), errors });
    }
    const verdicts = [...new Set(findings.map((f) => f.verdict))];
    if (verdicts.length) outcome.flagged.add(u.unit);
    outcome.records.push({ attempt: ctx.attempt, unit: u.unit, verdicts, findings });
  }
  return outcome;
}

/** `scenarios[2]` + `steps[0]` → `scenarios[2].steps[0]`; the Background's `steps[1]` → `background[1]`. */
function linePath(unitPath: string, ref: string): string {
  if (unitPath === "background") return ref.replace(/^steps/, "background");
  return `${unitPath}.${ref}`;
}

/** On the last attempt: flagged scenarios stay, marked `@unverified` with what the reviewer found. */
export function markUnverified(feature: WrittenFeature, outcome: ScenarioReviewOutcome): WrittenFeature {
  const reasons = new Map(
    outcome.records
      .filter((r) => r.verdicts.length)
      .map((r) => [r.unit, r.findings.map((f) => `review: ${f.ref} ${f.verdict} ${f.sourceIds.join(", ") || "nothing"}${f.detail ? `: ${f.detail}` : ""}`)]),
  );
  const background = reasons.get("background");
  return {
    ...feature,
    ...(background ? { backgroundUnverified: [...(feature.backgroundUnverified ?? []), ...background] } : {}),
    scenarios: feature.scenarios.map((s) => {
      const r = reasons.get(s.id);
      return r ? { ...s, unverified: [...(s.unverified ?? []), ...r] } : s;
    }),
  };
}
