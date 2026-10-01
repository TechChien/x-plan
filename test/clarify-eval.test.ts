import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentBackend, SessionOptions } from "../src/agent/types.ts";
import { createState } from "../src/clarify/agenda.ts";
import type { DecisionOp, FollowUp, Prepared } from "../src/clarify/schema.ts";
import { parseConfig } from "../src/config.ts";
import { LabelAnswerer } from "../src/eval/clarify/answerer.ts";
import { loadClarifyCase } from "../src/eval/clarify/cases.ts";
import { renderClarifyReport, runClarifyEval } from "../src/eval/clarify/run.ts";
import type { RequirementBrief } from "../src/extract/schema.ts";
import { approvingReview, noConflicts, ScriptedBackend, type ScriptedTurn } from "./helpers/scripted-backend.ts";

const CASE_DIR = join(import.meta.dirname, "..", "eval", "cases", "returns");
const labels = loadClarifyCase(join(CASE_DIR, "clarify", "answers.yaml"));
const brief = JSON.parse(readFileSync(join(CASE_DIR, "clarify", "brief.json"), "utf8")) as RequirementBrief;

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
const prep = (id: string, recommendation = "依一般慣例處理"): Prepared => ({ id, question: `請確認 ${id}`, recommendation, basis: "convention", options: [] });
const question = (extra: Partial<FollowUp> & Pick<FollowUp, "origin" | "question">): FollowUp => ({ recommendation: "依一般慣例", basis: "convention", options: [], relatedIds: [], ...extra });

/** A model that behaves well on the returns case; `cancelSupersedes` lets a test make it supersede the wrong side. */
function scripts(cancelSupersedes = "BR-1"): ScriptedTurn[][] {
  return [
    [
      {
        call: {
          decisions: [],
          followUps: [question({ origin: "gherkin-gap", question: "退貨申請送出後，會員看到什麼？", relatedIds: ["FEAT-2"] })],
          prepared: [prep("CTR-1"), prep("OQ-1"), prep("OQ-2", "商品瑕疵由賣家負擔運費，其餘由會員負擔"), prep("OQ-3"), prep("ASM-2")],
        },
      },
    ],
    [
      {
        call: {
          decisions: [
            op("R1/CTR-1", ["CTR-1"], "一般會員的取消期限為下單後 7 天", { supersedes: [cancelSupersedes] }),
            op("R1/CTR-1", ["CTR-1"], "VIP 會員的取消期限為 14 天", { relatedIds: ["FEAT-1"] }),
            op("R1/OQ-1", ["OQ-1"], "已出貨的訂單不能取消，只能收到後申請退貨"),
            op("R1/OQ-2", ["OQ-2"], "退貨運費：商品瑕疵由賣家負擔，其餘由會員負擔"),
            op("R1/ASM-2", ["ASM-2"], "取消的退款 5 到 7 個工作天入帳；退貨在審核通過後 10 個工作天入帳", { supersedes: ["ASM-2"] }),
          ],
          followUps: [question({ origin: "follow-up", parentId: "OQ-3", question: "鑑賞期 7 天從哪一天起算？" })],
          prepared: [prep("ASM-1"), prep("FQ-1")],
        },
      },
    ],
    [
      {
        call: {
          decisions: [
            op("R2/FQ-2", ["FQ-2", "OQ-3"], "鑑賞期為收到商品隔天起算 7 天"),
            op("R2/ASM-1", ["ASM-1"], "取消訂單與申請退貨都需要登入", { confirms: ["ASM-1"] }),
            op("R2/ASM-1", ["ASM-1"], "退貨運費一律由平台吸收", { revises: ["DEC-4"] }),
            op("R2/FQ-1", ["FQ-1"], "退貨申請送出後顯示申請編號，審核結果以通知告知會員"),
          ],
          followUps: [],
          prepared: [],
        },
      },
    ],
  ];
}

