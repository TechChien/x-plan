import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { StageName } from "../config.ts";
import type { Provenance } from "../extract/provenance.ts";
import type { RequirementBrief } from "../extract/schema.ts";
import { readRunMeta } from "../shared/runs.ts";
import type { TraceRecord } from "../telemetry/run-trace.ts";
import type { TraceRef } from "./schema.ts";

interface BinSummary {
  index: number;
  segments: { path: string; lines: string }[];
}

/** What Feedback needs from the Run it is about: its output, where each item came from, and its traces. */
export interface RunView {
  dir: string;
  id: string;
  stage: StageName;
  status: string;
  /** An Extract Run's Brief. */
  brief?: RequirementBrief;
  provenance?: Provenance;
  bins: BinSummary[];
  /** The last trace of the Run, if it was traced. */
  trace?: TraceRecord;
  /** Every trace, oldest first: a Write Run rewritten with --only has a trace per process. */
  traces: TraceRecord[];
  /** A Write Run's scenarios as `03-trace.json` records them. */
  scenarios?: WriteScenario[];
  /** A Write Run's Features: the batch that wrote each, which names its writer. */
  features?: Record<string, { status: string; batch: string }>;
}

/** The part of a `03-trace.json` scenario Feedback relies on; the rest is kept as the snapshot. */
interface WriteScenario {
  id: string;
  featureId: string;
  status: "written" | "unwritten";
}

export function openRun(dir: string): RunView {
  const meta = readRunMeta(dir) as
    | (ReturnType<typeof readRunMeta> & { provenance?: Provenance; bins?: BinSummary[]; features?: Record<string, { status: string; batch: string }> })
    | undefined;
  if (!meta?.stage) throw new Error(`${dir} is not a Run (no run.json with a stage)`);
  const briefPath = join(dir, "01-brief.json");
  const tracePath = join(dir, "03-trace.json");
  return {
    dir,
    id: basename(dir),
    stage: meta.stage,
    status: meta.status,
    ...(meta.stage === "extract" && existsSync(briefPath) ? { brief: JSON.parse(readFileSync(briefPath, "utf8")) as RequirementBrief } : {}),
    ...(meta.provenance ? { provenance: meta.provenance } : {}),
    bins: meta.bins ?? [],
    ...(meta.telemetry?.traces.length ? { trace: meta.telemetry.traces.at(-1) } : {}),
    traces: meta.telemetry?.traces ?? [],
    ...(meta.stage === "write" && existsSync(tracePath) ? { scenarios: (JSON.parse(readFileSync(tracePath, "utf8")) as { scenarios: WriteScenario[] }).scenarios } : {}),
    ...(meta.features ? { features: meta.features } : {}),
  };
}

/** The Brief item with this id and its section; for a Write Run, the scenario. */
export function findItem(run: RunView, id: string): { section: string; item: unknown } {
  if (run.stage === "write") return { section: "scenarios", item: findScenario(run, id) };
  if (run.stage !== "extract") {
    throw new Error(`Feedback on the items of a ${run.stage} Run (Decisions, questions) is not supported yet; use --score or --missing`);
  }
  if (!run.brief) throw new Error(`Run ${run.id} has no 01-brief.json to give Feedback on`);
  for (const [section, items] of Object.entries(run.brief)) {
    if (section === "traceability") continue;
    const item = (items as { id: string }[]).find((i) => i.id === id);
    if (item) return { section, item };
  }
  throw new Error(`No item ${id} in the Brief of Run ${run.id}`);
}

function findScenario(run: RunView, id: string): WriteScenario {
  if (!/^SCN-\d+$/.test(id)) throw new Error(`Feedback on a Write Run is about its scenarios (SCN-n), as tagged in the .feature files; ${id} is not one`);
  if (!run.scenarios) throw new Error(`Run ${run.id} has no 03-trace.json to give Feedback on`);
  const scenario = run.scenarios.find((s) => s.id === id);
  if (!scenario) throw new Error(`No scenario ${id} in Write Run ${run.id}`);
  if (scenario.status !== "written") {
    throw new Error(`${id} was not written (@unwritten); rewrite it with x-plan write <run> --only ${scenario.featureId}, or record what is missing with --missing`);
  }
  return scenario;
}

/** The label of the writer that wrote a Write Run's Feature: a rewrite's carries its batch. */
function writerLabel(run: RunView, featureId: string): string {
  const batch = run.features?.[featureId]?.batch ?? "initial";
  return batch === "initial" ? `write-${featureId}` : `write-${featureId}-${batch}`;
}

/** The span of the session whose text the item kept; the other contributing sessions go along as a note. */
export function itemTrace(run: RunView, id: string): TraceRef | undefined {
  if (!run.trace) return undefined;
  if (run.stage === "write") return spanRef(run, [writerLabel(run, findScenario(run, id).featureId)]);
  const source = run.provenance?.[id];
  if (!source) return { traceId: run.trace.traceId };
  return spanRef(run, [source.text, ...source.evidence.filter((l) => l !== source.text)]);
}

/**
 * Parses `file:line` and finds the facts sessions that read that line, context excluded. For a Write Run, `at` names
 * the Feature a missing scenario belongs to, and the session is that Feature's writer.
 */
export function locate(run: RunView, at: string): string[] {
  if (run.stage === "write") {
    if (!/^FEAT-N?\d+$/.test(at)) throw new Error("For a Write Run, --at names the Feature the missing scenario belongs to, e.g. FEAT-2");
    const features = Object.keys(run.features ?? {});
    if (!features.includes(at)) throw new Error(`Write Run ${run.id} has no ${at}; its Features are ${features.join(", ")}`);
    return [writerLabel(run, at)];
  }
  const match = /^(.+):(\d+)$/.exec(at);
  if (!match) throw new Error(`--at must be file:line, e.g. prd.md:57; got ${at}`);
  if (run.stage !== "extract") throw new Error(`--at applies only to Extract Runs, which read the Source Documents`);
  const [, file, lineText] = match as unknown as [string, string, string];
  const line = Number(lineText);
  const segments = run.bins.flatMap((b) => b.segments.map((s) => ({ label: `facts-bin${b.index}`, path: s.path, range: s.lines.split("-").map(Number) as [number, number] })));
  const ofFile = segments.filter((s) => s.path === file);
  if (!ofFile.length) {
    throw new Error(`Run ${run.id} read no ${file}; its documents are ${[...new Set(segments.map((s) => s.path))].join(", ")}`);
  }
  const labels = [...new Set(ofFile.filter((s) => s.range[0] <= line && line <= s.range[1]).map((s) => s.label))];
  if (!labels.length) throw new Error(`${file} has no line ${line} in Run ${run.id}; it read lines ${ofFile.map((s) => s.range.join("-")).join(", ")}`);
  return labels;
}

/** A Feedback about the Run as a whole, or about the sessions that read a given line. */
export function runTrace(run: RunView, labels: string[] = []): TraceRef | undefined {
  if (!run.trace) return undefined;
  return labels.length ? spanRef(run, labels) : { traceId: run.trace.traceId };
}

/** The span of the first label, in whichever of the Run's traces recorded it; else the last trace as a whole. */
function spanRef(run: RunView, labels: string[]): TraceRef {
  const [first, ...others] = labels;
  const trace = (first ? run.traces.findLast((t) => t.spans[first]) : undefined) ?? run.trace!;
  const spanId = first ? trace.spans[first] : undefined;
  return { traceId: trace.traceId, ...(spanId ? { spanId } : {}), ...(others.length ? { otherSources: others } : {}) };
}
