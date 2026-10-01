import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentBackend } from "../agent/types.ts";
import type { XPlanConfig } from "../config.ts";
import type { RequirementBrief } from "../extract/schema.ts";
import { runExtract } from "../extract/stage.ts";
import { loadExpected } from "./expected.ts";
import { scoreCase, type CaseScore } from "./score.ts";

export interface EvalCase {
  name: string;
  /** Contains `docs/` and `expected.yaml`. */
  dir: string;
}

export interface RunMetrics {
  submitAttempts: number;
  schemaFailures: number;
  checkFailures: number;
  nudges: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  durationMs: number;
}

export interface RunResult {
  caseName: string;
  repeat: number;
  runDir: string;
  status: string;
  failures: string[];
  score?: CaseScore;
  rejectedCount: number;
  bins: number;
  metrics: RunMetrics;
  /** Template hashes the run used, to tell prompt versions apart when comparing reports. */
  promptHashes: Record<string, string>;
}

export interface EvalOptions {
  cases: EvalCase[];
  outDir: string;
  repeat: number;
  config: XPlanConfig;
  backend: (runDir: string) => Promise<AgentBackend>;
  log: (message: string) => void;
}

export async function runEval(opts: EvalOptions): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const c of opts.cases) {
    const expected = loadExpected(join(c.dir, "expected.yaml"));
    for (let k = 1; k <= opts.repeat; k++) {
      const runDir = join(opts.outDir, c.name, `run-${k}`);
      opts.log(`[eval] ${c.name} run ${k}/${opts.repeat}`);
      let status = "failed";
      let failures: string[] = [];
      try {
        const report = await runExtract({
          dir: join(c.dir, "docs"),
          runDir,
          config: opts.config,
          packing: expected.packing,
          reference: expected.reference,
          outputLanguage: expected.language,
          backend: () => opts.backend(runDir),
          log: (m) => opts.log(`  ${m}`),
        });
        status = report.status;
        failures = report.failures;
      } catch (error) {
        failures = [error instanceof Error ? error.message : String(error)];
      }
      const briefPath = join(runDir, "01-brief.json");
      const score = existsSync(briefPath) ? scoreCase(expected, readJson<RequirementBrief>(briefPath)) : undefined;
      const run = existsSync(join(runDir, "run.json")) ? readJson<RunJson>(join(runDir, "run.json")) : undefined;
      results.push({
        caseName: c.name,
        repeat: k,
        runDir,
        status,
        failures,
        score,
        rejectedCount: run?.rejectedCount ?? 0,
        bins: run?.bins.length ?? 0,
        metrics: sumMetrics(run?.agents ?? []),
        promptHashes: run?.promptHashes ?? {},
      });
    }
  }
  return results;
}

interface RunJson {
  rejectedCount?: number;
  promptHashes: Record<string, string>;
  bins: unknown[];
  agents: { metrics: { submitAttempts: number; schemaFailures: number; checkFailures: number; nudges: number; tokens: { input: number; output: number; reasoning: number }; durationMs: number } }[];
}

