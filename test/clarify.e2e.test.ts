import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentBackend, SessionOptions } from "../src/agent/types.ts";
import { item } from "../src/clarify/agenda.ts";
import type { AlignedBrief } from "../src/clarify/aligned.ts";
import { ScriptAnswerer, type AskedQuestion } from "../src/clarify/answerer.ts";
import { replay } from "../src/clarify/apply.ts";
import type { ClarifyState, DecisionOp, Prepared, RoundSubmission } from "../src/clarify/schema.ts";
import { runClarify, type ClarifyOptions } from "../src/clarify/stage.ts";
import { parseConfig } from "../src/config.ts";
import { returnsBrief } from "./helpers/brief.ts";
import { ScriptedBackend, type ScriptedTurn } from "./helpers/scripted-backend.ts";

const config = parseConfig({ provider: { baseUrl: "http://unused" } });

function runDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "x-plan-clarify-"));
  writeFileSync(join(dir, "01-brief.json"), `${JSON.stringify(returnsBrief(), null, 2)}\n`);
  writeFileSync(join(dir, "run.json"), JSON.stringify({ stage: "extract", outputLanguage: "zh" }));
  return dir;
}

const op = (answerRef: string, resolves: string[], conclusion: string, extra: Partial<DecisionOp> = {}): DecisionOp => ({
  answerRef,
  resolves,
  conclusion,
  supersedes: [],
  confirms: [],
  revises: [],
  relatedIds: [],
  ...extra,
});
const prep = (id: string): Prepared => ({ id, question: `請確認 ${id}`, recommendation: `建議 ${id}`, basis: "convention", options: ["是", "否"] });
const round = (decisions: DecisionOp[], prepared: string[], extra: Partial<RoundSubmission> = {}): ScriptedTurn => ({ call: { decisions, followUps: [], prepared: prepared.map(prep), ...extra } });

/** Plays one script per session, in order, and remembers which tool each session had. */
function backend(scripts: ScriptedTurn[][]): ScriptedBackend & { tools: string[] } {
  const tools: string[] = [];
  let next = 0;
  const b = new ScriptedBackend((options: SessionOptions) => {
    tools.push(options.tool.name);
    return scripts[next++] ?? [];
  }) as ScriptedBackend & { tools: string[] };
  b.tools = tools;
  return b;
}

