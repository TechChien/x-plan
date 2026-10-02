import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentBackend } from "../../agent/types.ts";
import type { AlignedBrief } from "../../clarify/aligned.ts";
import type { XPlanConfig } from "../../config.ts";
import type { WriteTrace } from "../../write/render.ts";
import type { ScenarioReviewRecord } from "../../write/review.ts";
import type { WriteOutline, WrittenFeature } from "../../write/schema.ts";
import { runWrite } from "../../write/stage.ts";
import type { AppliedReplacement } from "../../write/vocabulary.ts";
import { loadWriteCase } from "./cases.ts";
import { scoreWrite, type WriteArtifacts, type WriteScore } from "./score.ts";

export interface WriteEvalCase {
  name: string;
  /** Contains `write/aligned.json` and `write/expected.yaml`. */
  dir: string;
}

export interface WriteRunMetrics {
  submitAttempts: number;
  checkFailures: number;
  nudges: number;
  inputTokens: number;
  outputTokens: number;
  /** Writers after the first, which share the `<context>` prefix (ADR 0015). */
  writerCacheReadRatio: number;
  languageWarnings: number;
}

export interface WriteRunResult {
  caseName: string;
  repeat: number;
  runDir: string;
  status: string;
  failures: string[];
  score?: WriteScore;
  metrics: WriteRunMetrics;
  promptHashes: Record<string, string>;
}

export interface WriteEvalOptions {
  cases: WriteEvalCase[];
  outDir: string;
  repeat: number;
  config: XPlanConfig;
  backend: (runDir: string) => Promise<AgentBackend>;
  log: (message: string) => void;
}

interface AgentJson {
  label: string;
  cacheReadRatio: number;
  metrics: { submitAttempts: number; checkFailures: number; nudges: number; tokens: { input: number; output: number } };
}

export async function runWriteEval(opts: WriteEvalOptions): Promise<WriteRunResult[]> {
  const results: WriteRunResult[] = [];
  for (const c of opts.cases) {
    const labels = loadWriteCase(join(c.dir, "write", "expected.yaml"));
    const alignedPath = join(c.dir, "write", "aligned.json");
    const aligned = JSON.parse(readFileSync(alignedPath, "utf8")) as AlignedBrief;
    // The fixed Aligned Brief stands in for a Clarify Run; every repeat is a separate Write Run from it (ADR 0010).
    const clarifyDir = join(opts.outDir, c.name, "clarify-fixture");
    mkdirSync(clarifyDir, { recursive: true });
    copyFileSync(alignedPath, join(clarifyDir, "02-aligned.json"));
    writeFileSync(join(clarifyDir, "run.json"), JSON.stringify({ stage: "clarify", status: "succeeded", source: { kind: "fixture" }, outputLanguage: aligned.outputLanguage }));
    for (let k = 1; k <= opts.repeat; k++) {
      const runDir = join(opts.outDir, c.name, `write-${k}`);
      opts.log(`[eval] ${c.name} write run ${k}/${opts.repeat}`);
      let status = "failed";
      let failures: string[] = [];
      let warnings: string[] = [];
      try {
        const report = await runWrite({ runDir, sourceRunDir: clarifyDir, config: opts.config, backend: () => opts.backend(runDir), log: (m) => opts.log(`  ${m}`) });
        status = report.status;
        failures = report.failures;
        warnings = report.warnings;
      } catch (error) {
        failures = [error instanceof Error ? error.message : String(error)];
      }
      const run = existsSync(join(runDir, "run.json")) ? (JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as { agents?: AgentJson[]; promptHashes?: Record<string, string> }) : undefined;
      const artifacts = readArtifacts(runDir, run?.agents ?? []);
      results.push({
        caseName: c.name,
        repeat: k,
        runDir,
        status,
        failures,
        ...(artifacts ? { score: scoreWrite(labels, artifacts) } : {}),
        metrics: sumMetrics(run?.agents ?? [], warnings),
        promptHashes: run?.promptHashes ?? {},
      });
    }
  }
  return results;
}

