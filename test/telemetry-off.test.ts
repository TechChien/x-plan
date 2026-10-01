import { expect, test, vi } from "vitest";
import { parseConfig } from "../src/config.ts";
import { startTelemetry } from "../src/telemetry/setup.ts";
import { inSpan } from "../src/telemetry/spans.ts";

const loaded: string[] = [];
vi.mock("@opentelemetry/sdk-trace-node", () => {
  loaded.push("sdk-trace-node");
  return {};
});
vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => {
  loaded.push("exporter-trace-otlp-proto");
  return {};
});

test("with tracing off the SDK is never loaded and spans are no-ops", async () => {
  const telemetry = await startTelemetry(parseConfig({ provider: { baseUrl: "http://unused" } }), { log: () => {}, env: {} });
  expect(telemetry.enabled).toBe(false);
  const result = await inSpan("noop", {}, async (span) => span.isRecording());
  expect(result).toBe(false);
  await telemetry.shutdown();
  expect(loaded).toEqual([]);
});
