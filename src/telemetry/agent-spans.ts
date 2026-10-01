import type { Attributes, Span } from "@opentelemetry/api";
import type { SubmitTask, TaskObserver, TaskOutcome } from "../agent/submit-task.ts";
import type { AgentEvent } from "../agent/types.ts";
import { captureContent, endSpan, failSpan, startSpan, withSpan } from "./spans.ts";

/** x-plan speaks the OpenAI chat-completions protocol, whatever serves it behind the proxy. */
const PROVIDER = "openai";

/** Attributes of the `invoke_agent <label>` span of one submit task (OTel GenAI semantic conventions). */
export function agentAttributes(task: SubmitTask<unknown, unknown>): Attributes {
  return {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": task.label,
    "gen_ai.provider.name": PROVIDER,
    "langfuse.observation.type": "agent",
    "xplan.thinking": task.thinking,
    "xplan.tool": task.tool.name,
    "xplan.max_submit_attempts": task.maxSubmitAttempts,
    ...(captureContent()
      ? {
          "gen_ai.system_instructions": JSON.stringify([{ type: "text", content: task.systemPrompt }]),
          "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content: task.userMessage }] }]),
        }
      : {}),
  };
}

/**
 * Turns one session's events into child spans of its `invoke_agent` span: a `chat <model>` span per model
 * response and an `execute_tool <name>` span per tool call. Mirrors what TraceRecorder writes to `traces/`.
 */
export class AgentSpanRecorder implements TaskObserver {
  private tool?: Span;

  constructor(
    private readonly agent: Span,
    private readonly model = "unknown",
  ) {}

  onRawEvent(): void {}

  onEvent(event: AgentEvent): void {
    const content = captureContent();
    switch (event.type) {
      case "assistant": {
        const end = Date.now();
        const chat = startSpan(
          `chat ${this.model}`,
          {
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": PROVIDER,
            "gen_ai.request.model": this.model,
            "langfuse.observation.type": "generation",
            "gen_ai.usage.input_tokens": event.usage.input,
            "gen_ai.usage.output_tokens": event.usage.output,
            "gen_ai.usage.reasoning.output_tokens": event.usage.reasoning,
            "gen_ai.usage.cache_read.input_tokens": event.usage.cacheRead,
            "gen_ai.response.finish_reasons": [event.stopReason],
            "xplan.tool_calls": event.toolCalls.map((c) => c.name),
            ...(content ? { "gen_ai.output.messages": JSON.stringify([outputMessage(event)]) } : {}),
          },
          { parent: this.agent, startTime: end - event.durationMs },
        );
        if (event.errorMessage) failSpan(chat, event.errorMessage);
        endSpan(chat, end);
        break;
      }
      case "tool_start":
        if (this.tool) endSpan(this.tool);
        this.tool = startSpan(
          `execute_tool ${event.name}`,
          {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": event.name,
            "langfuse.observation.type": "tool",
            ...(content ? { "gen_ai.tool.call.arguments": JSON.stringify(event.args) } : {}),
          },
          { parent: this.agent },
        );
        break;
      case "tool_result":
        if (!this.tool) break;
        if (content) this.tool.setAttribute("gen_ai.tool.call.result", event.text);
        // The text of a rejection quotes the submission, so it is content too.
        if (event.isError) failSpan(this.tool, content ? event.text : "submission rejected");
        endSpan(this.tool);
        this.tool = undefined;
        break;
      case "prompt":
        if (event.kind === "nudge") this.agent.addEvent("xplan.nudge", content ? { text: event.text } : {});
        break;
      case "note":
        this.agent.addEvent("xplan.note", content ? { text: event.text } : {});
        break;
    }
  }

  withinTool<T>(fn: () => Promise<T>): Promise<T> {
    return this.tool ? withSpan(this.tool, fn) : fn();
  }

  finish(outcome: TaskOutcome<unknown>): void {
    if (this.tool) endSpan(this.tool);
    const m = outcome.metrics;
    // Totals are x-plan attributes: gen_ai.usage.* here would count every chat span's tokens twice.
    this.agent.setAttributes({
      "xplan.outcome": outcome.status,
      "xplan.submit_attempts": m.submitAttempts,
      "xplan.schema_failures": m.schemaFailures,
      "xplan.check_failures": m.checkFailures,
      "xplan.nudges": m.nudges,
      "xplan.turns": m.turns,
      "xplan.usage.input_tokens": m.tokens.input,
      "xplan.usage.output_tokens": m.tokens.output,
      "xplan.usage.reasoning_tokens": m.tokens.reasoning,
      "xplan.usage.cache_read_tokens": m.tokens.cacheRead,
    });
    if (outcome.status === "failed") {
      this.agent.setAttribute("xplan.failure", outcome.reason);
      failSpan(this.agent, `${outcome.reason}: ${outcome.message}`);
    }
  }
}

function outputMessage(event: Extract<AgentEvent, { type: "assistant" }>) {
  return {
    role: "assistant",
    parts: [
      ...(event.thinking ? [{ type: "reasoning", content: event.thinking }] : []),
      ...(event.text ? [{ type: "text", content: event.text }] : []),
      ...event.toolCalls.map((c) => ({ type: "tool_call", name: c.name, arguments: c.args })),
    ],
    finish_reason: event.stopReason,
  };
}
