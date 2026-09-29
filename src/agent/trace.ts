import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskObserver, TaskOutcome } from "./submit-task.ts";
import type { AgentEvent } from "./types.ts";

/**
 * Records one agent session under `<dir>/<label>.jsonl` (every backend event plus x-plan's own events, as they
 * happen) and, when finished, `<dir>/<label>.md` (a readable timeline). Recording is always on: a failure
 * of a non-deterministic model may never reproduce.
 */
export class TraceRecorder implements TaskObserver {
  private readonly events: AgentEvent[] = [];
  private readonly jsonlPath: string;

  constructor(
    private readonly dir: string,
    private readonly label: string,
  ) {
    mkdirSync(dir, { recursive: true });
    this.jsonlPath = join(dir, `${label}.jsonl`);
    writeFileSync(this.jsonlPath, "");
  }

  onRawEvent(event: unknown): void {
    this.append({ source: "pi", event });
  }

  onEvent(event: AgentEvent): void {
    this.events.push(event);
    if (event.type === "prompt" || event.type === "note") this.append({ source: "x-plan", event });
  }

  finish(outcome: TaskOutcome<unknown>): void {
    this.append({ source: "x-plan", event: { type: "outcome", status: outcome.status, metrics: outcome.metrics, ...("reason" in outcome ? { reason: outcome.reason, message: outcome.message } : {}) } });
    writeFileSync(join(this.dir, `${this.label}.md`), renderTimeline(this.label, this.events, outcome));
  }

  private append(record: object): void {
    appendFileSync(this.jsonlPath, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  }
}

export function renderTimeline(label: string, events: AgentEvent[], outcome: TaskOutcome<unknown>): string {
  const m = outcome.metrics;
  const out: string[] = [
    `# ${label}`,
    "",
    `**Outcome:** ${outcome.status === "accepted" ? "✓ accepted" : `✗ ${outcome.reason}: ${outcome.message}`}`,
    `**Attempts:** ${m.submitAttempts} submit (${m.schemaFailures} schema errors, ${m.checkFailures} check errors), ${m.nudges} nudges, ${m.turns} turns`,
    `**Tokens:** in ${m.tokens.input} / out ${m.tokens.output} (reasoning ${m.tokens.reasoning}) / cache read ${m.tokens.cacheRead} — ${(m.durationMs / 1000).toFixed(1)}s`,
    "",
  ];
  let turn = 0;
  for (const e of events) {
    switch (e.type) {
      case "prompt":
        out.push(e.kind === "initial" ? `## Prompt\nInitial user message (${e.text.length} chars), see \`prompts/${label}.user.md\`.\n` : `## Nudge\n> ${e.text.split("\n").join("\n> ")}\n`);
        break;
      case "assistant":
        turn++;
        out.push(`## Turn ${turn}  (in ${e.usage.input} / out ${e.usage.output} tok, ${(e.durationMs / 1000).toFixed(1)}s, stop: ${e.stopReason})`);
        if (e.errorMessage) out.push(`**Error:** ${e.errorMessage}`);
        if (e.thinking) out.push(`<details><summary>Thinking (${e.thinking.length} chars)</summary>\n\n${e.thinking}\n\n</details>`);
        else out.push(`_No thinking content received._`);
        if (e.text) out.push(`**Text reply:**\n\n${e.text}`);
        for (const call of e.toolCalls) out.push(`→ \`${call.name}\`(${summarizeArgs(call.args)})`);
        out.push("");
        break;
      case "tool_result":
        out.push(e.isError ? `✗ **${e.name} rejected:**\n\n\`\`\`\n${e.text}\n\`\`\`\n` : `✓ ${e.name}: ${e.text}\n`);
        break;
      case "note":
        out.push(`> _${e.text.split("\n").join("\n> ")}_\n`);
        break;
      case "tool_start":
        break;
    }
  }
  return `${out.join("\n")}\n`;
}

/** `{ actors: [..3], features: [..5] }` → `actors: 3, features: 5` */
function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return JSON.stringify(args);
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => (Array.isArray(v) ? `${k}: ${v.length}` : `${k}: ${JSON.stringify(v)}`))
    .join(", ");
}