function options(dir: string, b: AgentBackend, answer: (q: AskedQuestion, round: number) => string | string[], extra: Partial<ClarifyOptions> = {}): ClarifyOptions {
  return { runDir: dir, config, answerer: new ScriptAnswerer(answer), backend: async () => b, log: () => {}, now: () => new Date("2026-09-30T00:00:00Z"), ...extra };
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/** Round 1 prepares the five highest-ranked items; round 2 the two assumptions; round 3 closes everything. */
const happyScripts = (): ScriptedTurn[][] => [
  [round([], ["CTR-1", "OQ-1", "OQ-2", "OQ-3", "OQ-4"])],
  [
    round(
      [
        op("R1/CTR-1", ["CTR-1"], "一般會員取消期限為 7 天", { supersedes: ["BR-1"] }),
        op("R1/CTR-1", ["CTR-1"], "VIP 會員取消期限為 14 天", { relatedIds: ["FEAT-1"] }),
        op("R1/OQ-2", ["OQ-2"], "退貨運費由賣家負擔"),
        op("R1/OQ-3", ["OQ-3"], "鑑賞期即取消期限的 7 天"),
      ],
      ["ASM-2", "ASM-1"],
    ),
  ],
  [round([op("R2/ASM-2", ["ASM-2"], "退款一律原路退回", { confirms: ["ASM-2"] }), op("R2/ASM-1", ["ASM-1"], "取消與退貨都需要登入", { confirms: ["ASM-1"] })], [])],
];

const happyAnswers = (q: AskedQuestion): string =>
  ({ "CTR-1": "以 7 天為準，3 天是舊版；VIP 是 14 天", "OQ-1": "/na", "OQ-2": "/ok", "OQ-3": "鑑賞期就是 7 天那個", "OQ-4": "/defer 下一版再說" })[q.id] ?? "/ok";

describe("runClarify", () => {
  test("runs rounds until nothing is open and writes the Aligned Brief, transcript, traces and prompts", async () => {
    const dir = runDir();
    const b = backend(happyScripts());
    const report = await runClarify(options(dir, b, happyAnswers));

    expect(report).toMatchObject({ status: "succeeded", termination: "converged", failures: [] });
    expect(b.tools).toEqual(["submit_round", "submit_round", "submit_round"]);

    const aligned = readJson<AlignedBrief>(join(dir, "02-aligned.json"));
    expect(aligned.brief).toEqual(returnsBrief());
    expect(aligned.supersededBy).toEqual({ "BR-1": ["DEC-1"] });
    expect(aligned.confirmedBy).toEqual({ "ASM-2": ["DEC-5"], "ASM-1": ["DEC-6"] });
    expect(Object.fromEntries(aligned.agenda.map((a) => [a.id, a.status]))).toEqual({
      "OQ-1": "dismissed",
      "OQ-2": "decided",
      "OQ-3": "decided",
      "OQ-4": "deferred",
      "CTR-1": "decided",
      "ASM-1": "decided",
      "ASM-2": "decided",
    });
    expect(aligned.decisions.find((d) => d.id === "DEC-3")).toMatchObject({ answerText: "建議 OQ-2", effect: "new" });

    for (const f of ["02-state.json", "02-transcript.md", "02-aligned.md", "02-rejected.json", "02-run.json"]) expect(existsSync(join(dir, f))).toBe(true);
    for (const n of [1, 2, 3]) {
      expect(existsSync(join(dir, "traces", `clarify-r${n}.md`))).toBe(true);
      expect(existsSync(join(dir, "prompts", `clarify-r${n}.user.md`))).toBe(true);
    }
    const run = readJson<{ termination: string; agents: { label: string; cacheReadRatio: number }[] }>(join(dir, "02-run.json"));
    expect(run.termination).toBe("converged");
    expect(run.agents.map((a) => a.label)).toEqual(["clarify-r1", "clarify-r2", "clarify-r3"]);

    const state = readJson<ClarifyState>(join(dir, "02-state.json"));
    expect(replay(returnsBrief(), state)).toEqual(state);
  });

  test("an interrupted session resumes where it stopped, keeping Answers already given", async () => {
    const dir = runDir();
    const scripts = happyScripts();
    let answered = 0;
    const flaky = (q: AskedQuestion) => {
      if (++answered === 3) throw new Error("terminal closed");
      return happyAnswers(q);
    };
    const first = await runClarify(options(dir, backend(scripts), flaky));
    expect(first).toMatchObject({ status: "failed", failures: ["terminal closed"] });
    const saved = readJson<ClarifyState>(join(dir, "02-state.json"));
    expect(saved.answers.map((a) => a.ref)).toEqual(["R1/CTR-1", "R1/OQ-1"]);

    const shown: string[] = [];
    const b = backend(scripts.slice(1));
    const second = await runClarify(options(dir, b, (q) => (shown.push(q.id), happyAnswers(q))));
    expect(second).toMatchObject({ status: "succeeded", termination: "converged" });
    expect(shown.slice(0, 3)).toEqual(["OQ-2", "OQ-3", "OQ-4"]);
    expect(b.tools).toHaveLength(2); // round 1 was not run again
  });

  test("refuses to resume when the Brief changed", async () => {
    const dir = runDir();
    await runClarify(options(dir, backend([[round([], ["CTR-1"])]]), () => {
      throw new Error("stop");
    }));
    writeFileSync(join(dir, "01-brief.json"), JSON.stringify({ ...returnsBrief(), assumptions: [] }));
    await expect(runClarify(options(dir, backend([]), happyAnswers))).rejects.toThrow(/--restart/);
    const restarted = await runClarify(options(dir, backend([[round([], ["CTR-1", "OQ-1", "OQ-2", "OQ-3", "OQ-4"])]]), () => "/done", { restart: true }));
    expect(restarted.status).toBe("succeeded");
  });

  test("/done runs a closing round that only interprets, and leaves the rest unresolved", async () => {
    const dir = runDir();
    const b = backend([
      [round([], ["CTR-1", "OQ-1", "OQ-2", "OQ-3", "OQ-4"])],
      [{ call: { decisions: [op("R1/CTR-1", ["CTR-1"], "以 7 天為準", { supersedes: ["BR-1"] })] } }],
    ]);
    const report = await runClarify(options(dir, b, (q) => (q.id === "CTR-1" ? "以 7 天為準" : "/done")));
    expect(report).toMatchObject({ status: "succeeded", termination: "done" });
    expect(b.tools).toEqual(["submit_round", "submit_final"]);
    const state = readJson<ClarifyState>(join(dir, "02-state.json"));
    expect(item(state, "CTR-1").status).toBe("decided");
    expect(["OQ-1", "OQ-2", "ASM-1"].map((id) => item(state, id).status)).toEqual(["unresolved", "unresolved", "unresolved"]);
    expect(existsSync(join(dir, "traces", "clarify-final.md"))).toBe(true);
  });

  test("stops at the round cap with a closing round and a warning", async () => {
    const dir = runDir();
    const b = backend([[round([], ["CTR-1", "OQ-1", "OQ-2", "OQ-3", "OQ-4"])], [{ call: { decisions: [op("R1/OQ-2", ["OQ-2"], "賣家負擔")] } }]]);
    const report = await runClarify(options(dir, b, (q) => (q.id === "OQ-2" ? "/ok" : "/later"), { maxRounds: 1 }));
    expect(report).toMatchObject({ status: "succeeded", termination: "cap" });
    expect(report.warnings).toContainEqual(expect.stringMatching(/Stopped after 1 rounds/));
    expect(b.tools).toEqual(["submit_round", "submit_final"]);
  });

  test("an Answer whose Decision is rejected on the last attempt is interpreted again next round", async () => {
    const dir = runDir();
    const bad = op("R1/OQ-2", ["OQ-2"], "賣家負擔", { relatedIds: ["FEAT-9"] });
    const b = backend([
      [round([], ["CTR-1", "OQ-1", "OQ-2", "OQ-3", "OQ-4"])],
      [round([bad], ["ASM-2", "ASM-1"]), round([bad], ["ASM-2", "ASM-1"]), round([bad], ["ASM-2", "ASM-1"])],
      [round([op("R1/OQ-2", ["OQ-2"], "賣家負擔")], [])],
    ]);
    const answers = (q: AskedQuestion) => (q.id === "OQ-2" ? "賣家" : q.id.startsWith("ASM") ? "/na" : "/defer");
    const report = await runClarify(options(dir, b, answers));
    expect(report).toMatchObject({ status: "succeeded", termination: "converged" });
    expect(report.warnings).toContainEqual(expect.stringMatching(/clarify-r2: 1 item\(s\) rejected/));
    expect(readJson<unknown[]>(join(dir, "02-rejected.json"))).toHaveLength(1);
    expect(readFileSync(join(dir, "prompts", "clarify-r3.user.md"), "utf8")).toContain("ref: R1/OQ-2");
    expect(item(readJson<ClarifyState>(join(dir, "02-state.json")), "OQ-2")).toMatchObject({ status: "decided", resolvedBy: ["DEC-2"] });
  });

  test("a round whose agent fails leaves the state as it was, so the round can be retried", async () => {
    const dir = runDir();
    const report = await runClarify(options(dir, backend([[{ text: "I will not call the tool" }]]), happyAnswers));
    expect(report.status).toBe("failed");
    expect(report.failures[0]).toMatch(/clarify-r1 failed \(no-submit\)/);
    const retried = await runClarify(options(dir, backend(happyScripts()), happyAnswers));
    expect(retried).toMatchObject({ status: "succeeded", termination: "converged" });
  });
});