function sumMetrics(agents: RunJson["agents"]): RunMetrics {
  const m: RunMetrics = { submitAttempts: 0, schemaFailures: 0, checkFailures: 0, nudges: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, durationMs: 0 };
  for (const { metrics: a } of agents) {
    m.submitAttempts += a.submitAttempts;
    m.schemaFailures += a.schemaFailures;
    m.checkFailures += a.checkFailures;
    m.nudges += a.nudges;
    m.inputTokens += a.tokens.input;
    m.outputTokens += a.tokens.output;
    m.reasoningTokens += a.tokens.reasoning;
    m.durationMs = Math.max(m.durationMs, a.durationMs);
  }
  return m;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

export function renderReport(results: RunResult[]): string {
  const out: string[] = ["# x-plan Extract eval", ""];
  const cases = [...new Set(results.map((r) => r.caseName))];

  out.push(
    "## 總覽",
    "",
    "| case | 成功 | 召回率 | 矛盾偵測 | 真問題提出 | 多餘問題 | 雜訊 | 重複假設 | 條目數 | Rejected | 交卷次數 (schema/check 錯) | nudges | tokens in/out/reasoning |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const name of cases) {
    const rs = results.filter((r) => r.caseName === name);
    const scored = rs.filter((r) => r.score);
    const found = scored.reduce((n, r) => n + r.score!.recall.found.length, 0);
    const total = scored.reduce((n, r) => n + r.score!.recall.found.length + r.score!.recall.missing.length, 0);
    const cFound = scored.reduce((n, r) => n + r.score!.contradictions.found.length, 0);
    const cTotal = scored.reduce((n, r) => n + r.score!.contradictions.found.length + r.score!.contradictions.missing.length, 0);
    const nHit = scored.reduce((n, r) => n + r.score!.noise.hits.length, 0);
    const nTotal = scored.reduce((n, r) => n + r.score!.noise.labels, 0);
    const qRaised = scored.reduce((n, r) => n + r.score!.questions.raised.length, 0);
    const qTotal = scored.reduce((n, r) => n + r.score!.questions.raised.length + r.score!.questions.neverRaised.length, 0);
    const unwanted = scored.reduce((n, r) => n + r.score!.questions.unwanted.reduce((k, u) => k + u.questions.length, 0), 0);
    const duplicates = scored.reduce((n, r) => n + r.score!.duplicateAssumptions.reduce((k, d) => k + d.itemIds.length, 0), 0);
    const items = scored.length ? avg(scored.map((r) => r.score!.items)) : "—";
    const m = (f: (x: RunMetrics) => number) => avg(rs.map((r) => f(r.metrics)));
    out.push(
      `| ${name} | ${rs.filter((r) => r.status === "succeeded").length}/${rs.length} | ${pct(found, total)} | ${pct(cFound, cTotal)} | ${pct(qRaised, qTotal)} | ${unwanted} | ${pct(nHit, nTotal)} | ${duplicates} | ${items} | ${avg(rs.map((r) => r.rejectedCount))} | ${m((x) => x.submitAttempts)} (${m((x) => x.schemaFailures)}/${m((x) => x.checkFailures)}) | ${m((x) => x.nudges)} | ${m((x) => x.inputTokens)}/${m((x) => x.outputTokens)}/${m((x) => x.reasoningTokens)} |`,
    );
  }
  out.push(
    "",
    "_數值為各次執行的平均；召回率、矛盾偵測、真問題提出與雜訊為所有執行合計。真問題是 `mustBeRaised` 標籤被提出的比例；多餘問題是命中 `shouldNotBeRaised` 的問題總數；雜訊是 `unexpected` 標籤的命中率；重複假設是寫出某個 Open Question 答案的 Assumption 總數（`assumptions.shouldNotDuplicate`）。後三者越低越好。_",
    "",
  );

  out.push("## 明細", "");
  for (const r of results) {
    out.push(`### ${r.caseName} run ${r.repeat} — ${r.status}（${r.bins} 批）`, "", `run 目錄：\`${r.runDir}\``, "");
    for (const f of r.failures) out.push(`- ✗ ${f}`);
    if (!r.score) {
      out.push("");
      continue;
    }
    const s = r.score;
    if (s.recall.missing.length) out.push(`- 未擷取：${s.recall.missing.join(", ")}`);
    if (s.contradictions.missing.length) out.push(`- 未偵測的矛盾：${s.contradictions.missing.join(", ")}`);
    if (s.questions.neverRaised.length) out.push(`- 未提出的真問題：${s.questions.neverRaised.join(", ")}`);
    for (const u of s.questions.unwanted) out.push(`- 多餘問題 [${u.label}] ${u.questions.map((q) => `${q.id}「${q.question}」`).join("、")}`);
    for (const n of s.noise.hits) out.push(`- 雜訊 [${n.label}] ${n.itemIds.join(", ")}`);
    for (const d of s.duplicateAssumptions) out.push(`- 重複假設 [${d.label}] ${d.itemIds.join(", ")}`);
    out.push("");
  }
  const hashes = results.find((r) => Object.keys(r.promptHashes).length)?.promptHashes;
  if (hashes) out.push("## Prompt 版本", "", "```json", JSON.stringify(hashes, null, 2), "```", "");
  return `${out.join("\n")}\n`;
}
