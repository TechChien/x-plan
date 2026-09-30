import { runSubmitTask, type SubmitTask, type TaskOutcome } from "../agent/submit-task.ts";
import { TraceRecorder } from "../agent/trace.ts";
import type { AgentBackend } from "../agent/types.ts";
import type { PromptLibrary } from "../prompts/template.ts";

/** Runs one submit task and records its trace under `<traceDir>/<label>.*`. */
export async function runTraced<P, R>(backend: AgentBackend, task: SubmitTask<P, R>, traceDir: string): Promise<TaskOutcome<R>> {
  const trace = new TraceRecorder(traceDir, task.label);
  const outcome = await runSubmitTask(backend, task, trace);
  trace.finish(outcome);
  return outcome;
}

/** Tool result sent back when a submission fails the semantic check. */
export function validationFeedback(lib: PromptLibrary, toolName: string, errors: string, count: number): string {
  return lib.render("shared/validation-errors", { toolName, count: String(count), errors }).trim();
}

/** Sent when the agent stops without calling its submit tool. */
export function buildNudge(lib: PromptLibrary, toolName: string): string {
  return lib.render("shared/nudge-submit", { toolName }).trim();
}
