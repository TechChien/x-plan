/**
 * Smoke test against the configured endpoint (LiteLLM → vLLM → gpt-oss). Checks the three things the Extract
 * design depends on: tool calling works, reasoning effort is accepted, reasoning content (CoT) comes back.
 *
 *   XPLAN_API_KEY=... pnpm smoke [--config path]
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { PiBackend } from "../src/agent/pi-backend.ts";
import { runSubmitTask } from "../src/agent/submit-task.ts";
import type { AgentEvent } from "../src/agent/types.ts";
import { loadConfig } from "../src/config.ts";

const configArg = process.argv.indexOf("--config");
const config = loadConfig(process.cwd(), configArg > 0 ? process.argv[configArg + 1] : undefined);
const backend = await PiBackend.create(config, mkdtempSync(join(tmpdir(), "xplan-smoke-")));

const events: AgentEvent[] = [];
const outcome = await runSubmitTask(
  backend,
  {
    label: "smoke",
    systemPrompt: "You answer arithmetic questions. Deliver the answer only by calling the `submit_answer` tool.",
    userMessage: "What is 17 * 23? Think it through, then call submit_answer.",
    nudge: "Call `submit_answer` now.",
    thinking: config.thinking ?? "medium",
    maxSubmitAttempts: 3,
    maxNudges: 1,
    tool: {
      name: "submit_answer",
      description: "Submit the numeric answer.",
      parameters: Type.Object({ answer: Type.Integer() }),
      check: ({ answer }: { answer: number }) => (answer === 391 ? { accept: answer } : { retry: `${answer} is wrong, recompute.` }),
    },
  },
  { onEvent: (e) => events.push(e), onRawEvent: () => {} },
);

const turns = events.filter((e): e is Extract<AgentEvent, { type: "assistant" }> => e.type === "assistant");
const checks = [
  ["model reachable", turns.length > 0 && !turns.some((t) => t.errorMessage), turns.find((t) => t.errorMessage)?.errorMessage],
  ["tool calling", turns.some((t) => t.toolCalls.length > 0), `${outcome.metrics.submitAttempts} submit call(s)`],
  ["tool arguments valid", outcome.status === "accepted", outcome.status === "failed" ? outcome.message : "answer 391"],
  ["reasoning content returned", turns.some((t) => t.thinking.length > 0), `${turns.reduce((n, t) => n + t.thinking.length, 0)} chars`],
  ["reasoning tokens reported", outcome.metrics.tokens.reasoning > 0, `${outcome.metrics.tokens.reasoning} tokens`],
] as const;

for (const [name, ok, detail] of checks) console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
const firstThinking = turns.find((t) => t.thinking)?.thinking;
if (firstThinking) console.log(`\nFirst reasoning excerpt:\n${firstThinking.slice(0, 300)}`);
process.exitCode = checks.slice(0, 3).every(([, ok]) => ok) ? 0 : 1;
