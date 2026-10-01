import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
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
import { approvingReview, noConflicts, ScriptedBackend, type ScriptedTurn } from "./helpers/scripted-backend.ts";

const config = parseConfig({ provider: { baseUrl: "http://unused" } });

interface Dirs {
  root: string;
  /** The Extract Run the Clarify Run starts from. */
  extract: string;
  clarify: string;
}

/** An Extract Run holding the returns Brief, and where a Clarify Run from it goes. */
function runDir(status = "succeeded"): Dirs {
  const root = mkdtempSync(join(tmpdir(), "x-plan-clarify-"));
  const extract = join(root, "extract-20260930-1500-aaaaaa");
  mkdirSync(extract);
  writeFileSync(join(extract, "01-brief.json"), `${JSON.stringify(returnsBrief(), null, 2)}\n`);
  writeFileSync(join(extract, "run.json"), JSON.stringify({ stage: "extract", status, createdAt: "2026-09-30T15:00:00Z", outputLanguage: "zh" }));
  return { root, extract, clarify: join(root, "clarify-20260930-1600-bbbbbb") };
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

/**
 * Plays one script per interpreter session, in order, and remembers which tool each had. Grounding Review sessions
 * play `review` (by default: everything is grounded) and Consistency Check sessions `consistency` (by default: no
 * conflict); neither is counted.
 */
function backend(
  scripts: ScriptedTurn[][],
  review: () => ScriptedTurn[] = () => [approvingReview],
  consistency: () => ScriptedTurn[] = () => [noConflicts],
): ScriptedBackend & { tools: string[] } {
  const tools: string[] = [];
  let next = 0;
  const b = new ScriptedBackend((options: SessionOptions) => {
    if (options.tool.name === "submit_review") return review();
    if (options.tool.name === "submit_conflicts") return consistency();
    tools.push(options.tool.name);
    return scripts[next++] ?? [];
  }) as ScriptedBackend & { tools: string[] };
  b.tools = tools;
  return b;
}

function options(dirs: Dirs, b: AgentBackend, answer: (q: AskedQuestion, round: number) => string | string[], extra: Partial<ClarifyOptions> = {}): ClarifyOptions {
  return {
    runDir: dirs.clarify,
    sourceRunDir: dirs.extract,
    config,
    answerer: new ScriptAnswerer(answer),
    backend: async () => b,
    log: () => {},
    now: () => new Date("2026-09-30T00:00:00Z"),
    ...extra,
  };
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
    const out = dir.clarify;
    const b = backend(happyScripts());
    const report = await runClarify(options(dir, b, happyAnswers));

    expect(report).toMatchObject({ status: "succeeded", termination: "converged", failures: [] });
    expect(b.tools).toEqual(["submit_round", "submit_round", "submit_round"]);

    const aligned = readJson<AlignedBrief>(join(out, "02-aligned.json"));
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

    for (const f of ["02-state.json", "02-transcript.md", "02-aligned.md", "02-rejected.json", "run.json"]) expect(existsSync(join(out, f))).toBe(true);
    for (const n of [1, 2, 3]) {
      expect(existsSync(join(out, "traces", `clarify-r${n}.md`))).toBe(true);
      expect(existsSync(join(out, "prompts", `clarify-r${n}.user.md`))).toBe(true);
    }
    const run = readJson<{ stage: string; source: unknown; termination: string; agents: { label: string; cacheReadRatio: number }[] }>(join(out, "run.json"));
    expect(run).toMatchObject({ stage: "clarify", termination: "converged" });
    const source = { stage: "extract", runId: "extract-20260930-1500-aaaaaa", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) };
    expect(run.source).toEqual({ kind: "run", runDir: dir.extract, file: "01-brief.json", ...source });
    expect(aligned.source).toEqual(source);
    expect(existsSync(join(dir.extract, "02-state.json"))).toBe(false); // the Extract Run is only read
    expect(run.agents.map((a) => a.label)).toEqual([
      "clarify-r1",
      "clarify-r2-review1",
      "clarify-r2",
      "clarify-r2-consistency",
      "clarify-r3-review1",
      "clarify-r3",
      "clarify-r3-consistency",
    ]);
    expect(existsSync(join(out, "prompts", "clarify-r2-review1.user.md"))).toBe(true);

    const state = readJson<ClarifyState>(join(out, "02-state.json"));
    expect(replay(returnsBrief(), state)).toEqual(state);
  });

  test("an interrupted session resumes where it stopped, keeping Answers already given", async () => {
    const dir = runDir();
    const out = dir.clarify;
    const scripts = happyScripts();
    let answered = 0;
    const flaky = (q: AskedQuestion) => {
      if (++answered === 3) throw new Error("terminal closed");
      return happyAnswers(q);
    };
    const first = await runClarify(options(dir, backend(scripts), flaky));
    expect(first).toMatchObject({ status: "failed", failures: ["terminal closed"] });
    const saved = readJson<ClarifyState>(join(out, "02-state.json"));
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
    const out = dir.clarify;
    await runClarify(options(dir, backend([[round([], ["CTR-1"])]]), () => {
      throw new Error("stop");
    }));
    writeFileSync(join(dir.extract, "01-brief.json"), JSON.stringify({ ...returnsBrief(), assumptions: [] }));
    await expect(runClarify(options(dir, backend([]), happyAnswers))).rejects.toThrow(/Brief of Extract Run extract-20260930-1500-aaaaaa changed.*--restart/);
    const restarted = await runClarify(options(dir, backend([[round([], ["CTR-1", "OQ-1", "OQ-2", "OQ-3", "OQ-4"])]]), () => "/done", { restart: true }));
    expect(restarted.status).toBe("succeeded");
  });

  test("/done runs a closing round that only interprets, and leaves the rest unresolved", async () => {
    const dir = runDir();
    const out = dir.clarify;
    const b = backend([
      [round([], ["CTR-1", "OQ-1", "OQ-2", "OQ-3", "OQ-4"])],
      [{ call: { decisions: [op("R1/CTR-1", ["CTR-1"], "以 7 天為準", { supersedes: ["BR-1"] })] } }],
    ]);
    const report = await runClarify(options(dir, b, (q) => (q.id === "CTR-1" ? "以 7 天為準" : "/done")));
    expect(report).toMatchObject({ status: "succeeded", termination: "done" });
    expect(b.tools).toEqual(["submit_round", "submit_final"]);
    const state = readJson<ClarifyState>(join(out, "02-state.json"));
    expect(item(state, "CTR-1").status).toBe("decided");
    expect(["OQ-1", "OQ-2", "ASM-1"].map((id) => item(state, id).status)).toEqual(["unresolved", "unresolved", "unresolved"]);
    expect(existsSync(join(out, "traces", "clarify-final.md"))).toBe(true);
  });

  test("stops at the round cap with a closing round and a warning", async () => {
    const dir = runDir();
    const out = dir.clarify;
    const b = backend([[round([], ["CTR-1", "OQ-1", "OQ-2", "OQ-3", "OQ-4"])], [{ call: { decisions: [op("R1/OQ-2", ["OQ-2"], "賣家負擔")] } }]]);
    const report = await runClarify(options(dir, b, (q) => (q.id === "OQ-2" ? "/ok" : "/later"), { maxRounds: 1 }));
    expect(report).toMatchObject({ status: "succeeded", termination: "cap" });
    expect(report.warnings).toContainEqual(expect.stringMatching(/Stopped after 1 rounds/));
    expect(b.tools).toEqual(["submit_round", "submit_final"]);
  });

  test("an Answer whose Decision is rejected on the last attempt is interpreted again next round", async () => {
    const dir = runDir();
    const out = dir.clarify;
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
    expect(readJson<unknown[]>(join(out, "02-rejected.json"))).toHaveLength(1);
    expect(readFileSync(join(out, "prompts", "clarify-r3.user.md"), "utf8")).toContain("ref: R1/OQ-2");
    expect(item(readJson<ClarifyState>(join(out, "02-state.json")), "OQ-2")).toMatchObject({ status: "decided", resolvedBy: ["DEC-2"] });
  });

  test("several Clarify Runs can start from the same Extract Run without touching each other", async () => {
    const dir = runDir();
    const a = await runClarify(options(dir, backend(happyScripts()), happyAnswers));
    const b = await runClarify(options({ ...dir, clarify: join(dir.root, "clarify-b") }, backend([[round([], ["CTR-1", "OQ-1", "OQ-2", "OQ-3", "OQ-4"])]]), () => "/done"));
    expect([a.termination, b.termination]).toEqual(["converged", "done"]);
    expect(readJson<AlignedBrief>(join(dir.clarify, "02-aligned.json")).decisions).toHaveLength(6);
    expect(readJson<AlignedBrief>(join(dir.root, "clarify-b", "02-aligned.json")).decisions).toHaveLength(0);
  });

  test("resumes by the Clarify Run alone, and refuses a different Extract Run for it", async () => {
    const dir = runDir();
    await runClarify(options(dir, backend(happyScripts().slice(0, 1)), () => {
      throw new Error("stop");
    }));
    const resumed = await runClarify(options(dir, backend(happyScripts().slice(1)), happyAnswers, { sourceRunDir: undefined }));
    expect(resumed.status).toBe("succeeded");
    await expect(runClarify(options(dir, backend([]), happyAnswers, { sourceRunDir: join(dir.root, "extract-other") }))).rejects.toThrow(
      /belongs to Extract Run extract-20260930-1500-aaaaaa/,
    );
  });

  test("a new Clarify Run needs a succeeded Extract Run unless told otherwise", async () => {
    const failed = runDir("failed");
    await expect(runClarify(options(failed, backend([]), happyAnswers))).rejects.toThrow(/status failed.*--allow-failed-extract/);
    const allowed = await runClarify(options(failed, backend([[round([], ["CTR-1", "OQ-1", "OQ-2", "OQ-3", "OQ-4"])]]), () => "/done", { allowFailedExtract: true }));
    expect(allowed.warnings).toContainEqual(expect.stringMatching(/whose status is failed/));

    const dir = runDir();
    await expect(runClarify(options(dir, backend([]), happyAnswers, { sourceRunDir: undefined }))).rejects.toThrow(/give the Extract Run to start from/);
    await expect(runClarify(options(dir, backend([]), happyAnswers, { runDir: dir.extract }))).rejects.toThrow(/is an extract Run, not a Clarify Run/);
  });

  test("a round whose agent fails leaves the state as it was, so the round can be retried", async () => {
    const dir = runDir();
    const out = dir.clarify;
    const report = await runClarify(options(dir, backend([[{ text: "I will not call the tool" }]]), happyAnswers));
    expect(report.status).toBe("failed");
    expect(report.failures[0]).toMatch(/clarify-r1 failed \(no-submit\)/);
    const retried = await runClarify(options(dir, backend(happyScripts()), happyAnswers));
    expect(retried).toMatchObject({ status: "succeeded", termination: "converged" });
  });
});

