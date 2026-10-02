import { Type, type Static } from "typebox";

const Str = (description: string) => Type.String({ description });
const Ids = (description: string) => Type.Array(Type.String(), { description });

/**
 * specified: what an Acceptance Criterion, Business Rule or Decision states; derived: what one necessarily implies
 * (ADR 0017); open / deferred: a skeleton for a question still unresolved or put off in Clarify.
 */
export const ScenarioKindSchema = Type.Union([Type.Literal("specified"), Type.Literal("derived"), Type.Literal("open"), Type.Literal("deferred")]);
export type ScenarioKind = Static<typeof ScenarioKindSchema>;

export const OutlineScenarioSchema = Type.Object(
  {
    title: Str("The scenario's title as the reader will see it"),
    kind: ScenarioKindSchema,
    sourceIds: Ids("Ids from <aligned> this scenario stands on; only ids listed as citable in <coverage>"),
    agendaIds: Ids("open / deferred: the unresolved or deferred Agenda Items this scenario leaves open; otherwise empty"),
    openReason: Type.Optional(Str("open with no Agenda Item: what is missing, e.g. no acceptance criterion says what the result is")),
  },
  { additionalProperties: false },
);
export type OutlineScenario = Static<typeof OutlineScenarioSchema>;

export const OutlineRuleSchema = Type.Object(
  {
    sourceId: Str("The Business Rule, or the active Decision that replaced it, this Rule block stands for"),
    title: Str("The rule as the reader will see it"),
    scenarios: Type.Array(OutlineScenarioSchema),
  },
  { additionalProperties: false },
);
export type OutlineRule = Static<typeof OutlineRuleSchema>;

export const OutlineFeatureSchema = Type.Object(
  {
    featureId: Type.Optional(Str("A FEAT id from <aligned>; leave out for a new Feature")),
    newFeature: Type.Optional(
      Type.Object(
        {
          name: Type.String(),
          description: Type.String(),
          sourceIds: Ids("Must include an active Decision whose effect is new"),
        },
        { additionalProperties: false },
      ),
    ),
    rules: Type.Array(OutlineRuleSchema),
    scenarios: Type.Array(OutlineScenarioSchema, { description: "Scenarios that belong to no Rule" }),
  },
  { additionalProperties: false },
);
export type OutlineFeature = Static<typeof OutlineFeatureSchema>;

/** Parameters of `submit_outline` (ADR 0015): which scenarios to write and what each stands on, no steps. */
export const OutlineSubmissionSchema = Type.Object(
  {
    features: Type.Array(OutlineFeatureSchema),
    notBehavioral: Type.Array(
      Type.Object(
        {
          id: Str("A Decision listed as notBehavioralAllowed in <coverage>"),
          reason: Str("Why it describes no behaviour, e.g. it only defines a term"),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type OutlineSubmission = Static<typeof OutlineSubmissionSchema>;

/** An outline scenario as accepted, with the SCN id the program gave it. */
export interface PlannedScenario extends OutlineScenario {
  id: string;
  featureId: string;
  /** Index into the Feature's `rules`; absent for a scenario that belongs to no Rule. */
  ruleIndex?: number;
  /** `sourceIds` plus the Rule's source: what the scenario stands on. */
  effectiveSourceIds: string[];
}

export interface PlannedFeature {
  /** A Brief FEAT id, or `FEAT-N<n>` for a Feature Clarify added. */
  id: string;
  isNew: boolean;
  name: string;
  description: string;
  /** New Features: the Decisions they stand on; empty for Brief Features. */
  sourceIds: string[];
  rules: { sourceId: string; title: string; scenarioIds: string[] }[];
  /** Scenarios that belong to no Rule. */
  scenarioIds: string[];
}

/** The accepted outline (ADR 0015), saved as `03-outline.json`; writers and rendering follow it. */
export interface WriteOutline {
  features: PlannedFeature[];
  /** In reading order: each Feature's Rules' scenarios, then its own. */
  scenarios: PlannedScenario[];
  notBehavioral: OutlineSubmission["notBehavioral"];
  /** What the last attempt still left uncovered; listed in `03-spec.md`. */
  uncovered: string[];
}

export const StepSchema = Type.Object(
  {
    keyword: Type.Union([Type.Literal("Given"), Type.Literal("When"), Type.Literal("Then"), Type.Literal("And"), Type.Literal("But")]),
    text: Str("The step without its keyword"),
    sourceIds: Ids("Ids from <sources> or <context> this step stands on"),
    dataTable: Type.Optional(Type.Array(Type.Array(Type.String()), { description: "Rows of a Gherkin data table, the first row as header" })),
  },
  { additionalProperties: false },
);
export type Step = Static<typeof StepSchema>;

export const ExamplesSchema = Type.Object(
  {
    name: Str("The Examples block's name, e.g. stated in the requirements / boundaries"),
    derived: Type.Boolean({ description: "true when every row is derived rather than stated (ADR 0017)" }),
    header: Type.Array(Type.String(), { description: "Column names, each used as <name> in the steps" }),
    rows: Type.Array(
      Type.Object(
        {
          cells: Type.Array(Type.String()),
          sourceIds: Ids("Ids from <sources> or <context> this row stands on"),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type Examples = Static<typeof ExamplesSchema>;

export const WrittenScenarioSchema = Type.Object(
  {
    id: Str("SCN id from <feature>"),
    openReason: Type.Optional(Str("Only when the scenario cannot be written from <sources>: why; it becomes open")),
    steps: Type.Array(StepSchema),
    examples: Type.Array(ExamplesSchema, { description: "Non-empty makes this a Scenario Outline" }),
  },
  { additionalProperties: false },
);
export type WrittenScenario = Static<typeof WrittenScenarioSchema>;

/** Parameters of `submit_feature`: the steps of one Feature's scenarios, whose set the outline fixed. */
export const FeatureSubmissionSchema = Type.Object(
  {
    description: Str("The Feature's description"),
    background: Type.Array(StepSchema, { description: "Given steps shared by every scenario; may be empty" }),
    scenarios: Type.Array(WrittenScenarioSchema),
  },
  { additionalProperties: false },
);
export type FeatureSubmission = Static<typeof FeatureSubmissionSchema>;
