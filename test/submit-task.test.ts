import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { runSubmitTask, type SubmitTask } from "../src/agent/submit-task.ts";
import type { AgentEvent } from "../src/agent/types.ts";
import { ScriptedBackend, type ScriptedTurn } from "./helpers/scripted-backend.ts";

const params = Type.Object({ answer: Type.Integer() });

/** Accepts 42; asks for a retry otherwise, unless it is the last attempt (then accepts anything). */
function task(overrides: Partial<SubmitTask<{ answer: number }, number>> = {}): SubmitTask<{ answer: number }, number> {
  return {
    label: "t",
    systemPrompt: "sys",
    userMessage: "go",
    nudge: "call submit",
    thinking: "medium",
    maxSubmitAttempts: 3,
    maxNudges: 2,
    tool: {
      name: "submit",
      description: "d",
      parameters: params,
      check: ({ answer }, { isLast }) => (answer === 42 || isLast ? { accept: answer } : { retry: `wrong: ${answer}` }),
    },
    ...overrides,
  };
}

async function run(turns: ScriptedTurn[], t = task()) {
  const backend = new ScriptedBackend([turns]);
  const events: AgentEvent[] = [];
  const outcome = await runSubmitTask(backend, t, { onEvent: (e) => events.push(e), onRawEvent: () => {} });
  return { outcome, events, prompts: backend.sessions[0]!.prompts };
}

describe("runSubmitTask", () => {
  test("accepts a valid first submission", async () => {
    const { outcome } = await run([{ call: { answer: 42 } }]);
    expect(outcome).toMatchObject({ status: "accepted", value: 42, metrics: { submitAttempts: 1, nudges: 0 } });
  });

  test("L1: nudges when the agent answers in plain text", async () => {
    const { outcome, prompts } = await run([{ text: "here you go" }, { call: { answer: 42 } }]);
    expect(outcome).toMatchObject({ status: "accepted", metrics: { nudges: 1 } });
    expect(prompts).toEqual(["go", "call submit"]);
  });

  test("L1: gives up after maxNudges", async () => {
    const { outcome } = await run([{ text: "a" }, { text: "b" }, { text: "c" }, { call: { answer: 42 } }]);
    expect(outcome).toMatchObject({ status: "failed", reason: "no-submit", metrics: { nudges: 2 } });
  });

  test("L2: schema errors are retried in the same session", async () => {
    const { outcome } = await run([{ call: { answer: "x" } }, { call: { answer: 42 } }]);
    expect(outcome).toMatchObject({ status: "accepted", metrics: { submitAttempts: 2, schemaFailures: 1, checkFailures: 0 } });
  });

  test("an array with a default may be left out, and check receives it filled in", async () => {
    const withList = Type.Object({ answer: Type.Integer(), notes: Type.Array(Type.String(), { default: [] }), tags: Type.Array(Type.String()) });
    const seen: unknown[] = [];
    const t = { ...task(), tool: { ...task().tool, parameters: withList, check: (p: unknown) => (seen.push(p), { accept: 42 }) } } as SubmitTask<{ answer: number }, number>;
    const { outcome } = await run([{ call: { answer: 42 } }, { call: { answer: 42, tags: [] } }], t);
    expect(outcome).toMatchObject({ status: "accepted", metrics: { submitAttempts: 2, schemaFailures: 1 } });
    expect(seen).toEqual([{ answer: 42, notes: [], tags: [] }]);
  });

  test("L3: check errors are fed back and retried", async () => {
    const { outcome, events } = await run([{ call: { answer: 1 } }, { call: { answer: 42 } }]);
    expect(outcome).toMatchObject({ status: "accepted", value: 42, metrics: { submitAttempts: 2, checkFailures: 1 } });
    expect(events).toContainEqual({ type: "tool_result", name: "submit", isError: true, text: "wrong: 1" });
  });

  test("L3: the last attempt is told isLast so it can accept partially", async () => {
    const { outcome } = await run([{ call: { answer: 1 } }, { call: { answer: 2 } }, { call: { answer: 3 } }]);
    expect(outcome).toMatchObject({ status: "accepted", value: 3, metrics: { submitAttempts: 3, checkFailures: 2 } });
  });

  test("L2 and L3 share the attempt budget; exhausting it fails the task", async () => {
    const { outcome } = await run([{ call: { answer: 1 } }, { call: { answer: "x" } }, { call: { answer: "y" } }, { call: { answer: 42 } }]);
    expect(outcome).toMatchObject({ status: "failed", reason: "attempts-exhausted", metrics: { submitAttempts: 3, schemaFailures: 2 } });
  });

  test("sums token usage across turns", async () => {
    const { outcome } = await run([{ call: { answer: 1 } }, { call: { answer: 42 } }]);
    expect(outcome.metrics.tokens).toEqual({ input: 200, output: 100, reasoning: 20, cacheRead: 0 });
  });
});