/** What a scripted Grounding Review finds in one conclusion; unset fields mean grounded. */
interface Finding {
  addressesQuestion?: boolean;
  unsupported?: string[];
  unanswered?: string[];
}

/** A Grounding Review that judges each Decision in its prompt by its conclusion. */
const reviewer = (judge: (conclusion: string) => Finding): ScriptedTurn => ({
  respond: (prompt) => {
    const body = /<review>\n([\s\S]*)\n<\/review>/.exec(prompt)?.[1] ?? "";
    const { decisions } = parseYaml(body) as { decisions: { id: string; conclusion: string }[] };
    return {
      reviews: decisions.map((d) => {
        const f = judge(d.conclusion);
        return {
          decision: d.id,
          claims: [{ text: d.conclusion, source: "answer" }, ...(f.unsupported ?? []).map((text) => ({ text, source: "none" }))],
          addressesQuestion: f.addressesQuestion ?? true,
          unanswered: f.unanswered ?? [],
        };
      }),
    };
  },
});

const followUp = (parentId: string, question: string) => ({ origin: "follow-up" as const, parentId, question, recommendation: "7 天", basis: "convention" as const, options: [], relatedIds: [] });
const firstRound = round([], ["CTR-1", "OQ-1", "OQ-2", "OQ-3", "OQ-4"]);

