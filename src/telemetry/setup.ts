import { context, propagation, trace } from "@opentelemetry/api";
import type { SpanExporter } from "@opentelemetry/sdk-trace-node";
import type { XPlanConfig } from "../config.ts";
import { langfuseCredentials } from "../shared/langfuse.ts";
import { interruptOpenSpans, setCaptureContent } from "./spans.ts";

/** Where spans go. `url` and `headers` are omitted when the standard OTEL_EXPORTER_OTLP_* variables apply. */
export type ExportTarget =
  | { enabled: false }
  | { enabled: true; via: "otel-env" | "langfuse" | "default"; url?: string; headers?: Record<string, string> };

const ENDPOINT_VARS = ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT"];

/**
 * Decides whether to trace and where to (ADR 0013). OTEL_SDK_DISABLED wins; then `telemetry.enabled`; without it,
 * a standard OTLP endpoint variable turns tracing on. The standard variables also win over a derived Langfuse
 * endpoint, so the usual OTel setup works unchanged.
 */
export function resolveExportTarget(config: XPlanConfig, env: NodeJS.ProcessEnv = process.env): ExportTarget {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return { enabled: false };
  const hasEndpoint = ENDPOINT_VARS.some((v) => env[v]);
  if (!(config.telemetry?.enabled ?? hasEndpoint)) return { enabled: false };
  if (hasEndpoint) return { enabled: true, via: "otel-env" };
  const langfuse = langfuseCredentials(config, env);
  if (langfuse) return { enabled: true, via: "langfuse", url: `${langfuse.baseUrl}/api/public/otel/v1/traces`, headers: { Authorization: langfuse.authorization } };
  return { enabled: true, via: "default" };
}

export interface Telemetry {
  readonly enabled: boolean;
  /** Flushes and stops tracing; waits at most `SHUTDOWN_TIMEOUT_MS`. Safe to call more than once. */
  shutdown(): Promise<void>;
}

export const SHUTDOWN_TIMEOUT_MS = 5000;

export interface StartOptions {
  log: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Replaces the OTLP exporter; spans are then exported one by one (tests). */
  exporter?: SpanExporter;
  /** Flush and exit with 130 on Ctrl+C. Off in tests. */
  handleSignals?: boolean;
}

/**
 * Registers the OTel SDK when tracing is on. When it is off, nothing beyond `@opentelemetry/api` is loaded and every
 * span is a no-op. Export failures are reported once and never fail the Run.
 */
export async function startTelemetry(config: XPlanConfig, opts: StartOptions): Promise<Telemetry> {
  let target: ExportTarget;
  try {
    target = resolveExportTarget(config, opts.env);
  } catch (error) {
    opts.log(`warning: tracing is off: ${error instanceof Error ? error.message : String(error)}`);
    return { enabled: false, shutdown: async () => {} };
  }
  if (!target.enabled) return { enabled: false, shutdown: async () => {} };

  const [{ NodeTracerProvider, BatchSpanProcessor, SimpleSpanProcessor }, { resourceFromAttributes }] = await Promise.all([
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/resources"),
  ]);
  const exporter = warnOnFailure(
    opts.exporter ?? new (await import("@opentelemetry/exporter-trace-otlp-proto")).OTLPTraceExporter({ ...(target.url ? { url: target.url } : {}), ...(target.headers ? { headers: target.headers } : {}) }),
    opts.log,
  );
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": opts.env?.OTEL_SERVICE_NAME ?? process.env.OTEL_SERVICE_NAME ?? "x-plan" }),
    spanProcessors: [opts.exporter ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter)],
  });
  provider.register();
  setCaptureContent(config.telemetry?.captureContent ?? false);

  let stopped: Promise<void> | undefined;
  const onSigint = () => {
    interruptOpenSpans();
    void shutdown().finally(() => process.exit(130));
  };
  const shutdown = () =>
    (stopped ??= (async () => {
      process.off("SIGINT", onSigint);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), SHUTDOWN_TIMEOUT_MS);
      });
      const result = await Promise.race([provider.shutdown().then(() => "done" as const), timeout]).catch((error: unknown) => {
        opts.log(`warning: tracing shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        return "done" as const;
      });
      clearTimeout(timer);
      if (result === "timeout") opts.log(`warning: spans not flushed within ${SHUTDOWN_TIMEOUT_MS / 1000}s; some may be lost`);
      // Unregister, so a later startTelemetry in the same process (tests) can register again.
      trace.disable();
      context.disable();
      propagation.disable();
      setCaptureContent(false);
    })());
  if (opts.handleSignals) process.on("SIGINT", onSigint);
  opts.log(`Tracing to ${target.url ?? (target.via === "otel-env" ? "the OTEL_EXPORTER_OTLP_* endpoint" : "http://localhost:4318")}`);
  return { enabled: true, shutdown };
}

/** OTLP `ExportResultCode.SUCCESS`; the enum lives in @opentelemetry/core, which x-plan does not depend on. */
const EXPORT_SUCCESS = 0;

/** Wraps an exporter so the first failed export prints one warning instead of failing silently. */
function warnOnFailure(inner: SpanExporter, log: (message: string) => void): SpanExporter {
  let warned = false;
  return {
    export: (spans, done) =>
      inner.export(spans, (result) => {
        if (result.code !== EXPORT_SUCCESS && !warned) {
          warned = true;
          log(`warning: could not export spans (${result.error?.message ?? "unknown error"}); the Run continues, local traces are complete`);
        }
        done(result);
      }),
    shutdown: () => inner.shutdown(),
    ...(inner.forceFlush ? { forceFlush: () => inner.forceFlush!() } : {}),
  };
}
