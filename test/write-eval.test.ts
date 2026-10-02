import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AlignedBrief } from "../src/clarify/aligned.ts";
import { parseConfig } from "../src/config.ts";
import { loadWriteCase } from "../src/eval/write/cases.ts";
import { readArtifacts, renderWriteReport, runWriteEval, type WriteRunResult } from "../src/eval/write/run.ts";
import { scoreWrite } from "../src/eval/write/score.ts";
import { coverageSets } from "../src/write/coverage.ts";
import { alignedFixture, writeBackend } from "./helpers/write.ts";

const RETURNS = join(import.meta.dirname, "..", "eval", "cases", "returns", "write");

describe("the returns Write case", () => {
  const labels = loadWriteCase(join(RETURNS, "expected.yaml"));
  const aligned = JSON.parse(readFileSync(join(RETURNS, "aligned.json"), "utf8")) as AlignedBrief;
  const sets = coverageSets(aligned);

  test("the fixture is an Aligned Brief with something replaced, revised, confirmed and still open", () => {
    expect(sets.features).toEqual(["FEAT-1", "FEAT-2"]);
    expect([...sets.forbidden.keys()]).toEqual(["BR-1", "ASM-2", "DEC-9"]);
    expect(aligned.confirmedBy).toEqual({ "ASM-1": ["DEC-6"] });
  });

  test("labels name only ids the writers may cite and items that are still open", () => {
    for (const label of labels.mustHaveScenarios) for (const id of label.sourceIds ?? []) expect(sets.citable.has(id), `${label.id}: ${id}`).toBe(true);
    for (const id of labels.expectedOpen ?? []) expect(["unresolved", "deferred"]).toContain(sets.agenda.get(id));
  });
});

const EXPECTED = `
mustHaveScenarios:
  - { id: same-day, all: ["下單當天"], sourceIds: [AC-2] }
  - { id: vip-10, all: ["VIP", "10"], sourceIds: [DEC-5] }
  - { id: day-8, all: ["8"], derived: true }
  - { id: response-time, all: ["2 秒"], sourceIds: [NFR-1] }
  - { id: never-written, all: ["退款"] }
shouldNotAppear:
  - { id: old-window, any: ["3 天"] }
expectedOpen: [OQ-1, OQ-4]
vocabulary:
  - { canonical: 會員, variants: [使用者] }
distinct:
  - [會員, 系統]
`;

/** A case over the test fixture, run once with the scripted model the Write e2e tests use. */
async function evaluated(): Promise<WriteRunResult> {
  const root = mkdtempSync(join(tmpdir(), "x-plan-write-eval-"));
  const caseDir = join(root, "fixture");
  mkdirSync(join(caseDir, "write"), { recursive: true });
  writeFileSync(join(caseDir, "write", "aligned.json"), JSON.stringify(alignedFixture()));
  writeFileSync(join(caseDir, "write", "expected.yaml"), EXPECTED);
  const [result] = await runWriteEval({
    cases: [{ name: "fixture", dir: caseDir }],
    outDir: join(root, "results"),
    repeat: 1,
    config: parseConfig({ provider: { baseUrl: "http://unused" }, concurrency: 1 }),
    backend: async () => writeBackend(),
    log: () => {},
  });
  return result!;
}

describe("runWriteEval", () => {
  test("scores a run against the labels", async () => {
    const result = await evaluated();
    expect(result.status).toBe("succeeded");
    expect(result.score).toMatchObject({
      mustHave: { hit: ["same-day", "vip-10", "day-8", "response-time"], missed: ["never-written"] },
      mustHaveBefore: { hit: ["same-day", "vip-10", "day-8", "response-time"], missed: ["never-written"] },
      stale: [],
      staleBefore: 0,
      open: { shown: ["OQ-1", "OQ-4"], missed: [] },
      outlineRejections: 0,
      review: { unsupported: 0, contradicts: 0, "invented-value": 0, underived: 0, misattributed: 0 },
      scenarios: 7,
      unverified: 0,
      unwritten: 0,
      uncovered: 0,
      derived: 1,
      notBehavioral: 1,
      newFeatures: 0,
      featureOnly: 0,
      downgraded: 0,
      vocabulary: { variantsBefore: 1, variantsAfter: 0, wrongMerges: [], replacements: 1, skipped: 0, entries: 1 },
      invalidFiles: [],
    });
    expect(result.metrics.submitAttempts).toBeGreaterThan(0);
  });

  test("finds stale wording, wrong merges, what is missing from derived content, and what normalization lost", async () => {
    const result = await evaluated();
    const labels = loadWriteCase(join(result.runDir, "..", "..", "..", "fixture", "write", "expected.yaml"));
    const artifacts = readArtifacts(result.runDir, [])!;
    artifacts.after.scenarios[0]!.steps[0]!.text += "，下單 3 天內";
    artifacts.vocabulary!.applied.push({ loc: "SCN-1/step/2", from: "系統", to: "會員", count: 1, before: "", after: "" });
    const score = scoreWrite(
      { ...labels, mustHaveScenarios: [{ id: "same-day-derived", all: ["下單當天"], derived: true }, { id: "user-wording", all: ["使用者"] }] },
      artifacts,
    );
    expect(score.stale).toEqual([{ id: "old-window", scenario: "SCN-1" }]);
    expect(score.staleBefore).toBe(0);
    expect(score.vocabulary.wrongMerges).toEqual([{ loc: "SCN-1/step/2", from: "系統", to: "會員" }]);
    expect(score.mustHave.missed).toEqual(["same-day-derived", "user-wording"]);
    expect(score.mustHaveBefore.hit).toEqual(["user-wording"]);
  });

  test("the report sums each case and lists what each run missed", async () => {
    const report = renderWriteReport([await evaluated()]);
    expect(report).toMatch(/^\| fixture \| 1\/1 \| 80% \(80%\) \| 0 \(0\) \| 100% \| 0 \| 0\/0\/0\/0\/0 \|/m);
    expect(report).toContain("- 缺少的必要情境：never-written");
    expect(report).toContain("## Prompt 版本");
  });
});
