import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";
import { resolveExportTarget, startTelemetry } from "../src/telemetry/setup.ts";
import { CollectingExporter } from "./helpers/spans.ts";
import { captureContent, inSpan, interruptOpenSpans, startSpan } from "../src/telemetry/spans.ts";

const config = (extra: Record<string, unknown> = {}) => parseConfig({ provider: { baseUrl: "http://unused" }, ...extra });
const langfuse = { langfuse: { baseUrl: "http://lf.local:3000/" } };
const keys = { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" };

describe("resolveExportTarget", () => {
  test("off by default", () => {
    expect(resolveExportTarget(config(), {})).toEqual({ enabled: false });
  });

  test("a standard OTLP endpoint variable turns it on and is used as is", () => {
    expect(resolveExportTarget(config(), { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" })).toEqual({ enabled: true, via: "otel-env" });
    expect(resolveExportTarget(config(langfuse), { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c/v1/traces", ...keys })).toEqual({ enabled: true, via: "otel-env" });
  });

  test("enabled: false wins over the environment, OTEL_SDK_DISABLED over everything", () => {
    expect(resolveExportTarget(config({ telemetry: { enabled: false } }), { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c" })).toEqual({ enabled: false });
    expect(resolveExportTarget(config({ telemetry: { enabled: true } }), { OTEL_SDK_DISABLED: "true" })).toEqual({ enabled: false });
  });

  test("enabled with Langfuse configured: endpoint and Basic auth derived from its keys", () => {
    expect(resolveExportTarget(config({ telemetry: { enabled: true }, ...langfuse }), keys)).toEqual({
      enabled: true,
      via: "langfuse",
      url: "http://lf.local:3000/api/public/otel/v1/traces",
      headers: { Authorization: `Basic ${Buffer.from("pk:sk").toString("base64")}` },
    });
  });

  test("Langfuse configured without its keys is an error that names the variable", () => {
    expect(() => resolveExportTarget(config({ telemetry: { enabled: true }, ...langfuse }), { LANGFUSE_PUBLIC_KEY: "pk" })).toThrow(/LANGFUSE_SECRET_KEY is not set/);
  });

  test("enabled with nothing else: the OTel default endpoint", () => {
    expect(resolveExportTarget(config({ telemetry: { enabled: true } }), {})).toEqual({ enabled: true, via: "default" });
  });
});

describe("startTelemetry", () => {
  const on = config({ telemetry: { enabled: true, captureContent: true } });

  test("registers a tracer whose active spans nest, and unregisters on shutdown", async () => {
    const exporter = new CollectingExporter();
    const telemetry = await startTelemetry(on, { log: () => {}, env: {}, exporter });
    expect(telemetry.enabled).toBe(true);
    expect(captureContent()).toBe(true);
    await inSpan("outer", {}, async () => inSpan("inner", {}, async () => {}));
    await telemetry.shutdown();
    await telemetry.shutdown();

    const [inner, outer] = exporter.spans;
    expect(inner!.parentSpanContext?.spanId).toBe(outer!.spanContext().spanId);
    expect(captureContent()).toBe(false);

    // Unregistered: a second start in the same process registers again.
    const again = new CollectingExporter();
    const second = await startTelemetry(on, { log: () => {}, env: {}, exporter: again });
    await inSpan("later", {}, async () => {});
    await second.shutdown();
    expect(again.spans.map((s) => s.name)).toEqual(["later"]);
  });

  test("an exception marks the span failed and still ends it", async () => {
    const exporter = new CollectingExporter();
    const telemetry = await startTelemetry(on, { log: () => {}, env: {}, exporter });
    await expect(inSpan("boom", {}, async () => Promise.reject(new Error("bad")))).rejects.toThrow("bad");
    await telemetry.shutdown();
    expect(exporter.spans[0]).toMatchObject({ name: "boom", status: { code: 2, message: "bad" } });
  });

  test("an interruption ends open spans as interrupted", async () => {
    const exporter = new CollectingExporter();
    const telemetry = await startTelemetry(on, { log: () => {}, env: {}, exporter });
    startSpan("waiting", {});
    interruptOpenSpans();
    await telemetry.shutdown();
    expect(exporter.spans[0]).toMatchObject({ name: "waiting", attributes: { "xplan.interrupted": true }, status: { code: 2, message: "interrupted" } });
  });

  test("a failing exporter is reported once and does not throw", async () => {
    const failing: SpanExporter = {
      export: (_spans: ReadableSpan[], done) => done({ code: 1, error: new Error("connection refused") }),
      shutdown: async () => {},
    };
    const logs: string[] = [];
    const telemetry = await startTelemetry(on, { log: (m) => logs.push(m), env: {}, exporter: failing });
    await inSpan("a", {}, async () => {});
    await inSpan("b", {}, async () => {});
    await telemetry.shutdown();
    expect(logs.filter((l) => l.startsWith("warning"))).toEqual(["warning: could not export spans (connection refused); the Run continues, local traces are complete"]);
  });

  test("a Langfuse block without keys leaves tracing off with a warning", async () => {
    const logs: string[] = [];
    const telemetry = await startTelemetry(config({ telemetry: { enabled: true }, ...langfuse }), { log: (m) => logs.push(m), env: {} });
    expect(telemetry.enabled).toBe(false);
    expect(logs).toEqual(["warning: tracing is off: config langfuse is set but LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY is not set"]);
  });
});
