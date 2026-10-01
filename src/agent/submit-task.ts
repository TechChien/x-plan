import type { TSchema } from "typebox";
import type { ThinkingLevel } from "../config.ts";
import type { AgentBackend, AgentEvent, TokenUsage } from "./types.ts";

export type CheckVerdict<R> = { accept: R } | { retry: string };

/** A tool through which the agent hands in its result. `check` performs the L3 (semantic) validation. */
export interface SubmitTool<P, R> {
  name: string;
  description: string;
  parameters: TSchema;
  /**
   * `attempt` counts submit calls so far including this one (1-based). When `isLast` is true no retry is
   * left, so `check` should accept whatever part of the submission is usable. It may be async, e.g. when the
   * check itself asks another agent.
   */
  check(params: P, ctx: { attempt: number; isLast: boolean }): CheckVerdict<R> | Promise<CheckVerdict<R>>;
}

export interface SubmitTask<P, R> {
  label: string;
  systemPrompt: string;
  userMessage: string;
  /** Sent when the agent stops without calling the tool (L1). */
  nudge: string;
  tool: SubmitTool<P, R>;
  thinking: ThinkingLevel;
  /** Total submit calls allowed: 1 + retries (L2 schema and L3 check failures share this budget). */
  maxSubmitAttempts: number;
  maxNudges: number;
}

export interface TaskMetrics {
  submitAttempts: number;
  schemaFailures: number;
  checkFailures: number;
  nudges: number;
  turns: number;
  tokens: TokenUsage;
  durationMs: number;
}

export type TaskOutcome<R> =
  | { status: "accepted"; value: R; metrics: TaskMetrics }
  | { status: "failed"; reason: "no-submit" | "attempts-exhausted" | "error"; message: string; metrics: TaskMetrics };

export interface TaskObserver {
  onEvent(event: AgentEvent): void;
  onRawEvent(event: unknown): void;
}

/**
 * Runs one agent until it hands in an accepted result through its submit tool.
 * L1: stops without calling the tool → nudge, up to `maxNudges`.
 * L2: arguments fail the schema (rejected by the backend before `check`) → the model sees the error and retries.
 * L3: `check` returns `retry` → the model sees the errors and retries.
 * L2 and L3 share `maxSubmitAttempts`; when it is used up the session is aborted.
 */
export async function runSubmitTask<P, R>(backend: AgentBackend, task: SubmitTask<P, R>, observer: TaskObserver): Promise<TaskOutcome<R>> {
  const started = Date.now();
  const metrics: TaskMetrics = {
    submitAttempts: 0,
    schemaFailures: 0,
    checkFailures: 0,
    nudges: 0,
    turns: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
    durationMs: 0,
  };
  let accepted: { value: R } | undefined;
  let executedThisAttempt = false;
  let exhausted = false;
  let backendError: string | undefined;
  let session: Awaited<ReturnType<AgentBackend["createSession"]>> | undefined;

  const emit = (event: AgentEvent) => {
    observer.onEvent(event);
    if (event.type === "assistant") {
      metrics.turns++;
      metrics.tokens.input += event.usage.input;
      metrics.tokens.output += event.usage.output;
      metrics.tokens.reasoning += event.usage.reasoning;
      metrics.tokens.cacheRead += event.usage.cacheRead;
      if (event.errorMessage) backendError = event.errorMessage;
    }
    if (event.type === "tool_start" && event.name === task.tool.name && !accepted) {
      metrics.submitAttempts++;
      executedThisAttempt = false;
    }
    if (event.type === "tool_result" && event.name === task.tool.name && !accepted && event.isError) {
      if (!executedThisAttempt) metrics.schemaFailures++;
      if (metrics.submitAttempts >= task.maxSubmitAttempts) {
        exhausted = true;
        observer.onEvent({ type: "note", text: `Submit attempts exhausted (${metrics.submitAttempts}); aborting.` });
        void session?.abort();
      }
    }
  };

  const finish = (): TaskOutcome<R> => {
    metrics.durationMs = Date.now() - started;
    if (accepted) return { status: "accepted", value: accepted.value, metrics };
    if (exhausted) return { status: "failed", reason: "attempts-exhausted", message: `No valid ${task.tool.name} after ${metrics.submitAttempts} attempts`, metrics };
    if (backendError) return { status: "failed", reason: "error", message: backendError, metrics };
    return { status: "failed", reason: "no-submit", message: `Agent never called ${task.tool.name} (after ${metrics.nudges} nudges)`, metrics };
  };

  try {
    session = await backend.createSession({
      systemPrompt: task.systemPrompt,
      thinking: task.thinking,
      onEvent: emit,
      onRawEvent: (e) => observer.onRawEvent(e),
      tool: {
        name: task.tool.name,
        description: task.tool.description,
        parameters: task.tool.parameters,
        execute: async (params) => {
          executedThisAttempt = true;
          if (accepted) return { text: "Already accepted. Stop now.", terminate: true, isError: false };
          const verdict = await task.tool.check(params as P, {
            attempt: metrics.submitAttempts,
            isLast: metrics.submitAttempts >= task.maxSubmitAttempts,
          });
          if ("accept" in verdict) {
            accepted = { value: verdict.accept };
            return { text: "Accepted.", terminate: true, isError: false };
          }
          metrics.checkFailures++;
          return { text: verdict.retry, terminate: false, isError: true };
        },
      },
    });

    emit({ type: "prompt", kind: "initial", text: task.userMessage });
    await session.prompt(task.userMessage);
    while (!accepted && !exhausted && !backendError && metrics.nudges < task.maxNudges) {
      metrics.nudges++;
      emit({ type: "prompt", kind: "nudge", text: task.nudge });
      await session.prompt(task.nudge);
    }
  } catch (error) {
    if (!accepted && !exhausted) backendError = error instanceof Error ? error.message : String(error);
  } finally {
    session?.dispose();
  }
  return finish();
}