function backend(turns: ScriptedTurn[][]): AgentBackend {
  let next = 0;
  return new ScriptedBackend((o: SessionOptions) =>
    o.tool.name === "submit_review" ? [approvingReview] : o.tool.name === "submit_conflicts" ? [noConflicts] : (turns[next++] ?? []),
  );
}

const config = parseConfig({ provider: { baseUrl: "http://unused" } });
const run = (turns: ScriptedTurn[][]) =>
  runClarifyEval({ cases: [{ name: "returns", dir: CASE_DIR }], outDir: mkdtempSync(join(tmpdir(), "x-plan-ceval-")), repeat: 1, config, backend: async () => backend(turns), log: () => {} });

describe("the returns Clarify case", () => {
  test("its labels target items that are on the fixture Brief's Agenda", () => {
    const agenda = new Set(createState(brief, "sha", "zh").agenda.map((i) => i.id));
    expect(labels.answers.map((a) => a.target).filter((t) => !agenda.has(t))).toEqual([]);
  });
});

describe("LabelAnswerer", () => {
  const ask = async (questions: Parameters<LabelAnswerer["ask"]>[0]) => {
    const answerer = new LabelAnswerer(labels);
    const recorded: unknown[] = [];
    await answerer.ask(questions, { round: 1, record: (input) => (recorded.push(input), undefined) });
    return { recorded, log: answerer.log };
  };
  const q = (id: string, extra: Partial<Parameters<LabelAnswerer["ask"]>[0][number]> = {}) => ({
    id,
    kind: "OQ" as const,
    origin: "brief" as const,
    relatedIds: [],
    question: "?",
    recommendation: "r",
    basis: "convention" as const,
    options: [],
    ...extra,
  });

  test("answers targets by id, follow-ups through their parent's label, gaps by relatedIds, and the rest as noise", async () => {
    const { recorded, log } = await ask([
      q("OQ-3"),
      q("FQ-1", { kind: "FQ", origin: "follow-up", parentId: "OQ-3", question: "從哪一天起算？" }),
      q("FQ-2", { kind: "FQ", origin: "follow-up", parentId: "OQ-3", question: "VIP 也一樣嗎？" }),
      q("FQ-3", { kind: "FQ", origin: "gherkin-gap", relatedIds: ["FEAT-2", "BR-3"] }),
      q("ASM-9"),
    ]);
    expect(recorded).toEqual([
      { type: "response", itemId: "OQ-3", kind: "text", text: "鑑賞期就是 7 天" },
      { type: "response", itemId: "FQ-1", kind: "text", text: "從收到商品的隔天開始算" },
      { type: "response", itemId: "FQ-2", kind: "na", text: "" },
      { type: "response", itemId: "FQ-3", kind: "text", text: "送出後顯示退貨申請編號，審核結果以通知告知會員" },
      { type: "response", itemId: "ASM-9", kind: "na", text: "" },
    ]);
    expect(log.map((e) => [e.questionId, e.role, e.label])).toEqual([
      ["OQ-3", "target", "appraisal"],
      ["FQ-1", "followUp", "appraisal"],
      ["FQ-2", "followUp", "appraisal"],
      ["FQ-3", "gap", "return-ac"],
      ["ASM-9", "unmatched", undefined],
    ]);
  });

  test("a follow-up reply is given once; a later follow-up of the same label is answered as unmatched", async () => {
    const { recorded } = await ask([
      q("OQ-3"),
      q("FQ-1", { kind: "FQ", origin: "follow-up", parentId: "OQ-3", question: "從哪一天起算？" }),
      q("FQ-2", { kind: "FQ", origin: "follow-up", parentId: "FQ-1", question: "起算後是日曆天還是工作天？" }),
    ]);
    expect(recorded.map((r) => (r as { kind: string }).kind)).toEqual(["text", "text", "na"]);
  });

  test("a conflict question is answered by the conflict label its question matches, once; any other is unmatched", async () => {
    const { recorded, log } = await ask([
      q("FQ-7", { kind: "FQ", origin: "conflict", question: "DEC-4 與 DEC-7 的退貨運費規定不一致，以哪一個為準？" }),
      q("FQ-8", { kind: "FQ", origin: "conflict", question: "運費的兩條 Decision 又衝突了？" }),
    ]);
    expect(recorded).toEqual([
      { type: "response", itemId: "FQ-7", kind: "text", text: "以先前為準：商品瑕疵由平台負擔，個人因素退貨由會員負擔；平台吸收只適用於瑕疵品" },
      { type: "response", itemId: "FQ-8", kind: "na", text: "" },
    ]);
    expect(log.map((e) => [e.questionId, e.role, e.label])).toEqual([
      ["FQ-7", "conflict", "fee-conflict"],
      ["FQ-8", "unmatched", undefined],
    ]);
  });

  test("a gap label answers only the first gap it matches; later matching gaps are noise", async () => {
    const answerer = new LabelAnswerer(labels);
    const recorded: unknown[] = [];
    const session = (round: number) => ({ round, record: (input: unknown) => (recorded.push(input), undefined) });
    await answerer.ask([q("FQ-1", { kind: "FQ", origin: "gherkin-gap", relatedIds: ["FEAT-2", "BR-3"] }), q("FQ-2", { kind: "FQ", origin: "gherkin-gap", relatedIds: ["FEAT-2"] })], session(1));
    await answerer.ask([q("FQ-3", { kind: "FQ", origin: "gherkin-gap", relatedIds: ["BR-4", "FEAT-2"] })], session(2));
    expect(recorded).toEqual([
      { type: "response", itemId: "FQ-1", kind: "text", text: "送出後顯示退貨申請編號，審核結果以通知告知會員" },
      { type: "response", itemId: "FQ-2", kind: "na", text: "" },
      { type: "response", itemId: "FQ-3", kind: "na", text: "" },
    ]);
    expect(answerer.log.map((e) => [e.questionId, e.role, e.label])).toEqual([
      ["FQ-1", "gap", "return-ac"],
      ["FQ-2", "unmatched", undefined],
      ["FQ-3", "unmatched", undefined],
    ]);
  });
});

