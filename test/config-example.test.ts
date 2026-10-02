import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";
import { resolveExportTarget } from "../src/telemetry/setup.ts";

const example = JSON.parse(readFileSync(join(import.meta.dirname, "..", "x-plan.config.example.json"), "utf8"));

test("the example config is valid and leaves tracing off", () => {
  const config = parseConfig(example, "x-plan.config.example.json");
  expect(config.langfuse).toEqual({ baseUrl: "http://localhost:3000", publicKeyEnv: "LANGFUSE_PUBLIC_KEY", secretKeyEnv: "LANGFUSE_SECRET_KEY" });
  expect(resolveExportTarget(config, {})).toEqual({ enabled: false });
  expect(config.stages?.write?.vocabulary?.enabled).toBe(true);
});
