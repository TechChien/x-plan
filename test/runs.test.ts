import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { newRunId, readRunMeta, resolveRunDir, runsDir } from "../src/shared/runs.ts";

describe("Runs (ADR 0010)", () => {
  test("ids start with the Stage", () => {
    expect(newRunId("clarify", new Date(2026, 8, 30, 15, 4))).toMatch(/^clarify-20260930-1504-[0-9a-f]{6}$/);
  });

  test("a Run is found by directory path or by id under .x-plan/runs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "x-plan-runs-"));
    const dir = join(runsDir(cwd), "extract-20260930-1500-aaaaaa");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), JSON.stringify({ stage: "extract", status: "succeeded" }));
    expect(resolveRunDir(cwd, "extract-20260930-1500-aaaaaa")).toBe(dir);
    expect(resolveRunDir(cwd, dir)).toBe(dir);
    expect(readRunMeta(dir)).toMatchObject({ stage: "extract", status: "succeeded" });
    expect(() => resolveRunDir(cwd, "clarify-nope")).toThrow(/No Run clarify-nope/);
  });
});