describe("Grounding Review", () => {
  test("a Decision stating what the user did not say is sent back, and only the grounded one is written", async () => {
    const dir = runDir();
    const b = backend(
      [[firstRound], [round([op("R1/OQ-2", ["OQ-2"], "賣家負擔運費，退款 3 天內入帳")], ["ASM-2", "ASM-1"]), round([op("R1/OQ-2", ["OQ-2"], "賣家負擔運費")], ["ASM-2", "ASM-1"])]],
      () => [reviewer((c) => (c.includes("3 天") ? { unsupported: ["退款 3 天內入帳"] } : {}))],
    );
    const report = await runClarify(options(dir, b, (q) => (q.id === "OQ-2" ? "賣家" : "/defer")));
    expect(report).toMatchObject({ status: "succeeded", termination: "converged" });

    const state = readJson<ClarifyState>(join(dir.clarify, "02-state.json"));
    expect(state.decisions.map((d) => [d.id, d.conclusion])).toEqual([["DEC-1", "賣家負擔運費"]]);
    expect(state.rounds[1]?.reviews?.map((r) => [r.attempt, r.verdicts, r.unsupported])).toEqual([
      [1, ["embellished"], ["退款 3 天內入帳"]],
      [2, [], []],
    ]);
    expect(state.rejected).toEqual([]);
    expect(readFileSync(join(dir.clarify, "traces", "clarify-r2.md"), "utf8")).toContain('states what the user did not say: "退款 3 天內入帳"');
    expect(replay(returnsBrief(), state)).toEqual(state);
  });

  test("an Answer that does not respond to its question is asked again, and left unresolved once it cannot be", async () => {
    const dir = runDir();
    const offTopic = op("R1/OQ-3", ["OQ-3"], "鑑賞期：送出後顯示申請編號");
    const b = backend(
      [
        [firstRound],
        [round([offTopic], ["ASM-2", "ASM-1"]), round([], ["ASM-2", "ASM-1"], { followUps: [followUp("OQ-3", "鑑賞期是幾天？")] })],
        // /done before the follow-up is answered: the closing round can only decide or leave OQ-3 open.
        [{ call: { decisions: [offTopic] } }, { call: { decisions: [] } }],
      ],
      () => [reviewer((c) => (c.includes("申請編號") ? { addressesQuestion: false } : {}))],
    );
    const report = await runClarify(options(dir, b, (q) => (q.id === "OQ-3" ? "送出後顯示申請編號" : q.id === "FQ-1" ? "/done" : "/defer")));
    expect(report).toMatchObject({ status: "succeeded", termination: "done" });
    expect(b.tools).toEqual(["submit_round", "submit_round", "submit_final"]);

    const state = readJson<ClarifyState>(join(dir.clarify, "02-state.json"));
    expect(state.decisions).toEqual([]);
    expect(item(state, "FQ-1")).toMatchObject({ parentId: "OQ-3", origin: "follow-up" });
    expect(item(state, "OQ-3").status).toBe("unresolved");
    expect(state.rounds.at(-1)?.accepted.leftOpen).toEqual(["OQ-3"]);
    expect(state.rounds.flatMap((r) => r.reviews ?? []).map((r) => r.verdicts)).toEqual([["off-topic"], ["off-topic"]]);
    const trace = (label: string) => readFileSync(join(dir.clarify, "traces", `${label}.md`), "utf8");
    expect(trace("clarify-r2")).toContain('remove this Decision and ask a follow-up (origin "follow-up", parentId OQ-3)');
    expect(trace("clarify-final")).toContain("OQ-3 cannot be asked again and stays unresolved");
    expect(replay(returnsBrief(), state)).toEqual(state);
  });

  test("an Answer that settles part of its question gets a follow-up for the rest; the Decision on the part may stay", async () => {
    const dir = runDir();
    const part = op("R1/OQ-1", ["OQ-1"], "已出貨的訂單不能取消");
    const b = backend(
      [[firstRound], [round([part], ["ASM-2", "ASM-1"]), round([part], ["ASM-2", "ASM-1"], { followUps: [followUp("OQ-1", "已出貨的訂單，會員要怎麼處理？")] })]],
      () => [reviewer(() => ({ unanswered: ["會員之後怎麼處理"] }))],
    );
    const report = await runClarify(options(dir, b, (q) => (q.id === "OQ-1" ? "不能取消" : q.id === "FQ-1" ? "/done" : "/defer")));
    expect(report.status).toBe("succeeded");
    const state = readJson<ClarifyState>(join(dir.clarify, "02-state.json"));
    expect(state.rounds[1]?.reviews?.map((r) => [r.attempt, r.verdicts, r.unanswered])).toEqual([
      [1, ["partial"], ["會員之後怎麼處理"]],
      [2, [], ["會員之後怎麼處理"]],
    ]);
    expect(item(state, "OQ-1")).toMatchObject({ status: "decided", children: ["FQ-1"] });
  });

  test("a Decision the review still flags on the last attempt is not written, and its Answer is interpreted again next round", async () => {
    const dir = runDir();
    const bad = op("R1/OQ-2", ["OQ-2"], "賣家負擔運費，退款 3 天內入帳");
    const b = backend(
      [[firstRound], [round([bad], ["ASM-2", "ASM-1"]), round([bad], ["ASM-2", "ASM-1"]), round([bad], ["ASM-2", "ASM-1"])], [round([op("R1/OQ-2", ["OQ-2"], "賣家負擔運費")], [])]],
      () => [reviewer((c) => (c.includes("3 天") ? { unsupported: ["退款 3 天內入帳"] } : {}))],
    );
    const report = await runClarify(options(dir, b, (q) => (q.id === "OQ-2" ? "賣家" : "/defer")));
    expect(report).toMatchObject({ status: "succeeded", termination: "converged" });
    expect(report.warnings).toContainEqual(expect.stringMatching(/clarify-r2: 1 item\(s\) rejected/));
    const state = readJson<ClarifyState>(join(dir.clarify, "02-state.json"));
    expect(state.rejected).toEqual([{ round: 2, kind: "decision", item: { id: "DEC-1", ...bad }, errors: [expect.stringContaining("states what the user did not say")] }]);
    expect(state.decisions.map((d) => [d.id, d.conclusion])).toEqual([["DEC-2", "賣家負擔運費"]]);
    expect(replay(returnsBrief(), state)).toEqual(state);
  });

  test("a review that fails fails the round, so it can be retried", async () => {
    const dir = runDir();
    const b = backend([[firstRound], [round([op("R1/OQ-2", ["OQ-2"], "賣家負擔運費")], ["ASM-2", "ASM-1"])]], () => [{ text: "no review" }]);
    const report = await runClarify(options(dir, b, (q) => (q.id === "OQ-2" ? "賣家" : "/defer")));
    expect(report.status).toBe("failed");
    expect(report.failures[0]).toMatch(/clarify-r2-review1 failed \(no-submit\)/);
    const state = readJson<ClarifyState>(join(dir.clarify, "02-state.json"));
    expect(state.decisions).toEqual([]);
    expect(item(state, "OQ-2").status).toBe("answered");
  });
});

