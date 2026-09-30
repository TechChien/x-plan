import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/** Sent as-is as `reasoning_effort`; which values are accepted depends on the served model. */
export const ThinkingLevelSchema = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")]);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

const StageOverrideSchema = Type.Object({ thinking: Type.Optional(ThinkingLevelSchema) });

export const ConfigSchema = Type.Object({
  provider: Type.Object({
    baseUrl: Type.String(),
    apiKeyEnv: Type.String({ default: "XPLAN_API_KEY" }),
    model: Type.String({ default: "gpt-oss-120b" }),
    contextWindow: Type.Integer({ default: 131072 }),
    maxOutputTokens: Type.Integer({ default: 16384 }),
    /** Overrides for PI's OpenAI-compatible request shaping (supportsDeveloperRole, maxTokensField, ...). */
    compat: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
  thinking: Type.Optional(ThinkingLevelSchema),
  stages: Type.Optional(
    Type.Object({
      extract: Type.Optional(StageOverrideSchema),
      clarify: Type.Optional(StageOverrideSchema),
      write: Type.Optional(StageOverrideSchema),
    }),
  ),
  concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
  promptsDir: Type.Optional(Type.String()),
});
export type XPlanConfig = Static<typeof ConfigSchema>;

export type StageName = "extract" | "clarify" | "write";

export const CONFIG_FILE_NAME = "x-plan.config.json";

/** Looks in cwd first, then ~/.x-plan/. */
export function findConfigPath(cwd: string): string | undefined {
  const candidates = [join(cwd, CONFIG_FILE_NAME), join(homedir(), ".x-plan", CONFIG_FILE_NAME)];
  return candidates.find((p) => existsSync(p));
}

export function loadConfig(cwd: string, explicitPath?: string): XPlanConfig {
  const path = explicitPath ? resolve(cwd, explicitPath) : findConfigPath(cwd);
  if (!path) {
    throw new Error(`No ${CONFIG_FILE_NAME} found in ${cwd} or ~/.x-plan/. See x-plan.config.example.json.`);
  }
  return parseConfig(JSON.parse(readFileSync(path, "utf8")), path);
}

export function parseConfig(raw: unknown, source = "config"): XPlanConfig {
  const withDefaults = Value.Default(ConfigSchema, structuredClone(raw));
  if (!Value.Check(ConfigSchema, withDefaults)) {
    const errors = [...Value.Errors(ConfigSchema, withDefaults)].map((e) => `${e.instancePath || "/"} ${e.message}`);
    throw new Error(`Invalid ${source}:\n  ${errors.join("\n  ")}`);
  }
  return withDefaults;
}

export function thinkingFor(config: XPlanConfig, stage: StageName): ThinkingLevel {
  return config.stages?.[stage]?.thinking ?? config.thinking ?? "medium";
}

export function readApiKey(config: XPlanConfig): string {
  const key = process.env[config.provider.apiKeyEnv];
  if (!key) throw new Error(`Environment variable ${config.provider.apiKeyEnv} is not set.`);
  return key;
}
