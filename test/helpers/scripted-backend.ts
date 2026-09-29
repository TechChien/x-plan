import { Value } from "typebox/value";
import type { AgentBackend, AgentSession, SessionOptions } from "../../src/agent/types.ts";

/** One assistant turn: plain text (the agent stops) or a call of the session's tool. */
export type ScriptedTurn = { text: string } | { call: unknown };

/**
 * Stands in for PI: replays scripted assistant turns, validates tool arguments against the tool schema before
 * `execute` (as PI does), and keeps looping after tool results until the tool terminates or the script ends.
 */
export class ScriptedBackend implements AgentBackend {
  readonly sessions: { systemPrompt: string; prompts: string[] }[] = [];

  /** `scripts[i]` drives the i-th session created; a function picks the script from the system prompt instead. */
  constructor(private readonly scripts: ScriptedTurn[][] | ((options: SessionOptions) => ScriptedTurn[])) {}

  async createSession(options: SessionOptions): Promise<AgentSession> {
    const index = this.sessions.length;
    const record = { systemPrompt: options.systemPrompt, prompts: [] as string[] };
    this.sessions.push(record);
    const turns = [...(typeof this.scripts === "function" ? this.scripts(options) : (this.scripts[index] ?? []))];
    let aborted = false;
    const usage = { input: 100, output: 50, reasoning: 10, cacheRead: 0 };

    return {
      prompt: async (text) => {
        record.prompts.push(text);
        while (!aborted) {
          const turn = turns.shift();
          if (!turn) return;
          if ("text" in turn) {
            options.onEvent({ type: "assistant", thinking: "thinking…", text: turn.text, toolCalls: [], usage, stopReason: "stop", durationMs: 1 });
            return;
          }
          options.onEvent({
            type: "assistant",
            thinking: "thinking…",
            text: "",
            toolCalls: [{ name: options.tool.name, args: turn.call }],
            usage,
            stopReason: "toolUse",
            durationMs: 1,
          });
          options.onEvent({ type: "tool_start", name: options.tool.name, args: turn.call });
          if (!Value.Check(options.tool.parameters, turn.call)) {
            options.onEvent({ type: "tool_result", name: options.tool.name, isError: true, text: "Validation failed for tool arguments" });
            continue;
          }
          const reply = options.tool.execute(turn.call);
          options.onEvent({ type: "tool_result", name: options.tool.name, isError: reply.isError, text: reply.text });
          if (reply.terminate) return;
        }
      },
      abort: async () => {
        aborted = true;
      },
      dispose: () => {},
    };
  }
}
