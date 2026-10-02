import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentBackend } from "../../agent/types.ts";
import { findItem } from "../../clarify/agenda.ts";
import type { ClarifyState } from "../../clarify/schema.ts";
import { runClarify } from "../../clarify/stage.ts";
import type { XPlanConfig } from "../../config.ts";
import type { RequirementBrief } from "../../extract/schema.ts";
import { LabelAnswerer } from "./answerer.ts";
import { loadClarifyCase } from "./cases.ts";
import { scoreClarify, type ClarifyScore } from "./score.ts";

export interface ClarifyEvalCase {
  name: string;
  /** Contains `clarify/brief.json` and `clarify/answers.yaml`. */
  dir: string;
}

export interface ClarifyRunMetrics {
  submitAttempts: number;
  checkFailures: number;
  nudges: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadRatio: number;
  languageWarnings: number;
}

export interface ClarifyRunResult {
  caseName: string;
  repeat: number;
  runDir: string;
  status: string;
  failures: string[];
  score?: ClarifyScore;
  rejectedCount: number;
  metrics: ClarifyRunMetrics;
  promptHashes: Record<string, string>;
}

export interface ClarifyEvalOptions {
  cases: ClarifyEvalCase[];
  outDir: string;
  repeat: number;
  config: XPlanConfig;
  backend: (runDir: string) => Promise<AgentBackend>;
  log: (message: string) => void;
}

/** Messages of the check rules that stop a Decision made without the user's Answer (ADR 0007). */
const SELF_ANSWER = [/is not an Answer awaiting interpretation/g, /has no Answer; if an earlier Answer covers it/g];

export async function runClarifyEval(opts: ClarifyEvalOptions): Promise<ClarifyRunResult[]> {
  const results: ClarifyRunResult[] = [];
  for (const c of opts.cases) {
    const labels = loadClarifyCase(join(c.dir, "clarify", "answers.yaml"));
    const briefText = readFileSync(join(c.dir, "clarify", "brief.json"), "utf8");
    const brief = JSON.parse(briefText) as RequirementBrief;
    // The fixed Brief stands in for an Extract Run; every repeat is a separate Clarify Run from it (ADR 0010).
    const extractDir = join(opts.outDir, c.name, "extract-fixture");
    mkdirSync(extractDir, { recursive: true });
    writeFileSync(join(extractDir, "01-brief.json"), briefText);
    writeFileSync(join(extractDir, "run.json"), JSON.stringify({ stage: "extract", status: "succeeded", source: { kind: "fixture" }, outputLanguage: labels.language ?? "en" }));
    for (let k = 1; k <= opts.repeat; k++) {
      const runDir = join(opts.outDir, c.name, `clarify-${k}`);
      opts.log(`[eval] ${c.name} clarify run ${k}/${opts.repeat}`);

      const answerer = new LabelAnswerer(labels);
      let status = "failed";
      let failures: string[] = [];
      let warnings: string[] = [];
      try {
        const report = await runClarify({ runDir, sourceRunDir: extractDir, config: opts.config, answerer, backend: () => opts.backend(runDir), log: (m) => opts.log(`  ${m}`) });
        status = report.status;
        failures = report.failures;
        warnings = report.warnings;
      } catch (error) {
        failures = [error instanceof Error ? error.message : String(error)];
      }
      writeFileSync(join(runDir, "eval-answers.json"), `${JSON.stringify(answerer.log, null, 2)}\n`);

      const statePath = join(runDir, "02-state.json");
      const state = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as ClarifyState) : undefined;
      if (state) {
        const missing = labels.answers.filter((a) => !findItem(state, a.target)).map((a) => a.target);
        if (missing.length) throw new Error(`${c.name}: labels target items that are not on the Agenda: ${missing.join(", ")}`);
      }
      const run = existsSync(join(runDir, "run.json")) ? (JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as RunJson) : undefined;
      results.push({
        caseName: c.name,
        repeat: k,
        runDir,
        status,
        failures,
        ...(state ? { score: scoreClarify(labels, brief, state, answerer.log, countSelfAnswers(runDir)) } : {}),
        rejectedCount: run?.rejectedCount ?? 0,
        metrics: sumMetrics(run?.agents ?? [], warnings),
        promptHashes: run?.promptHashes ?? {},
      });
    }
  }
  return results;
}

interface RunJson {
  rejectedCount?: number;
  promptHashes: Record<string, string>;
  agents: { cacheReadRatio: number; metrics: { submitAttempts: number; checkFailures: number; nudges: number; tokens: { input: number; output: number } } }[];
}

function sumMetrics(agents: RunJson["agents"], warnings: string[]): ClarifyRunMetrics {
  const m: ClarifyRunMetrics = { submitAttempts: 0, checkFailures: 0, nudges: 0, inputTokens: 0, outputTokens: 0, cacheReadRatio: 0, languageWarnings: 0 };
  for (const a of agents) {
    m.submitAttempts += a.metrics.submitAttempts;
    m.checkFailures += a.metrics.checkFailures;
    m.nudges += a.metrics.nudges;
    m.inputTokens += a.metrics.tokens.input;
    m.outputTokens += a.metrics.tokens.output;
  }
  // Round 1 can never hit the cache, so the ratio averages the later rounds.
  const later = agents.slice(1);
  m.cacheReadRatio = later.length ? Number((later.reduce((n, a) => n + a.cacheReadRatio, 0) / later.length).toFixed(2)) : 0;
  m.languageWarnings = warnings.filter((w) => w.includes("still not written in")).length;
  return m;
}

