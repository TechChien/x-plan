import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Command, Option } from "commander";
import { PiBackend } from "./agent/pi-backend.ts";
import { CLARIFY_LIMITS } from "./clarify/schema.ts";
import { runClarify } from "./clarify/stage.ts";
import { TtyAnswerer } from "./clarify/tty-answerer.ts";
import { CONFIG_FILE_NAME, findConfigPath, loadConfig, parseConfig, type XPlanConfig } from "./config.ts";
import { OUTPUT_LANGUAGES, type OutputLanguage } from "./shared/language.ts";
import { newRunId, readRunMeta, resolveRunDir, runsDir } from "./shared/runs.ts";
import { runExtract } from "./extract/stage.ts";
import { runWrite } from "./write/stage.ts";
import { startTelemetry } from "./telemetry/setup.ts";
import { feedbackAction, formatFeedback, recordFeedback, resolveAuthor, type FeedbackOptions } from "./feedback/feedback.ts";
import { MAX_SCORE, MIN_SCORE } from "./feedback/schema.ts";
import { readFeedback, standing } from "./feedback/store.ts";
import { LangfuseScores, readSyncState, syncFeedback, syncStatus, type SyncReport } from "./feedback/sync.ts";
import { langfuseCredentials } from "./shared/langfuse.ts";

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

    const report = await withTelemetry(config, log, () => runExtract({
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
    }));

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

      const report = await withTelemetry(config, log, () => runClarify({
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
      }));

      for (const w of report.warnings) log(`warning: ${w}`);
      for (const f of report.failures) log(`FAILED: ${f}`);
      if (report.status === "succeeded") log(`Aligned Brief: ${join(runDir, "02-aligned.md")} (${report.termination})`);
      else log(`Progress is saved; continue with: x-plan clarify ${dirname(runDir) === runsDir(cwd) ? basename(runDir) : runDir}`);
      log(`Status: ${report.status}`);
      if (report.status === "failed") process.exitCode = 1;
    },
  );

program
  .command("write")
  .description("Stage 3: write the Gherkin requirements from a Clarify Run's Aligned Brief")
  .argument("<run>", "a Clarify Run to write from, or with --only a Write Run to rewrite Features in: an id under .x-plan/runs/ or a directory")
  .option("--only <ids...>", "rewrite these Features of an existing Write Run, keeping its outline and scenario ids")
  .option("--out <dir>", "directory for a new Write Run (default: ./.x-plan/runs/<write-id>)")
  .option("--allow-failed-clarify", "start from a Clarify Run whose status is failed")
  .addOption(new Option("--lang <code>", "output language: en, zh, cn. Default: the language of the Aligned Brief").choices(OUTPUT_LANGUAGES))
  .option("--config <path>", "config file (default: ./x-plan.config.json, then ~/.x-plan/)")
  .action(async (runArg: string, opts: { only?: string[]; out?: string; allowFailedClarify?: boolean; lang?: OutputLanguage; config?: string }) => {
    const cwd = process.cwd();
    const given = resolveRunDir(cwd, runArg);
    const stage = readRunMeta(given)?.stage;
    let runDir: string;
    let sourceRunDir: string | undefined;
    if (stage === "clarify") {
      if (opts.only) throw new Error("--only rewrites Features of a Write Run; give the Write Run, not the Clarify Run");
      runDir = opts.out ? resolve(cwd, opts.out) : join(runsDir(cwd), newRunId("write"));
      sourceRunDir = given;
    } else if (stage === "write") {
      if (!opts.only) throw new Error(`${basename(given)} is a Write Run: give --only <FEAT-id...> to rewrite Features in it, or the Clarify Run to write a new one`);
      if (opts.out || opts.lang) throw new Error("--out and --lang only apply to a new Write Run");
      runDir = given;
    } else {
      throw new Error(`${given} is not a Clarify or Write Run (no run.json with stage clarify or write)`);
    }
    const config = loadConfig(cwd, opts.config);
    const log = (message: string) => console.error(`x-plan: ${message}`);
    log(`Run directory: ${runDir}`);

    const report = await withTelemetry(config, log, () => runWrite({
      runDir,
      sourceRunDir,
      only: opts.only,
      allowFailedClarify: opts.allowFailedClarify,
      config,
      outputLanguage: opts.lang,
      backend: () => PiBackend.create(config, runDir),
      log,
    }));

    for (const w of report.warnings) log(`warning: ${w}`);
    for (const f of report.failures) log(`FAILED: ${f}`);
    if (existsSync(join(runDir, "03-spec.md"))) log(`Gherkin: ${join(runDir, "features")}; overview: ${join(runDir, "03-spec.md")}`);
    const failedFeatures = report.unwritten.filter((id) => id.startsWith("FEAT-"));
    if (failedFeatures.length) log(`Rewrite with: x-plan write ${dirname(runDir) === runsDir(cwd) ? basename(runDir) : runDir} --only ${failedFeatures.join(" ")}`);
    log(`Status: ${report.status}`);
    if (report.status === "failed") process.exitCode = 1;
  });