const conflictTurn = (ids: string[]): ScriptedTurn => ({
  call: { conflicts: [{ ids, conflict: `${ids.join(" 與 ")} 不能同時成立`, question: "以哪一個為準？", recommendation: `以 ${ids[1]} 為準`, basis: "brief", options: [] }] },
});

/** Consistency Check sessions play these scripts in order, then find nothing. */
const consistencyScripts = (scripts: ScriptedTurn[][]) => {
  let next = 0;
  return () => scripts[next++] ?? [noConflicts];
};

describe("Consistency Check", () => {
  test("a conflict between Decisions is asked first in the next batch, with both sides, and settled by revising one", async () => {
    const dir = runDir();
    const b = backend(
      [
        [firstRound],
        [round([op("R1/CTR-1", ["CTR-1"], "取消期限為下單後 7 天", { supersedes: ["BR-1"] }), op("R1/OQ-1", ["OQ-1"], "下單後一律可以取消")], ["ASM-2", "ASM-1"])],
        [round([op("R2/FQ-1", ["FQ-1"], "下單後 7 天內可以取消", { revises: ["DEC-2"] })], [])],
      ],
      () => [approvingReview],
      consistencyScripts([[conflictTurn(["DEC-2", "DEC-1"])]]),
    );
    const asked: AskedQuestion[] = [];
    const answers = (q: AskedQuestion) => {
      asked.push(q);
      return { "CTR-1": "7 天", "OQ-1": "都可以取消", "FQ-1": "以 7 天為準" }[q.id] ?? "/defer";
    };
    const report = await runClarify(options(dir, b, answers));
    expect(report).toMatchObject({ status: "succeeded", termination: "converged" });

    const round2 = asked.slice(5);
    expect(round2.map((q) => q.id)).toEqual(["FQ-1", "ASM-2", "ASM-1"]);
    expect(round2[0]).toMatchObject({
      origin: "conflict",
      sides: [
        { id: "DEC-2", text: "下單後一律可以取消", answer: "R1/OQ-1: 都可以取消" },
        { id: "DEC-1", text: "取消期限為下單後 7 天", answer: "R1/CTR-1: 7 天" },
      ],
    });

    const state = readJson<ClarifyState>(join(dir.clarify, "02-state.json"));
    expect(state.decisions.map((d) => [d.id, d.status, d.revisedBy])).toEqual([
      ["DEC-1", "active", undefined],
      ["DEC-2", "revised", "DEC-3"],
      ["DEC-3", "active", undefined],
    ]);
    expect(item(state, "FQ-1")).toMatchObject({ status: "decided", origin: "conflict", relatedIds: ["DEC-2", "DEC-1"] });
    expect(readJson<AlignedBrief>(join(dir.clarify, "02-aligned.json")).decisions.find((d) => d.id === "DEC-3")?.effect).toBe("reconcile");
    expect(readFileSync(join(dir.clarify, "02-transcript.md"), "utf8")).toContain("**Conflicts found**");
    expect(replay(returnsBrief(), state)).toEqual(state);
  });

  test("a conflict found in the closing round cannot be asked and is left unresolved in the Aligned Brief", async () => {
    const dir = runDir();
    const b = backend(
      [[firstRound], [{ call: { decisions: [op("R1/CTR-1", ["CTR-1"], "取消期限為下單後 3 天", { relatedIds: ["BR-1", "BR-2"] })] } }]],
      () => [approvingReview],
      consistencyScripts([[conflictTurn(["DEC-1", "BR-2"])]]),
    );
    const report = await runClarify(options(dir, b, (q) => (q.id === "CTR-1" ? "3 天" : "/done")));
    expect(report).toMatchObject({ status: "succeeded", termination: "done" });
    const state = readJson<ClarifyState>(join(dir.clarify, "02-state.json"));
    expect(item(state, "FQ-1")).toMatchObject({ origin: "conflict", status: "unresolved", relatedIds: ["DEC-1", "BR-2"] });
    expect(readFileSync(join(dir.clarify, "02-aligned.md"), "utf8")).toMatch(/\*\*FQ-1\*\* \(unresolved\) 以哪一個為準？ _\(conflict: DEC-1 ↔ BR-2\)_/);
    expect(existsSync(join(dir.clarify, "traces", "clarify-final-consistency.md"))).toBe(true);
    expect(replay(returnsBrief(), state)).toEqual(state);
  });

  test("a Consistency Check that fails fails the round without writing its Decisions, so the round can be retried", async () => {
    const dir = runDir();
    const second = round([op("R1/CTR-1", ["CTR-1"], "取消期限為下單後 7 天", { supersedes: ["BR-1"] })], ["ASM-2", "ASM-1"]);
    const answers = (q: AskedQuestion) => (q.id === "CTR-1" ? "7 天" : "/defer");
    const failing = backend([[firstRound], [second]], () => [approvingReview], () => [{ text: "no tool call" }]);
    const report = await runClarify(options(dir, failing, answers));
    expect(report.status).toBe("failed");
    expect(report.failures[0]).toMatch(/clarify-r2-consistency failed \(no-submit\)/);
    const saved = readJson<ClarifyState>(join(dir.clarify, "02-state.json"));
    expect(saved.decisions).toEqual([]);
    expect(saved.rounds).toHaveLength(1);
    expect(item(saved, "CTR-1").status).toBe("answered");

    const retried = await runClarify(options(dir, backend([[second]]), answers));
    expect(retried).toMatchObject({ status: "succeeded", termination: "converged" });
  });
});
