/**
 * Live eval of a stage against the configured model.
 *
 *   XPLAN_API_KEY=... pnpm eval [--stage extract|clarify] [--cases returns glossary-split] [--repeat 3] [--config path]
 *
 * Writes eval/results/<timestamp>/report.md (+ report.json and every run directory). Clarify runs the cases that
 * have a clarify/ directory, starting from its fixed brief.json.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiBackend } from "../src/agent/pi-backend.ts";
import { loadConfig } from "../src/config.ts";
import { renderClarifyReport, runClarifyEval } from "../src/eval/clarify/run.ts";
import { renderReport, runEval } from "../src/eval/run-eval.ts";

const CASES_DIR = join(import.meta.dirname, "..", "eval", "cases");

function arg(name: string): string[] {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return [];
  const values: string[] = [];
  for (let j = i + 1; j < process.argv.length && !process.argv[j]!.startsWith("--"); j++) values.push(process.argv[j]!);
  return values;
}

const config = loadConfig(process.cwd(), arg("config")[0]);
const names = arg("cases").length ? arg("cases") : readdirSync(CASES_DIR);
const repeat = Number(arg("repeat")[0] ?? 1);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(import.meta.dirname, "..", "eval", "results", stamp);

const stage = arg("stage")[0] ?? "extract";
const common = { outDir, repeat, config, backend: (runDir: string) => PiBackend.create(config, runDir), log: (m: string) => console.error(m) };

if (stage === "clarify") {
  const cases = names.filter((name) => existsSync(join(CASES_DIR, name, "clarify", "answers.yaml"))).map((name) => ({ name, dir: join(CASES_DIR, name) }));
  if (!cases.length) throw new Error("No case has clarify/answers.yaml");
  const results = await runClarifyEval({ ...common, cases });
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(outDir, "report.md"), renderClarifyReport(results));
} else if (stage === "extract") {
  const results = await runEval({ ...common, cases: names.map((name) => ({ name, dir: join(CASES_DIR, name) })) });
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(outDir, "report.md"), renderReport(results));
} else {
  throw new Error(`Unknown --stage ${stage}; use extract or clarify`);
}
console.error(`\nReport: ${join(outDir, "report.md")}`);