describe("runClarifyEval", () => {
  test("a model that gets everything right scores full marks", async () => {
    const [result] = await run(scripts());
    expect(result).toMatchObject({ status: "succeeded", failures: [] });
    expect(result!.score).toEqual({
      interpretation: {
        hit: ["cancel-window#1", "cancel-window#2", "shipped-order#1", "return-fee#1", "appraisal/follow-up#1", "login#1", "refund-days#1"],
        missed: [],
      },
      wrongSupersedes: [],
      followUps: { raised: ["appraisal"], missed: [], unneeded: [] },
      gaps: { raised: ["return-ac"], missed: [] },
      noise: [],
      recommendations: { good: ["return-fee"], bad: [] },
      selfAnswerBlocked: 0,
      review: { embellished: 0, partial: 0, offTopic: 0 },
      conflicts: { handled: ["fee-conflict"], missed: [], unneeded: [] },
      rounds: 3,
      questionsAsked: 8,
      termination: "converged",
    });
  });

  test("superseding the wrong side of a contradiction is caught twice: a missed Decision and a wrong supersede", async () => {
    const [result] = await run(scripts("BR-2"));
    expect(result!.score!.interpretation.missed).toEqual(["cancel-window#1"]);
    expect(result!.score!.wrongSupersedes).toEqual([{ decision: "DEC-1", item: "BR-2" }]);
  });

  test("the report summarises and details each run", async () => {
    const results = await run(scripts("BR-2"));
    const report = renderClarifyReport(results);
    expect(report).toContain("| returns | 1/1 | 86% | 1 |");
    expect(report).toContain("錯誤推翻：DEC-1 supersedes BR-2");
  });
});