/** Undefined when the Run stopped before rendering (the outline failed). */
export function readArtifacts(runDir: string, agents: AgentJson[]): WriteArtifacts | undefined {
  const file = (name: string) => join(runDir, name);
  if (!existsSync(file("03-trace.json"))) return undefined;
  const json = <T>(name: string): T => JSON.parse(readFileSync(file(name), "utf8")) as T;
  const trace = json<WriteTrace & { reviews: Record<string, ScenarioReviewRecord[]> }>("03-trace.json");
  const featuresDir = file("features");
  return {
    outline: json<WriteOutline>("03-outline.json"),
    before: new Map(Object.entries(json<{ features: Record<string, WrittenFeature> }>("03-written.json").features)),
    after: trace,
    reviews: trace.reviews ?? {},
    ...(existsSync(file("03-vocabulary.json")) ? { vocabulary: json<{ entries: unknown[]; applied: AppliedReplacement[]; skipped: unknown[] }>("03-vocabulary.json") } : {}),
    featureFiles: existsSync(featuresDir)
      ? Object.fromEntries(readdirSync(featuresDir).filter((f) => f.endsWith(".feature")).map((f) => [f.replace(/\.feature$/, ""), readFileSync(join(featuresDir, f), "utf8")]))
      : {},
    agents,
  };
}

function sumMetrics(agents: AgentJson[], warnings: string[]): WriteRunMetrics {
  const m: WriteRunMetrics = { submitAttempts: 0, checkFailures: 0, nudges: 0, inputTokens: 0, outputTokens: 0, writerCacheReadRatio: 0, languageWarnings: 0 };
  for (const a of agents) {
    m.submitAttempts += a.metrics.submitAttempts;
    m.checkFailures += a.metrics.checkFailures;
    m.nudges += a.metrics.nudges;
    m.inputTokens += a.metrics.tokens.input;
    m.outputTokens += a.metrics.tokens.output;
  }
  // Writers of the first batch: reviews and rewrites carry a suffix.
  const writers = agents.filter((a) => /^write-FEAT-N?\d+$/.test(a.label)).slice(1);
  m.writerCacheReadRatio = writers.length ? Number((writers.reduce((n, a) => n + a.cacheReadRatio, 0) / writers.length).toFixed(2)) : 0;
  m.languageWarnings = warnings.filter((w) => w.includes("still not written in")).length;
  return m;
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);

