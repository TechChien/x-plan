import type { XPlanConfig } from "../config.ts";

export interface LangfuseCredentials {
  baseUrl: string;
  /** `Basic base64(publicKey:secretKey)`, for both OTLP export and the public API. */
  authorization: string;
}

/**
 * The configured Langfuse instance with its keys, read from the environment like every other secret. Undefined
 * when there is no `langfuse` block; a block whose keys are missing is a mistake worth explaining.
 */
export function langfuseCredentials(config: XPlanConfig, env: NodeJS.ProcessEnv = process.env): LangfuseCredentials | undefined {
  const lf = config.langfuse;
  if (!lf) return undefined;
  const publicKey = env[lf.publicKeyEnv];
  const secretKey = env[lf.secretKeyEnv];
  if (!publicKey || !secretKey) {
    throw new Error(`config langfuse is set but ${[!publicKey && lf.publicKeyEnv, !secretKey && lf.secretKeyEnv].filter(Boolean).join(" and ")} is not set`);
  }
  return {
    baseUrl: lf.baseUrl.replace(/\/+$/, ""),
    authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
  };
}
