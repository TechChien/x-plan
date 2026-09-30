import { Type, type Static, type TSchema } from "typebox";

const Str = (description: string) => Type.String({ description });
const StrList = (description: string) => Type.Array(Type.String(), { description });
const Id = (prefix: string) => Type.String({ description: `Unique id, format ${prefix}-<n>, e.g. ${prefix}-1` });
export const Severity = Type.Union([Type.Literal("blocking"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]);
export const Confidence = Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]);

export const EvidenceSchema = Type.Object({
  file: Str("Document path exactly as given in <document path>"),
  lineStart: Type.Integer({ minimum: 1 }),
  lineEnd: Type.Integer({ minimum: 1 }),
  quote: Str("Verbatim text copied from the cited lines"),
});
export type Evidence = Static<typeof EvidenceSchema>;

const EvidenceList = Type.Array(EvidenceSchema, { minItems: 1 });

/** Fact sections: extracted by Facts agents, every item must carry Evidence. */
export const FACT_SECTIONS = {
  actors: {
    prefix: "ACT",
    item: Type.Object({
      id: Id("ACT"),
      name: Type.String(),
      description: Type.String(),
      responsibilities: StrList("What this actor does or is responsible for"),
      evidence: EvidenceList,
    }),
  },
  features: {
    prefix: "FEAT",
    item: Type.Object({
      id: Id("FEAT"),
      name: Type.String(),
      description: Type.String(),
      actorIds: StrList("ACT ids of actors involved"),
      inputs: StrList("Data or triggers the feature takes"),
      outputs: StrList("Data or effects the feature produces"),
      dependsOn: StrList("FEAT or DEP ids this feature depends on"),
      evidence: EvidenceList,
    }),
  },
  businessRules: {
    prefix: "BR",
    item: Type.Object({
      id: Id("BR"),
      rule: Type.String(),
      featureIds: StrList("FEAT ids this rule applies to"),
      conditions: StrList("Conditions under which the rule applies"),
      evidence: EvidenceList,
    }),
  },
  acceptanceCriteria: {
    prefix: "AC",
    item: Type.Object({
      id: Id("AC"),
      featureId: Str("FEAT id this criterion verifies"),
      kind: Type.Union([Type.Literal("scenario"), Type.Literal("example"), Type.Literal("hint")]),
      text: Type.String(),
      given: Type.Optional(Type.String()),
      when: Type.Optional(Type.String()),
      then: Type.Optional(Type.String()),
      evidence: EvidenceList,
    }),
  },
  nonFunctional: {
    prefix: "NFR",
    item: Type.Object({
      id: Id("NFR"),
      category: Type.Union(
        ["performance", "security", "availability", "scalability", "reliability", "usability", "maintainability", "compatibility"].map(
          (c) => Type.Literal(c),
        ),
      ),
      requirement: Type.String(),
      metric: Type.Optional(Type.String()),
      target: Type.Optional(Type.String()),
      evidence: EvidenceList,
    }),
  },
  domainEntities: {
    prefix: "ENT",
    item: Type.Object({
      id: Id("ENT"),
      name: Type.String(),
      description: Type.String(),
      attributes: StrList("Attributes or states of the entity"),
      relationships: Type.Array(Type.Object({ targetId: Str("ENT id"), kind: Str("e.g. has-many, belongs-to") })),
      evidence: EvidenceList,
    }),
  },
  glossary: {
    prefix: "TERM",
    item: Type.Object({
      id: Id("TERM"),
      term: Type.String(),
      definition: Type.String(),
      aliases: StrList("Other names used for the same term"),
      evidence: EvidenceList,
    }),
  },
  dependencies: {
    prefix: "DEP",
    item: Type.Object({
      id: Id("DEP"),
      name: Type.String(),
      type: Type.Union(["internal", "external", "system", "service", "data"].map((c) => Type.Literal(c))),
      description: Type.String(),
      evidence: EvidenceList,
    }),
  },
  constraints: {
    prefix: "CON",
    item: Type.Object({
      id: Id("CON"),
      constraint: Type.String(),
      type: Type.Union(["technical", "environment", "regulatory"].map((c) => Type.Literal(c))),
      evidence: EvidenceList,
    }),
  },
  outOfScope: {
    prefix: "OOS",
    item: Type.Object({ id: Id("OOS"), item: Type.String(), evidence: EvidenceList }),
  },
} as const satisfies Record<string, { prefix: string; item: TSchema }>;