export function renderWriteReport(results: WriteRunResult[]): string {
  const out: string[] = ["# x-plan Write eval", ""];
  const cases = [...new Set(results.map((r) => r.caseName))];
  out.push(
    "## 總覽",
    "",
    "| case | 成功 | 必要情境召回 (統一前) | 被推翻內容 (統一前) | 未決呈現 | 覆蓋退回 | Review 攔下 (多寫/相反/無出處數值/推導過頭/引錯) | @unverified | @unwritten | 未覆蓋 | 情境數 | @derived | notBehavioral | 新 Feature | 只引用 FEAT | 降為 open | 變體說法 統一前→後 | 錯誤合併 | 替換 (跳過) | 詞條 | 解析失敗 | 交卷 (check 錯) | writer cache | tokens in/out |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const name of cases) {
    const rs = results.filter((r) => r.caseName === name);
    const s = rs.flatMap((r) => (r.score ? [r.score] : []));
    const sum = (f: (x: WriteScore) => number) => s.reduce((n, x) => n + f(x), 0);
    const mean = (f: (x: WriteScore) => number) => avg(s.map(f));
    const m = (f: (x: WriteRunMetrics) => number) => avg(rs.map((r) => f(r.metrics)));
    const cells = [
      name,
      `${rs.filter((r) => r.status === "succeeded").length}/${rs.length}`,
      `${pct(sum((x) => x.mustHave.hit.length), sum((x) => x.mustHave.hit.length + x.mustHave.missed.length))} (${pct(sum((x) => x.mustHaveBefore.hit.length), sum((x) => x.mustHaveBefore.hit.length + x.mustHaveBefore.missed.length))})`,
      `${sum((x) => x.stale.length)} (${sum((x) => x.staleBefore)})`,
      pct(sum((x) => x.open.shown.length), sum((x) => x.open.shown.length + x.open.missed.length)),
      String(sum((x) => x.outlineRejections)),
      ["unsupported", "contradicts", "invented-value", "underived", "misattributed"].map((v) => sum((x) => x.review[v as keyof WriteScore["review"]])).join("/"),
      String(sum((x) => x.unverified)),
      String(sum((x) => x.unwritten)),
      String(sum((x) => x.uncovered)),
      String(mean((x) => x.scenarios)),
      pct(sum((x) => x.derived), sum((x) => x.scenarios - x.unwritten)),
      String(sum((x) => x.notBehavioral)),
      String(sum((x) => x.newFeatures)),
      String(sum((x) => x.featureOnly)),
      String(sum((x) => x.downgraded)),
      `${sum((x) => x.vocabulary.variantsBefore)}→${sum((x) => x.vocabulary.variantsAfter)}`,
      String(sum((x) => x.vocabulary.wrongMerges.length)),
      `${sum((x) => x.vocabulary.replacements)} (${sum((x) => x.vocabulary.skipped)})`,
      String(mean((x) => x.vocabulary.entries)),
      String(sum((x) => x.invalidFiles.length)),
      `${m((x) => x.submitAttempts)} (${m((x) => x.checkFailures)})`,
      String(m((x) => x.writerCacheReadRatio)),
      `${m((x) => x.inputTokens)}/${m((x) => x.outputTokens)}`,
    ];
    out.push(`| ${cells.join(" | ")} |`);
  }
  out.push(
    "",
    "_比例為所有執行合計，情境數、詞條數與執行指標為平均，其餘為合計。括號中的「統一前」是 writer 原本的文字，用來看用語統一有沒有改壞意思（ADR 0019）。被推翻內容、覆蓋退回、Review 攔下、錯誤合併越低越好；只引用 FEAT 是 Clarify 該問而沒問的 gherkin-gap；writer cache 不含第一個 writer。_",
    "",
    "## 明細",
    "",
  );
  for (const r of results) {
    out.push(`### ${r.caseName} run ${r.repeat} — ${r.status}`, "", `run 目錄：\`${r.runDir}\``, "");
    for (const f of r.failures) out.push(`- ✗ ${f}`);
    const s = r.score;
    if (s) {
      if (s.mustHave.missed.length) out.push(`- 缺少的必要情境：${s.mustHave.missed.join(", ")}`);
      const lostByVocabulary = s.mustHaveBefore.hit.filter((id) => s.mustHave.missed.includes(id));
      if (lostByVocabulary.length) out.push(`- 用語統一後才缺少的：${lostByVocabulary.join(", ")}`);
      for (const x of s.stale) out.push(`- 被推翻內容 [${x.id}] 出現在 ${x.scenario}`);
      if (s.open.missed.length) out.push(`- 未以 @open / @deferred 呈現：${s.open.missed.join(", ")}`);
      for (const w of s.vocabulary.wrongMerges) out.push(`- 錯誤合併 ${w.loc}：「${w.from}」→「${w.to}」`);
      if (s.invalidFiles.length) out.push(`- 解析失敗：${s.invalidFiles.join(", ")}`);
    }
    out.push("");
  }
  const hashes = results.find((r) => Object.keys(r.promptHashes).length)?.promptHashes;
  if (hashes) out.push("## Prompt 版本", "", "```json", JSON.stringify(hashes, null, 2), "```", "");
  return `${out.join("\n")}\n`;
}
