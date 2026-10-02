import { normalize } from "../../extract/evidence.ts";
import { gherkinErrors, type TracedScenario, type WriteTrace } from "../../write/render.ts";
import type { ScenarioReviewRecord, ScenarioReviewVerdict } from "../../write/review.ts";
import type { WriteOutline } from "../../write/schema.ts";
import type { WriteCase } from "./cases.ts";

/** What a Write Run left on disk that the score reads. */
export interface WriteArtifacts {
  outline: WriteOutline;
  /** `03-trace.json`: the scenarios as rendered. */
  trace: WriteTrace;
  reviews: Record<string, ScenarioReviewRecord[]>;
  /** `features/<id>.feature` texts. */
  featureFiles: Record<string, string>;
  /** `run.json` agents, for the outline's refused submissions. */
  agents: { label: string; metrics: { checkFailures: number } }[];
}

export interface WriteScore {
  /** `mustHaveScenarios` labels found in the rendered document. */
  mustHave: { hit: string[]; missed: string[] };
  /** `shouldNotAppear` hits in the rendered document, as label and scenario. */
  stale: { id: string; scenario: string }[];
  /** `expectedOpen` items shown as an @open or @deferred scenario. */
  open: { shown: string[]; missed: string[] };
  /** Outline submissions the coverage and citation checks refused. */
  outlineRejections: number;
  /** Units Scenario Review stopped, by verdict, over every attempt. */
  review: Record<ScenarioReviewVerdict, number>;
  scenarios: number;
  unverified: number;
  unwritten: number;
  uncovered: number;
  /** Written scenarios that are derived or hold a derived Examples block. */
  derived: number;
  notBehavioral: number;
  newFeatures: number;
  /** Scenarios that stand on Features only: Clarify left the Feature without criteria (a gherkin-gap it missed). */
  featureOnly: number;
  /** Scenarios a writer turned open because the outline gave too little. */
  downgraded: number;
  /** `.feature` files that do not parse; always empty unless rendering has a bug. */
  invalidFiles: string[];
}

const norm = (text: string) => normalize(text).toLowerCase();

/** A scenario's text for matching; `derivedOnly` keeps a specified scenario's derived Examples with its steps. */
function scenarioText(s: TracedScenario, derivedOnly = false): string {
  const steps = s.steps.flatMap((st) => [st.text, ...(st.dataTable?.flat() ?? [])]);
  const examples = s.examples.filter((e) => !derivedOnly || s.kind === "derived" || e.derived).flatMap((e) => [e.name, ...e.header, ...e.rows.flatMap((r) => r.cells)]);
  if (derivedOnly && s.kind !== "derived") return examples.length ? norm([...steps, ...examples].join("\n")) : "";
  return norm([s.title, ...steps, ...examples].join("\n"));
}

function scenarioIds(s: TracedScenario): Set<string> {
  return new Set([...s.sourceIds, ...s.steps.flatMap((st) => st.sourceIds), ...s.examples.flatMap((e) => e.rows.flatMap((r) => r.sourceIds))]);
}

function mustHave(labels: WriteCase["mustHaveScenarios"], scenarios: TracedScenario[]) {
  const written = scenarios.filter((s) => s.status === "written");
  const out = { hit: [] as string[], missed: [] as string[] };
  for (const label of labels) {
    const found = written.some((s) => {
      const text = scenarioText(s, label.derived);
      return text && label.all.every((k) => text.includes(norm(k))) && (!label.sourceIds || label.sourceIds.some((id) => scenarioIds(s).has(id)));
    });
    (found ? out.hit : out.missed).push(label.id);
  }
  return out;
}

function stale(labels: WriteCase["shouldNotAppear"], scenarios: TracedScenario[]) {
  return (labels ?? []).flatMap((label) =>
    scenarios.filter((s) => s.status === "written" && label.any.some((k) => scenarioText(s).includes(norm(k)))).map((s) => ({ id: label.id, scenario: s.id })),
  );
}

export function scoreWrite(labels: WriteCase, a: WriteArtifacts): WriteScore {
  const after = a.trace.scenarios;
  const written = after.filter((s) => s.status === "written");
  const planned = new Map(a.outline.scenarios.map((s) => [s.id, s]));

  const review: WriteScore["review"] = { unsupported: 0, contradicts: 0, "invented-value": 0, underived: 0, misattributed: 0 };
  for (const records of Object.values(a.reviews)) for (const r of records) for (const v of r.verdicts) review[v]++;

  const shownOpen = new Set(after.filter((s) => s.kind === "open" || s.kind === "deferred").flatMap((s) => s.agendaIds));

  return {
    mustHave: mustHave(labels.mustHaveScenarios, after),
    stale: stale(labels.shouldNotAppear, after),
    open: {
      shown: (labels.expectedOpen ?? []).filter((id) => shownOpen.has(id)),
      missed: (labels.expectedOpen ?? []).filter((id) => !shownOpen.has(id)),
    },
    outlineRejections: a.agents.filter((x) => x.label === "write-outline").reduce((n, x) => n + x.metrics.checkFailures, 0),
    review,
    scenarios: after.length,
    unverified: written.filter((s) => s.unverified?.length).length,
    unwritten: after.filter((s) => s.status === "unwritten").length,
    uncovered: a.outline.uncovered.length,
    derived: written.filter((s) => s.kind === "derived" || s.examples.some((e) => e.derived)).length,
    notBehavioral: a.outline.notBehavioral.length,
    newFeatures: a.outline.features.filter((f) => f.isNew).length,
    // Open and deferred skeletons naturally cite only their Feature; a specified one doing so restates the Feature.
    featureOnly: a.outline.scenarios.filter((s) => (s.kind === "specified" || s.kind === "derived") && s.effectiveSourceIds.every((id) => id.startsWith("FEAT-"))).length,
    downgraded: written.filter((s) => s.kind === "open" && ["specified", "derived"].includes(planned.get(s.id)?.kind ?? "")).length,
    invalidFiles: Object.entries(a.featureFiles).filter(([, text]) => gherkinErrors(text).length).map(([id]) => id),
  };
}
