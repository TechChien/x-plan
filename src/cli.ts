import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command, Option } from "commander";
import { PiBackend } from "./agent/pi-backend.ts";
import { findConfigPath, loadConfig, parseConfig, type XPlanConfig } from "./config.ts";
import { OUTPUT_LANGUAGES, type OutputLanguage } from "./shared/language.ts";
import { runExtract } from "./extract/stage.ts";

const program = new Command();
program.name("x-plan").description("Turn requirement documents into BDD (Gherkin) specs");

program
  .command("extract")
  .description("Stage 1: extract a Requirement Brief from every document in <dir>")
  .argument("<dir>", "directory of Source Documents (.md .txt .pdf .docx)")
  .option("--include <globs...>", "only scan files matching these globs")
  .option("--exclude <globs...>", "skip files matching these globs")
  .option(
    "--reference <globs...>",
    "also mark matching files as Reference Documents (schemas, API manuals): extracted only where the requirements need them. Files under <dir>/references/ always are",
  )
  .addOption(
    new Option("--lang <code>", "output language: en (English), zh (Traditional Chinese), cn (Simplified Chinese). Overrides config outputLanguage; default en").choices(
      OUTPUT_LANGUAGES,
    ),
  )
  .option("--out <dir>", "run directory (default: ./.x-plan/runs/<run-id>)")
  .option("--config <path>", "config file (default: ./x-plan.config.json, then ~/.x-plan/)")
  .option("--dry-run", "scan, convert, pack and render prompts without calling the model")
  .action(async (dirArg: string, opts: { include?: string[]; exclude?: string[]; reference?: string[]; lang?: OutputLanguage; out?: string; config?: string; dryRun?: boolean }) => {
    const cwd = process.cwd();
    const dir = resolve(cwd, dirArg);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Not a directory: ${dir}`);

    const config = resolveConfig(cwd, opts.config, Boolean(opts.dryRun));
    const runDir = opts.out ? resolve(cwd, opts.out) : join(cwd, ".x-plan", "runs", newRunId());
    const log = (message: string) => console.error(`x-plan: ${message}`);
    log(`Run directory: ${runDir}`);

    const report = await runExtract({
      dir,
      runDir,
      config,
      include: opts.include,
      exclude: opts.exclude,
      reference: opts.reference,
      outputLanguage: opts.lang,
      dryRun: opts.dryRun,
      backend: () => PiBackend.create(config, runDir),
      log,
    });

    for (const w of report.warnings) log(`warning: ${w}`);
    for (const f of report.failures) log(`FAILED: ${f}`);
    if (report.brief) {
      log(`Brief: ${join(runDir, "01-brief.md")} (${report.rejected.length} rejected item(s))`);
    }
    log(`Status: ${report.status}`);
    if (report.status === "failed") process.exitCode = 1;
  });

function resolveConfig(cwd: string, explicit: string | undefined, dryRun: boolean): XPlanConfig {
  if (!explicit && !findConfigPath(cwd) && dryRun) {
    console.error("x-plan: no config found; dry run uses default context window and output reserve");
    return parseConfig({ provider: { baseUrl: "" } });
  }
  return loadConfig(cwd, explicit);
}

/** e.g. 20260929-1530-a1b2c3 */
export function newRunId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

program.parseAsync().catch((error: unknown) => {
  console.error(`x-plan: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
