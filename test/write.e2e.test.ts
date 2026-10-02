import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, test } from "vitest";
import type { SessionOptions } from "../src/agent/types.ts";
import type { AlignedBrief } from "../src/clarify/aligned.ts";
import { parseConfig } from "../src/config.ts";
import { gherkinErrors } from "../src/write/render.ts";
import type { ReviewSubmission } from "../src/write/review.ts";
import type { FeatureSubmission, WriteOutline } from "../src/write/schema.ts";
import { runWrite, type WriteOptions } from "../src/write/stage.ts";
import { ScriptedBackend, type ScriptedTurn } from "./helpers/scripted-backend.ts";
import { alignedFixture, step, validFeature, validOutline } from "./helpers/write.ts";

/** Writers run one at a time so sessions come in outline order: FEAT-1's writer and reviews, then FEAT-2's. */
const config = parseConfig({ provider: { baseUrl: "http://unused" }, concurrency: 1 });

interface Dirs {
  clarify: string;
  write: string;
}

function dirs(meta: Record<string, unknown> = {}, aligned: AlignedBrief = alignedFixture()): Dirs {
  const root = mkdtempSync(join(tmpdir(), "x-plan-write-"));
  const clarify = join(root, "clarify-20261001-1000-aaaaaa");
  mkdirSync(clarify);
  writeFileSync(join(clarify, "02-aligned.json"), `${JSON.stringify(aligned, null, 2)}\n`);
  writeFileSync(join(clarify, "run.json"), JSON.stringify({ stage: "clarify", status: "succeeded", outputLanguage: "zh", ...meta }));
  return { clarify, write: join(root, "write-20261001-1100-bbbbbb") };
}

/** FEAT-2: SCN-5 specified (AC-1, DEC-6, BR-3), SCN-6 open (OQ-4), SCN-7 specified (NFR-1). "使用者" is for the vocabulary. */
function feature2(): FeatureSubmission {
  return {
    description: "會員可以申請退貨",
    background: [],
    scenarios: [
      { id: "SCN-5", steps: [step("Given", "使用者的商品到貨第 2 天", ["AC-1"]), step("When", "會員申請退貨", ["FEAT-2"]), step("Then", "系統接受退貨", ["AC-1"])], examples: [] },
      { id: "SCN-6", steps: [step("Given", "會員有一筆退貨", ["FEAT-2"])], examples: [] },
      { id: "SCN-7", steps: [step("When", "會員送出退貨申請", ["FEAT-2"]), step("Then", "系統在 2 秒內回應", ["NFR-1"])], examples: [] },
    ],
  };
}

/** A Scenario Review that finds every line stated by what it cites, built from the units in its prompt. */
function reviewFrom(prompt: string, flag?: { unit: string; ref: string }): ReviewSubmission {
  const view = parseYaml(prompt.slice(prompt.indexOf("<review>") + "<review>".length, prompt.indexOf("</review>"))) as {
    scenarios: { unit: string; lines: { ref: string }[] }[];
  };
  return {
    reviews: view.scenarios.map((u) => ({
      unit: u.unit,
      lines: u.lines.map((l) => ({ ref: l.ref, grounding: "stated" as const, contradicts: flag?.unit === u.unit && flag.ref === l.ref, values: [], actualSourceIds: [] })),
    })),
  };
}
const approving: ScriptedTurn = { respond: (p) => reviewFrom(p) };
const flagging = (unit: string, ref: string): ScriptedTurn => ({ respond: (p) => reviewFrom(p, { unit, ref }) });
const vocabularyCall: ScriptedTurn = {
  call: { entries: [{ canonical: "會員", definition: "在平台註冊的購買者", avoid: ["使用者"], sourceIds: ["ACT-1"] }], replacements: [{ loc: "SCN-5/step/0", from: "使用者", to: "會員" }] },
};

interface Scripts {
  outline?: ScriptedTurn[];
  /** Writer sessions in the order they start. */
  writers?: ScriptedTurn[][];
  /** Review sessions in the order they start. */
  reviews?: ScriptedTurn[][];
  vocabulary?: ScriptedTurn[];
}

function backend(s: Scripts = {}): ScriptedBackend & { tools: string[] } {
  const tools: string[] = [];
  const queue = { writers: [...(s.writers ?? [[{ call: validFeature() }], [{ call: feature2() }]])], reviews: [...(s.reviews ?? [])] };
  const b = new ScriptedBackend((options: SessionOptions) => {
    tools.push(options.tool.name);
    switch (options.tool.name) {
      case "submit_outline":
        return s.outline ?? [{ call: validOutline() }];
      case "submit_feature":
        return queue.writers.shift() ?? [];
      case "submit_review":
        return queue.reviews.shift() ?? [approving];
      case "submit_vocabulary":
        return s.vocabulary ?? [vocabularyCall];
      default:
        return [];
    }
  }) as ScriptedBackend & { tools: string[] };
  b.tools = tools;
  return b;
}