function countSelfAnswers(runDir: string): number {
  const traces = join(runDir, "traces");
  if (!existsSync(traces)) return 0;
  return readdirSync(traces)
    .filter((f) => f.startsWith("clarify-") && f.endsWith(".md"))
    .map((f) => readFileSync(join(traces, f), "utf8"))
    .reduce((n, text) => n + SELF_ANSWER.reduce((k, re) => k + (text.match(re)?.length ?? 0), 0), 0);
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);

export function renderClarifyReport(results: ClarifyRunResult[]): string {
  const out: string[] = ["# x-plan Clarify eval", ""];
  const cases = [...new Set(results.map((r) => r.caseName))];
  out.push(
    "## 總覽",
    "",
    "| case | 成功 | 解讀正確 | 錯誤推翻 | 追問召回 | 多餘追問 | gap 召回 | 衝突處理 | 多餘衝突題 | 雜訊題 | 建議命中 | 自行作答攔截 | Review 攔下 (多加/部分/離題/過度推翻) | Round | 結束 | 交卷 (check 錯) | cache 命中 | tokens in/out |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const name of cases) {
    const rs = results.filter((r) => r.caseName === name);
    const s = rs.flatMap((r) => (r.score ? [r.score] : []));
    const sum = (f: (x: ClarifyScore) => number) => s.reduce((n, x) => n + f(x), 0);
    const m = (f: (x: ClarifyRunResult["metrics"]) => number) => avg(rs.map((r) => f(r.metrics)));
    const terminations = [...new Set(s.map((x) => x.termination ?? "—"))].join("/");
    out.push(
      `| ${name} | ${rs.filter((r) => r.status === "succeeded").length}/${rs.length} | ${pct(sum((x) => x.interpretation.hit.length), sum((x) => x.interpretation.hit.length + x.interpretation.missed.length))} | ${sum((x) => x.wrongSupersedes.length)} | ${pct(sum((x) => x.followUps.raised.length), sum((x) => x.followUps.raised.length + x.followUps.missed.length))} | ${sum((x) => x.followUps.unneeded.reduce((n, u) => n + u.questions.length, 0))} | ${pct(sum((x) => x.gaps.raised.length), sum((x) => x.gaps.raised.length + x.gaps.missed.length))} | ${pct(sum((x) => x.conflicts.handled.length), sum((x) => x.conflicts.handled.length + x.conflicts.missed.length))} | ${sum((x) => x.conflicts.unneeded.length)} | ${sum((x) => x.noise.length)} | ${pct(sum((x) => x.recommendations.good.length), sum((x) => x.recommendations.good.length + x.recommendations.bad.length))} | ${sum((x) => x.selfAnswerBlocked)} | ${sum((x) => x.review.embellished)}/${sum((x) => x.review.partial)}/${sum((x) => x.review.offTopic)}/${sum((x) => x.review.overreach)} | ${avg(s.map((x) => x.rounds))} | ${terminations} | ${m((x) => x.submitAttempts)} (${m((x) => x.checkFailures)}) | ${m((x) => x.cacheReadRatio)} | ${m((x) => x.inputTokens)}/${m((x) => x.outputTokens)} |`,
    );
  }
  out.push(
    "",
    "_比例為所有執行合計，其餘為平均。衝突處理是 `conflicts` 標註被提成衝突題、或被 interpreter 自行 revise 的比例；錯誤推翻、多餘追問、多餘衝突題、雜訊題、自行作答攔截越低越好；Review 攔下是 Grounding Review 退回的 Decision 數（每次交卷分別計），越低代表 interpreter 第一次就寫對；cache 命中不含第 1 Round。_",
    "",
    "## 明細",
    "",
  );
  for (const r of results) {
    out.push(`### ${r.caseName} run ${r.repeat} — ${r.status}`, "", `run 目錄：\`${r.runDir}\``, "");
    for (const f of r.failures) out.push(`- ✗ ${f}`);
    const s = r.score;
    if (s) {
      if (s.interpretation.missed.length) out.push(`- 未得到的 Decision：${s.interpretation.missed.join(", ")}`);
      for (const w of s.wrongSupersedes) out.push(`- 錯誤推翻：${w.decision} supersedes ${w.item}`);
      if (s.followUps.missed.length) out.push(`- 該追問未追問：${s.followUps.missed.join(", ")}`);
      for (const u of s.followUps.unneeded) out.push(`- 多餘追問 [${u.label}] ${u.questions.join("、")}`);
      if (s.gaps.missed.length) out.push(`- 未提出的 gap：${s.gaps.missed.join(", ")}`);
      if (s.conflicts.missed.length) out.push(`- 未處理的衝突：${s.conflicts.missed.join(", ")}`);
      for (const c of s.conflicts.unneeded) out.push(`- 多餘衝突題 ${c.id}「${c.question}」`);
      for (const n of s.noise) out.push(`- 雜訊題 ${n.id}「${n.question}」`);
      if (s.recommendations.bad.length) out.push(`- 建議答案未命中：${s.recommendations.bad.join(", ")}`);
    }
    out.push("");
  }
  const hashes = results.find((r) => Object.keys(r.promptHashes).length)?.promptHashes;
  if (hashes) out.push("## Prompt 版本", "", "```json", JSON.stringify(hashes, null, 2), "```", "");
  return `${out.join("\n")}\n`;
}