export type FactSectionName = keyof typeof FACT_SECTIONS;
export const FACT_SECTION_NAMES = Object.keys(FACT_SECTIONS) as FactSectionName[];

export const OpenQuestionSchema = Type.Object({
  id: Id("OQ"),
  question: Type.String(),
  reason: Str("Why this is unclear, missing or undecidable from the documents"),
  relatedIds: StrList("Ids of related items"),
  severity: Severity,
  evidence: Type.Array(EvidenceSchema, { description: "Where the ambiguity appears; may be empty" }),
});
export type OpenQuestion = Static<typeof OpenQuestionSchema>;

export const ContradictionSchema = Type.Object({
  id: Id("CTR"),
  conflict: Type.String(),
  relatedIds: Type.Array(Type.String(), { minItems: 2 }),
  evidence: Type.Array(EvidenceSchema),
});
export type Contradiction = Static<typeof ContradictionSchema>;

export const AssumptionSchema = Type.Object({
  id: Id("ASM"),
  assumption: Type.String(),
  rationale: Type.String(),
  confidence: Confidence,
  relatedIds: Type.Array(Type.String()),
});
export type Assumption = Static<typeof AssumptionSchema>;

type FactItem<K extends FactSectionName> = Static<(typeof FACT_SECTIONS)[K]["item"]>;
export type Facts = { [K in FactSectionName]: FactItem<K>[] } & { openQuestions: OpenQuestion[] };
export type AnyFactItem = FactItem<FactSectionName>;

/** Parameters of `submit_facts`, restricted to the requested sections. Local open questions are always included. */
export function factsSubmissionSchema(sections: FactSectionName[]) {
  const properties: Record<string, TSchema> = {};
  for (const name of sections) properties[name] = Type.Array(FACT_SECTIONS[name].item);
  properties.openQuestions = Type.Array(OpenQuestionSchema);
  return Type.Object(properties);
}

export const AnalysisSubmissionSchema = Type.Object({
  merges: Type.Array(
    Type.Object({
      keepId: Type.String(),
      dropIds: Type.Array(Type.String(), { minItems: 1 }),
      reason: Type.String(),
    }),
  ),
  contradictions: Type.Array(Type.Object({ conflict: Type.String(), relatedIds: Type.Array(Type.String(), { minItems: 2 }) })),
  openQuestions: Type.Array(
    Type.Object({ question: Type.String(), reason: Type.String(), relatedIds: Type.Array(Type.String()), severity: Severity }),
  ),
  assumptions: Type.Array(
    Type.Object({ assumption: Type.String(), rationale: Type.String(), confidence: Confidence, relatedIds: Type.Array(Type.String()) }),
  ),
  // Closed: Analysis has no operation that answers or removes an open question (ADR 0003).
}, { additionalProperties: false });
export type AnalysisSubmission = Static<typeof AnalysisSubmissionSchema>;

export interface RejectedItem {
  section: string;
  item: unknown;
  errors: string[];
  /** Which step rejected it. */
  stage: "facts" | "analysis";
  bin?: number;
}

export interface TraceabilityEntry {
  file: string;
  itemIds: string[];
}

export type RequirementBrief = { [K in FactSectionName]: FactItem<K>[] } & {
  openQuestions: OpenQuestion[];
  contradictions: Contradiction[];
  assumptions: Assumption[];
  traceability: TraceabilityEntry[];
};