program
  .command("feedback")
  .description("Record Feedback on a Run's output: a verdict on a Brief item or a scenario, something missing, or an overall score")
  .argument("<run>", "the Run the Feedback is about: an id under .x-plan/runs/ or a directory")
  .argument("[item]", "a Brief item id, e.g. ACT-3 or OQ-5; for a Write Run, a scenario id, e.g. SCN-3")
  .option("--ok", "the item is right")
  .option("--wrong <note>", "the item is wrong (for OQ: asks the wrong thing; CTR: not a real conflict; ASM: unreasonable)")
  .option("--partial <note>", "the item is partly wrong (facts and scenarios only)")
  .option("--redundant <note>", "the open question is already answered by the documents (OQ only)")
  .option("--note <text>", "a note for --ok, --score or --retract")
  .option("--missing <fact>", "a fact the Run should have produced and did not")
  .option("--at <where>", "with --missing: where the Source Document says it, e.g. prd.md:57; for a Write Run, the Feature the missing scenario belongs to, e.g. FEAT-2")
  .option("--score <n>", `overall score of the Run, ${MIN_SCORE}-${MAX_SCORE}`, Number)
  .option("--retract <id>", "withdraw an earlier Feedback, e.g. FB-3")
  .option("--list", "show the Feedback that stands")
  .option("--sync", "send Feedback not yet sent to Langfuse, and remove what was superseded or retracted")
  .option("--config <path>", "config file (default: ./x-plan.config.json, then ~/.x-plan/)")
  .action(async (runArg: string, item: string | undefined, opts: FeedbackOptions & { config?: string }) => {
    const cwd = process.cwd();
    const runDir = resolveRunDir(cwd, runArg);
    const log = (message: string) => console.error(`x-plan: ${message}`);
    const what = feedbackAction(item, opts);
    if (what.action === "list") {
      const entries = readFeedback(runDir);
      const state = readSyncState(runDir);
      const lines = formatFeedback(entries, (id) => syncStatus(standing(entries).find((e) => e.id === id)!, state));
      console.log(lines.length ? lines.join("\n") : "No Feedback yet.");
      return;
    }

    const configPath = opts.config ? resolve(cwd, opts.config) : findConfigPath(cwd);
    const config = configPath ? loadConfig(cwd, configPath) : undefined;
    if (what.action === "sync") {
      const creds = config && langfuseCredentials(config);
      if (!creds) throw new Error(`--sync needs a langfuse block in ${configPath ?? CONFIG_FILE_NAME}`);
      reportSync(await syncFeedback(runDir, new LangfuseScores(creds)), log);
      return;
    }

    const recorded = recordFeedback(runDir, what.request, { author: resolveAuthor(), now: new Date() });
    for (const w of recorded.warnings) log(`warning: ${w}`);
    log(`Recorded ${recorded.entry.id}${recorded.replaces ? `, replacing ${recorded.replaces}` : ""}${recorded.entry.type === "retract" ? `, withdrawing ${recorded.entry.retracts}` : ""}`);
    if (!config?.langfuse) return;
    // Mirroring is best effort: the Feedback is already saved, and --sync retries.
    try {
      const creds = langfuseCredentials(config)!;
      const report = await syncFeedback(runDir, new LangfuseScores(creds));
      reportSync({ ...report, untraced: report.untraced.filter((id) => id === recorded.entry.id) }, log);
    } catch (error) {
      log(`warning: not sent to Langfuse (${error instanceof Error ? error.message : String(error)}); run --sync later`);
    }
  });

function reportSync(report: SyncReport, log: (message: string) => void): void {
  const done = [report.created.length && `sent ${report.created.join(", ")}`, report.deleted.length && `removed ${report.deleted.join(", ")}`].filter(Boolean);
  if (done.length) log(`Langfuse: ${done.join("; ")}`);
  if (report.untraced.length) log(`Langfuse: ${report.untraced.join(", ")} stay local: the Run was not traced`);
  if (report.error) log(`warning: Langfuse sync stopped (${report.error}); run --sync to retry`);
}

/** Traces `fn` when telemetry is on (ADR 0013); spans are flushed before the command returns. */
async function withTelemetry<T>(config: XPlanConfig, log: (message: string) => void, fn: () => Promise<T>): Promise<T> {
  const telemetry = await startTelemetry(config, { log, handleSignals: true });
  try {
    return await fn();
  } finally {
    await telemetry.shutdown();
  }
}

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
