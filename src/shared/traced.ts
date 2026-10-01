import { runSubmitTask, type SubmitTask, type TaskOutcome } from "../agent/submit-task.ts";
import { TraceRecorder } from "../agent/trace.ts";
import type { AgentBackend } from "../agent/types.ts";
import type { PromptLibrary } from "../prompts/template.ts";
import { agentAttributes, AgentSpanRecorder } from "../telemetry/agent-spans.ts";
import { inSpan } from "../telemetry/spans.ts";

/**
 * Runs one submit task and records its trace under `<traceDir>/<label>.*`, and, when telemetry is on, as an
 * `invoke_agent <label>` span (ADR 0013).
 */
export async function runTraced<P, R>(backend: AgentBackend, task: SubmitTask<P, R>, traceDir: string): Promise<TaskOutcome<R>> {
  return inSpan(`invoke_agent ${task.label}`, agentAttributes(task as SubmitTask<unknown, unknown>), async (span) => {
    const trace = new TraceRecorder(traceDir, task.label);
    const spans = new AgentSpanRecorder(span, backend.model);
    const outcome = await runSubmitTask(backend, task, {
      onEvent: (event) => {
        trace.onEvent(event);
        spans.onEvent(event);
      },
      onRawEvent: (event) => trace.onRawEvent(event),
      withinTool: (fn) => spans.withinTool(fn),
    });
    trace.finish(outcome);
    spans.finish(outcome);
    return outcome;
  });
}

/** Tool result sent back when a submission fails the semantic check. */
export function validationFeedback(lib: PromptLibrary, toolName: string, errors: string, count: number): string {
  return lib.render("shared/validation-errors", { toolName, count: String(count), errors }).trim();
}

/** Sent when the agent stops without calling its submit tool. */
export function buildNudge(lib: PromptLibrary, toolName: string): string {
  return lib.render("shared/nudge-submit", { toolName }).trim();
}
