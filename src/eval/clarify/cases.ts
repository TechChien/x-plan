import { readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { parse as parseYaml } from "yaml";
import { OUTPUT_LANGUAGES } from "../../shared/language.ts";

const Keywords = Type.Array(Type.String(), { minItems: 1 });

/** A Decision the Answer should produce: its conclusion contains ALL keywords. */
const ExpectedDecision = Type.Object({
  all: Keywords,
  /** Each group matches one Brief item the Decision must supersede (ALL keywords of the group in that item). */
  supersedes: Type.Optional(Type.Array(Keywords)),
  /** The Decision must confirm the label's target (an assumption). */
  confirms: Type.Optional(Type.Boolean()),
});
export type ExpectedDecision = Static<typeof ExpectedDecision>;

/** A reply as typed at the terminal, or several lines (notes first, then the answer). */
const Reply = Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })]);

/**
 * Human-annotated script and ground truth for one Clarify eval case. The Brief is a fixed fixture, so Brief
 * items are matched by id; follow-up questions, which the model words, are matched by keywords.
 */
export const ClarifyCaseSchema = Type.Object({
  description: Type.Optional(Type.String()),
  /** Output language of the session; keywords are written in it. Default en. */
  language: Type.Optional(Type.Union(OUTPUT_LANGUAGES.map((l) => Type.Literal(l)))),
  answers: Type.Array(
    Type.Object({
      id: Type.String(),
      /** The Agenda Item this label answers. */
      target: Type.String(),
      reply: Reply,
      expectDecisions: Type.Optional(Type.Array(ExpectedDecision)),
      /** The reply is deliberately vague: a follow-up question is expected. */
      ambiguous: Type.Optional(Type.Boolean()),
      /** The recommendation first shown for the target should contain ANY keyword. */
      goodRecommendation: Type.Optional(Type.Object({ any: Keywords })),
      /** Answers a follow-up of the target whose question contains ANY keyword. */
      followUpReply: Type.Optional(Type.Object({ any: Keywords, reply: Reply, expectDecisions: Type.Optional(Type.Array(ExpectedDecision)) })),
    }),
  ),
  /** Gherkin gaps the model should raise: a gap question whose relatedIds include every id. */
  gaps: Type.Optional(Type.Array(Type.Object({ id: Type.String(), relatedIds: Type.Array(Type.String(), { minItems: 1 }), reply: Type.Optional(Reply) }))),
  /** Reply to every question no label matches; each one counts as noise. Default /na. */
  unmatchedReply: Type.Optional(Type.String()),
});
export type ClarifyCase = Static<typeof ClarifyCaseSchema>;
export type AnswerLabel = ClarifyCase["answers"][number];

export function loadClarifyCase(path: string): ClarifyCase {
  const raw = parseYaml(readFileSync(path, "utf8"));
  if (!Value.Check(ClarifyCaseSchema, raw)) {
    const errors = [...Value.Errors(ClarifyCaseSchema, raw)].map((e) => `${e.instancePath || "/"} ${e.message}`);
    throw new Error(`Invalid ${path}:\n  ${errors.join("\n  ")}`);
  }
  return raw;
}
