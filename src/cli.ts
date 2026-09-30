import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Command, Option } from "commander";
import { PiBackend } from "./agent/pi-backend.ts";
import { CLARIFY_LIMITS } from "./clarify/schema.ts";
import { runClarify } from "./clarify/stage.ts";
import { TtyAnswerer } from "./clarify/tty-answerer.ts";
import { findConfigPath, loadConfig, parseConfig, type XPlanConfig } from "./config.ts";
import { OUTPUT_LANGUAGES, type OutputLanguage } from "./shared/language.ts";
import { newRunId, readRunMeta, resolveRunDir, runsDir } from "./shared/runs.ts";
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
    const runDir = opts.out ? resolve(cwd, opts.out) : join(runsDir(cwd), newRunId("extract"));
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

program
  .command("clarify")
  .description("Stage 2: question the user about a Requirement Brief until the requirements are aligned")
  .argument("<run>", "an Extract Run to start a new Clarify Run from, or a Clarify Run to resume: an id under .x-plan/runs/ or a directory")
  .option("--out <dir>", "directory for a new Clarify Run (default: ./.x-plan/runs/<clarify-id>)")
  .option("--restart", "discard the Clarify Run's progress (02-state.json) and start it over")
  .option("--allow-failed-extract", "start from an Extract Run whose status is failed")
  .addOption(
    new Option("--lang <code>", "output language: en, zh, cn. Default: the language the Brief was written in").choices(OUTPUT_LANGUAGES),
  )
  .option("--max-rounds <n>", `rounds before the session closes (default ${CLARIFY_LIMITS.maxRounds})`, positiveInt)
  .option("--batch-size <n>", `questions per round (default ${CLARIFY_LIMITS.batchSize})`, positiveInt)
  .option("--config <path>", "config file (default: ./x-plan.config.json, then ~/.x-plan/)")
  .action(
    async (
      runArg: string,
      opts: { out?: string; restart?: boolean; allowFailedExtract?: boolean; lang?: OutputLanguage; maxRounds?: number; batchSize?: number; config?: string },
    ) => {
      const cwd = process.cwd();
      const given = resolveRunDir(cwd, runArg);
      const stage = readRunMeta(given)?.stage;
      let runDir: string;
      let sourceRunDir: string | undefined;
      if (stage === "extract") {
        runDir = opts.out ? resolve(cwd, opts.out) : join(runsDir(cwd), newRunId("clarify"));
        sourceRunDir = given;
      } else if (stage === "clarify") {
        if (opts.out) throw new Error("--out only applies when starting a new Clarify Run from an Extract Run");
        runDir = given;
      } else {
        throw new Error(`${given} is not an Extract or Clarify Run (no run.json with stage extract or clarify)`);
      }
      const config = loadConfig(cwd, opts.config);
      const log = (message: string) => console.error(`x-plan: ${message}`);
      log(`Run directory: ${runDir}`);

      const report = await runClarify({
        runDir,
        sourceRunDir,
        allowFailedExtract: opts.allowFailedExtract,
        config,
        outputLanguage: opts.lang,
        restart: opts.restart,
        maxRounds: opts.maxRounds,
        batchSize: opts.batchSize,
        answerer: new TtyAnswerer(),
        backend: () => PiBackend.create(config, runDir),
        log,
      });

      for (const w of report.warnings) log(`warning: ${w}`);
      for (const f of report.failures) log(`FAILED: ${f}`);
      if (report.status === "succeeded") log(`Aligned Brief: ${join(runDir, "02-aligned.md")} (${report.termination})`);
      else log(`Progress is saved; continue with: x-plan clarify ${dirname(runDir) === runsDir(cwd) ? basename(runDir) : runDir}`);
      log(`Status: ${report.status}`);
      if (report.status === "failed") process.exitCode = 1;
    },
  );

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Expected a positive integer, got ${value}`);
  return n;
}

function resolveConfig(cwd: string, explicit: string | undefined, dryRun: boolean): XPlanConfig {
  if (!explicit && !findConfigPath(cwd) && dryRun) {
    console.error("x-plan: no config found; dry run uses default context window and output reserve");
    return parseConfig({ provider: { baseUrl: "" } });
  }
  return loadConfig(cwd, explicit);
}

program.parseAsync().catch((error: unknown) => {
  console.error(`x-plan: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
