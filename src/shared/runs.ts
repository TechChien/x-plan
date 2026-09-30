import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { StageName } from "../config.ts";
import type { OutputLanguage } from "./language.ts";

/** Where Runs live unless `--out` says otherwise. */
export function runsDir(cwd: string): string {
  return join(cwd, ".x-plan", "runs");
}

/** e.g. `clarify-20260930-1530-a1b2c3`: the Stage first, so a listing shows what each Run is. */
export function newRunId(stage: StageName, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${stage}-${stamp}-${randomBytes(3).toString("hex")}`;
}

/** What a Run read (ADR 0010): Source Documents for Extract, one upstream Run's output for later Stages. */
export type RunSource =
  | { kind: "documents"; dir: string }
  | {
      kind: "run";
      stage: StageName;
      runId: string;
      runDir: string;
      /** The upstream output this Run read, e.g. `01-brief.json`. */
      file: string;
      sha256: string;
    };

/** The fields every Stage writes to its `run.json` and other Stages rely on. */
export interface RunMeta {
  stage: StageName;
  status: string;
  createdAt?: string;
  outputLanguage?: OutputLanguage;
  source?: RunSource;
}

export function readRunMeta(dir: string): RunMeta | undefined {
  const path = join(dir, "run.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as RunMeta;
}

/** A Run given as a directory path, or as an id under `.x-plan/runs/`. */
export function resolveRunDir(cwd: string, arg: string): string {
  const asPath = resolve(cwd, arg);
  if (existsSync(asPath) && statSync(asPath).isDirectory()) return asPath;
  const asId = join(runsDir(cwd), arg);
  if (existsSync(asId) && statSync(asId).isDirectory()) return asId;
  throw new Error(`No Run ${arg}: neither a directory nor an id under ${runsDir(cwd)}`);
}
