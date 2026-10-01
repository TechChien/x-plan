import { readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { parse as parseYaml } from "yaml";
import { OUTPUT_LANGUAGES } from "../shared/language.ts";

const Keywords = Type.Array(Type.String(), { minItems: 1 });
/** A question label: matches an open question whose text contains ANY keyword. */
const QuestionLabel = Type.Object({ id: Type.String(), any: Keywords });

/**
 * Human-annotated ground truth for one eval case. Items are matched by keywords (normalized, case-insensitive)
 * against an item's text, never by id, because ids are assigned by the model.
 */
export const ExpectedSchema = Type.Object({
  description: Type.Optional(Type.String()),
  packing: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("per-file")])),
  /** Output language of the Run; the keywords below are written in it. Default en. */
  language: Type.Optional(Type.Union(OUTPUT_LANGUAGES.map((l) => Type.Literal(l)))),
  /** Globs (relative to `docs/`) marking Reference Documents. */
  reference: Type.Optional(Type.Array(Type.String())),
  /** Facts that must be extracted: an item in one of `section` whose text contains ALL keywords. */
  expect: Type.Array(
    Type.Object({
      id: Type.String(),
      section: Type.Union([Type.String(), Type.Array(Type.String())]),
      all: Keywords,
    }),
  ),
  /** Each group matches one side of the conflict: a contradiction whose related items match every group. */
  contradictions: Type.Optional(Type.Array(Type.Object({ id: Type.String(), between: Type.Array(Keywords, { minItems: 2 }) }))),
  openQuestions: Type.Optional(
    Type.Object({
      /** Genuinely unanswered by the documents: the Brief must ask them. */
      mustBeRaised: Type.Optional(Type.Array(QuestionLabel)),
      /** Answered somewhere in the documents (often in a batch the asking agent could not see): asking is noise. */
      shouldNotBeRaised: Type.Optional(Type.Array(QuestionLabel)),
    }),
  ),
  assumptions: Type.Optional(
    Type.Object({
      /**
       * Open questions whose answer Analysis must not write down as an Assumption (the question stays and the user
       * answers it in Clarify). Hit when an assumption's statement contains ANY keyword.
       */
      shouldNotDuplicate: Type.Optional(Type.Array(QuestionLabel)),
    }),
  ),
  /**
   * Noise: content the Brief should not contain, such as reference material the requirements do not need.
   * Hit when an item in one of `section` (default: every section) contains ANY keyword.
   */
  unexpected: Type.Optional(
    Type.Array(Type.Object({ id: Type.String(), section: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])), any: Keywords })),
  ),
});
export type Expected = Static<typeof ExpectedSchema>;

export function loadExpected(path: string): Expected {
  const raw = parseYaml(readFileSync(path, "utf8"));
  if (!Value.Check(ExpectedSchema, raw)) {
    const errors = [...Value.Errors(ExpectedSchema, raw)].map((e) => `${e.instancePath || "/"} ${e.message}`);
    throw new Error(`Invalid ${path}:\n  ${errors.join("\n  ")}`);
  }
  return raw;
}