function options(d: Dirs, b: ScriptedBackend, extra: Partial<WriteOptions> = {}): WriteOptions {
  return { runDir: d.write, sourceRunDir: d.clarify, config, backend: async () => b, log: () => {}, now: () => new Date("2026-10-01T11:00:00Z"), ...extra };
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const read = (path: string) => readFileSync(path, "utf8");

describe("runWrite", () => {
  test("plans, writes, reviews and normalizes, then renders every file", async () => {
    const d = dirs({ termination: "converged" });
    const b = backend();
    const report = await runWrite(options(d, b));

    expect(report).toMatchObject({ status: "succeeded", failures: [], unwritten: [] });
    expect(b.tools).toEqual(["submit_outline", "submit_feature", "submit_review", "submit_feature", "submit_review", "submit_vocabulary"]);

    for (const id of ["FEAT-1", "FEAT-2"]) expect(gherkinErrors(read(join(d.write, "features", `${id}.feature`)))).toEqual([]);
    const feat2 = read(join(d.write, "features", "FEAT-2.feature"));
    expect(feat2).toContain("Given 會員的商品到貨第 2 天");
    expect(feat2).toContain("Then <待決 OQ-4：退貨頁面要顯示什麼？>");
    expect(read(join(d.write, "features", "FEAT-1.feature"))).toContain("Then <延後 OQ-1：已出貨的訂單如何處理？>");

    // The writers' own wording is kept for a rewrite; the replacement is recorded with both texts.
    expect(readJson<{ features: Record<string, FeatureSubmission> }>(join(d.write, "03-written.json")).features["FEAT-2"]!.scenarios[0]!.steps[0]!.text).toBe("使用者的商品到貨第 2 天");
    expect(readJson<{ applied: unknown[] }>(join(d.write, "03-vocabulary.json")).applied).toEqual([expect.objectContaining({ loc: "SCN-5/step/0", before: "使用者的商品到貨第 2 天", after: "會員的商品到貨第 2 天" })]);
    expect(read(join(d.write, "03-vocabulary.md"))).toContain("**會員**:");

    expect(readJson<WriteOutline>(join(d.write, "03-outline.json")).scenarios).toHaveLength(7);
    expect(read(join(d.write, "03-spec.md"))).toContain("| [FEAT-2.feature](features/FEAT-2.feature) | 申請退貨 | 3 | 1 | 0 | 0 | 0 | 0 |");
    const trace = readJson<{ scenarios: { id: string; status: string }[]; reviews: Record<string, unknown[]> }>(join(d.write, "03-trace.json"));
    expect(trace.scenarios.every((s) => s.status === "written")).toBe(true);
    expect(Object.keys(trace.reviews)).toEqual(["FEAT-1", "FEAT-2"]);

    const run = readJson<Record<string, any>>(join(d.write, "run.json"));
    expect(run).toMatchObject({
      status: "succeeded",
      stage: "write",
      outputLanguage: "zh",
      source: { kind: "run", stage: "clarify", runId: "clarify-20261001-1000-aaaaaa", file: "02-aligned.json" },
      features: { "FEAT-1": { status: "written", batch: "initial", unwritten: [] }, "FEAT-2": { status: "written", batch: "initial", unwritten: [] } },
      thinking: { outline: "medium", writer: "medium", review: "low", vocabulary: "low" },
    });
    expect(run.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(run.agents.map((a: { label: string }) => a.label)).toEqual(["write-outline", "write-FEAT-1-review1", "write-FEAT-1", "write-FEAT-2-review1", "write-FEAT-2", "write-vocabulary"]);
    for (const label of ["write-outline", "write-FEAT-1", "write-FEAT-1-review1", "write-vocabulary"]) {
      expect(existsSync(join(d.write, "prompts", `${label}.user.md`))).toBe(true);
      expect(existsSync(join(d.write, "traces", `${label}.md`))).toBe(true);
    }
  });

  test("a writer the review stops rewrites, and the second submission is accepted", async () => {
    const d = dirs();
    const b = backend({ writers: [[{ call: validFeature() }, { call: validFeature() }], [{ call: feature2() }]], reviews: [[flagging("SCN-3", "steps[0]")], [approving]] });
    const report = await runWrite(options(d, b));
    expect(report.status).toBe("succeeded");
    expect(b.sessions.find((s) => s.systemPrompt.includes("You write the steps"))!.prompts).toHaveLength(1);
    const reviews = readJson<{ reviews: Record<string, { attempt: number; unit: string; verdicts: string[] }[]> }>(join(d.write, "03-trace.json")).reviews["FEAT-1"]!;
    expect(reviews.filter((r) => r.verdicts.length)).toEqual([expect.objectContaining({ attempt: 1, unit: "SCN-3", verdicts: ["contradicts"] })]);
    expect(read(join(d.write, "features", "FEAT-1.feature"))).not.toContain("@unverified");
  });

  test("a scenario the review still stops after the last attempt is kept as @unverified", async () => {
    const d = dirs();
    const flag = [flagging("SCN-3", "steps[0]")];
    const b = backend({ writers: [[{ call: validFeature() }, { call: validFeature() }, { call: validFeature() }], [{ call: feature2() }]], reviews: [flag, flag, flag] });
    const report = await runWrite(options(d, b));
    expect(report.status).toBe("succeeded");
    expect(read(join(d.write, "features", "FEAT-1.feature"))).toContain("@SCN-3 @unverified @DEC-5");
    expect(read(join(d.write, "03-spec.md"))).toMatch(/## Unverified\n\n- SCN-3 VIP 第 10 天取消: review: steps\[0\] contradicts DEC-5/);
    expect(report.warnings).toContain("write-FEAT-1: SCN-3 kept as @unverified; see 03-spec.md");
  });

  test("a Feature whose writer fails is rendered @unwritten and can be rewritten with --only", async () => {
    const d = dirs();
    const silent: ScriptedTurn[] = [{ text: "…" }, { text: "…" }, { text: "…" }];
    const first = await runWrite(options(d, backend({ writers: [[{ call: validFeature() }], silent] })));
    expect(first).toMatchObject({ status: "failed", unwritten: ["FEAT-2"] });
    expect(first.failures).toEqual([expect.stringMatching(/^FEAT-2: write-FEAT-2 failed \(no-submit\).*rewrite it with --only FEAT-2$/)]);
    const unwritten = read(join(d.write, "features", "FEAT-2.feature"));
    expect(unwritten).toContain("@SCN-5 @unwritten");
    expect(gherkinErrors(unwritten)).toEqual([]);
    expect(readJson<Record<string, any>>(join(d.write, "run.json")).features["FEAT-2"]).toMatchObject({ status: "failed", unwritten: ["SCN-5", "SCN-6", "SCN-7"] });
    const feat1 = read(join(d.write, "features", "FEAT-1.feature"));

    const b = backend({ writers: [[{ call: feature2() }]] });
    const second = await runWrite(options(d, b, { sourceRunDir: undefined, only: ["FEAT-2"], now: () => new Date(2026, 9, 1, 12, 0, 0) }));
    expect(second).toMatchObject({ status: "succeeded", failures: [], unwritten: [] });
    expect(b.tools).toEqual(["submit_feature", "submit_review", "submit_vocabulary"]);
    expect(read(join(d.write, "features", "FEAT-2.feature"))).toContain("Given 會員的商品到貨第 2 天");
    expect(read(join(d.write, "features", "FEAT-1.feature"))).toBe(feat1);

    // The rewrite's vocabulary pass sees only FEAT-2's text and the entries chosen before, if any.
    const vocabularyPrompt = b.sessions.find((s) => s.systemPrompt.includes("consistent"))!.prompts[0]!;
    expect(vocabularyPrompt).toContain("SCN-5/step/0");
    expect(vocabularyPrompt).not.toContain("SCN-1/");
    const run = readJson<Record<string, any>>(join(d.write, "run.json"));
    expect(run.features).toMatchObject({ "FEAT-1": { batch: "initial" }, "FEAT-2": { status: "written", batch: "only-20261001-120000" } });
    // Its prompts and traces sit beside the first batch's instead of replacing them.
    expect(existsSync(join(d.write, "traces", "write-FEAT-2.md"))).toBe(true);
    expect(existsSync(join(d.write, "traces", "write-FEAT-2-only-20261001-120000.md"))).toBe(true);
  });

  test("a rewrite gets the Vocabulary chosen before, and a failed rewrite keeps the earlier version", async () => {
    const d = dirs();
    await runWrite(options(d, backend()));
    const before = read(join(d.write, "features", "FEAT-1.feature"));

    const b = backend({ writers: [[{ text: "…" }, { text: "…" }, { text: "…" }]] });
    const report = await runWrite(options(d, b, { sourceRunDir: undefined, only: ["FEAT-1"] }));
    expect(b.sessions[0]!.prompts[0]).toContain("<vocabulary>\n- canonical: 會員");
    expect(report.status).toBe("succeeded");
    expect(report.warnings.at(-1)).toMatch(/write-FEAT-1-only-\d{8}-\d{6} failed .*FEAT-1 keeps what batch initial wrote/);
    expect(read(join(d.write, "features", "FEAT-1.feature"))).toBe(before);
    expect(b.tools).toEqual(["submit_feature"]);
  });

  test("on the outline's last attempt the rest is accepted and what is uncovered is listed", async () => {
    const d = dirs();
    const short = validOutline();
    short.features[0]!.rules.splice(1, 1);
    // Without DEC-5's Rule, SCN-3 is gone and every later scenario moves up one.
    const renumber = (f: FeatureSubmission, from: string[], to: string[]) => ({ ...f, scenarios: f.scenarios.filter((s) => from.includes(s.id)).map((s) => ({ ...s, id: to[from.indexOf(s.id)]! })) });
    const writers = [[{ call: renumber(validFeature(), ["SCN-1", "SCN-2", "SCN-4"], ["SCN-1", "SCN-2", "SCN-3"]) }], [{ call: renumber(feature2(), ["SCN-5", "SCN-6", "SCN-7"], ["SCN-4", "SCN-5", "SCN-6"]) }]];
    const b = backend({ outline: [{ call: short }, { call: short }, { call: short }], writers });
    const report = await runWrite(options(d, b));
    expect(report.status).toBe("succeeded");
    expect(report.warnings).toContain("write-outline: DEC-5 still uncovered after the last attempt; listed in 03-spec.md");
    expect(read(join(d.write, "03-spec.md"))).toMatch(/## Uncovered\n\n- \*\*DEC-5\*\* VIP 10 天內可取消/);
  });

  test("Vocabulary Normalization failing keeps the writers' wording; disabled, it does not run", async () => {
    const d = dirs();
    const report = await runWrite(options(d, backend({ vocabulary: [{ text: "…" }, { text: "…" }, { text: "…" }] })));
    expect(report.status).toBe("succeeded");
    expect(report.warnings).toContainEqual(expect.stringMatching(/^write-vocabulary failed .*the writers' wording is kept$/));
    expect(read(join(d.write, "features", "FEAT-2.feature"))).toContain("Given 使用者的商品到貨第 2 天");

    const off = dirs();
    const b = backend();
    await runWrite(options(off, b, { config: parseConfig({ provider: { baseUrl: "http://unused" }, concurrency: 1, stages: { write: { vocabulary: { enabled: false } } } }) }));
    expect(b.tools).not.toContain("submit_vocabulary");
    expect(read(join(off.write, "03-spec.md"))).toContain("_Not normalized._");
    expect(existsSync(join(off.write, "03-vocabulary.json"))).toBe(false);
  });

  describe("the upstream Clarify Run", () => {
    test("a failed one is refused unless allowed", async () => {
      const d = dirs({ status: "failed" });
      await expect(runWrite(options(d, backend()))).rejects.toThrow(/--allow-failed-clarify/);
      const report = await runWrite(options(d, backend(), { allowFailedClarify: true }));
      expect(report.warnings).toContain("Started from Clarify Run clarify-20261001-1000-aaaaaa, whose status is failed");
    });

    test("one that ended before converging is written with a warning", async () => {
      const report = await runWrite(options(dirs(), backend()));
      expect(report.warnings).toContain("Clarify Run clarify-20261001-1000-aaaaaa ended with done: 2 item(s) still open are written as @open or @deferred");
    });

    test("a rewrite refuses an Aligned Brief that changed since", async () => {
      const d = dirs();
      await runWrite(options(d, backend()));
      const changed = alignedFixture();
      changed.decisions[0]!.conclusion = "一般會員 5 天內可取消";
      writeFileSync(join(d.clarify, "02-aligned.json"), JSON.stringify(changed));
      await expect(runWrite(options(d, backend(), { sourceRunDir: undefined, only: ["FEAT-1"] }))).rejects.toThrow(/changed since Write Run/);
    });

    test("a Write Run is not written twice, and --only needs one", async () => {
      const d = dirs();
      await runWrite(options(d, backend()));
      await expect(runWrite(options(d, backend()))).rejects.toThrow(/already a Write Run.*--only/);
      await expect(runWrite(options(dirs(), backend(), { only: ["FEAT-1"] }))).rejects.toThrow(/not a Write Run/);
      await expect(runWrite(options(d, backend(), { sourceRunDir: undefined, only: ["FEAT-9"] }))).rejects.toThrow(/FEAT-9 not in the outline/);
    });
  });
});
