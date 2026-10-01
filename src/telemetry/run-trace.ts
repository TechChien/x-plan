import { TraceFlags, type Link, type Span } from "@opentelemetry/api";
import type { StageName } from "../config.ts";
import { closeOpenSpans, failSpan, inSpan } from "./spans.ts";

/** One process's trace of a Run, as `run.json` records it so Feedback can find the span behind an item. */
export interface TraceRecord {
  traceId: string;
  rootSpanId: string;
  startedAt: string;
  /** Task label → span id of its `invoke_agent` span. */
  spans: Record<string, string>;
}

/** `run.json`'s `telemetry`: one trace per process that worked on the Run, oldest first (a Clarify Run is resumable). */
export interface RunTelemetry {
  traces: TraceRecord[];
}

let current: TraceRecord | undefined;

export interface RunTraceOptions {
  stage: StageName;
  runId: string;
  /** Earlier traces this one continues or reads from. */
  links?: Link[];
  /** e.g. the upstream Run id. */
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Runs a Stage inside the root span of this process's trace. Every process is its own trace; the Run id is the
 * session that ties a resumed Run's traces together. A report with status `failed` marks the root failed.
 */
export function traceRun<R extends { status: string; failures: string[] }>(opts: RunTraceOptions, fn: () => Promise<R>): Promise<R> {
  return inSpan(
    `x-plan ${opts.stage}`,
    {
      "xplan.stage": opts.stage,
      "xplan.run.id": opts.runId,
      "session.id": opts.runId,
      "langfuse.session.id": opts.runId,
      ...opts.attributes,
    },
    async (root) => {
      const ctx = root.spanContext();
      current = root.isRecording() ? { traceId: ctx.traceId, rootSpanId: ctx.spanId, startedAt: new Date().toISOString(), spans: {} } : undefined;
      try {
        const report = await fn();
        if (report.status === "failed") failSpan(root, report.failures.join("; ") || "failed");
        return report;
      } finally {
        current = undefined;
        // A step that threw before ending its span would otherwise never be exported.
        closeOpenSpans(root);
      }
    },
    opts.links,
  );
}

/** Remembers which span ran the task labelled `label`, for `run.json`. */
export function recordAgentSpan(label: string, span: Span): void {
  if (current && span.isRecording()) current.spans[label] = span.spanContext().spanId;
}

/** `run.json`'s `telemetry`: the earlier traces plus this process's, or undefined when nothing was traced. */
export function runTelemetry(previous?: RunTelemetry): RunTelemetry | undefined {
  const traces = (previous?.traces ?? []).filter((t) => t.traceId !== current?.traceId);
  if (current) traces.push({ ...current, spans: { ...current.spans } });
  return traces.length ? { traces } : undefined;
}

/** Links to the root spans of a Run's recorded traces. */
export function linksTo(telemetry: RunTelemetry | undefined, relation: "resumes" | "upstream", which: "all" | "last" = "all"): Link[] {
  const traces = telemetry?.traces ?? [];
  return (which === "last" ? traces.slice(-1) : traces).map((t) => ({
    context: { traceId: t.traceId, spanId: t.rootSpanId, traceFlags: TraceFlags.SAMPLED },
    attributes: { "xplan.link": relation },
  }));
}
