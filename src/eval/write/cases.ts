import { readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { parse as parseYaml } from "yaml";

const Keywords = Type.Array(Type.String(), { minItems: 1 });

/**
 * Human-annotated ground truth for one Write eval case. The Aligned Brief is a fixed fixture (`write/aligned.json`),
 * so its ids are stable; scenarios, which the model words and numbers, are matched by keywords.
 */
export const WriteCaseSchema = Type.Object({
  description: Type.Optional(Type.String()),
  /**
   * Scenarios the document must have: some written scenario contains ALL keywords and, when `sourceIds` is given,
   * cites ANY of them. `derived: true` looks only at derived content (a derived scenario, or a derived Examples block).
   */
  mustHaveScenarios: Type.Array(
    Type.Object({ id: Type.String(), all: Keywords, sourceIds: Type.Optional(Type.Array(Type.String(), { minItems: 1 })), derived: Type.Optional(Type.Boolean()) }),
  ),
  /** Wording that must appear in no scenario, e.g. a value the user replaced: each scenario containing ANY keyword counts. */
  shouldNotAppear: Type.Optional(Type.Array(Type.Object({ id: Type.String(), any: Keywords, reason: Type.Optional(Type.String()) }))),
  /** Agenda Items that should appear as an @open or @deferred scenario. */
  expectedOpen: Type.Optional(Type.Array(Type.String())),
});
export type WriteCase = Static<typeof WriteCaseSchema>;

export function loadWriteCase(path: string): WriteCase {
  const raw = parseYaml(readFileSync(path, "utf8"));
  if (!Value.Check(WriteCaseSchema, raw)) {
    const errors = [...Value.Errors(WriteCaseSchema, raw)].map((e) => `${e.instancePath || "/"} ${e.message}`);
    throw new Error(`Invalid ${path}:\n  ${errors.join("\n  ")}`);
  }
  return raw;
}
