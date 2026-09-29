import type { TSchema } from "typebox";
import type { ThinkingLevel } from "../config.ts";

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
}

/** Backend-neutral view of what happened in a session; drives both retry logic and the readable trace. */
export type AgentEvent =
  | { type: "prompt"; text: string; kind: "initial" | "nudge" }
  | {
      type: "assistant";
      thinking: string;
      text: string;
      toolCalls: { name: string; args: unknown }[];
      usage: TokenUsage;
      stopReason: string;
      errorMessage?: string;
      durationMs: number;
    }
  | { type: "tool_start"; name: string; args: unknown }
  | { type: "tool_result"; name: string; isError: boolean; text: string }
  | { type: "note"; text: string };

export interface ToolReply {
  text: string;
  /** true ends the agent run after this tool call (the submission was accepted). */
  terminate: boolean;
  /** true reports the reply to the model as an error result. */
  isError: boolean;
}

export interface SessionTool {
  name: string;
  description: string;
  parameters: TSchema;
  /** Called only when the arguments already passed schema validation. */
  execute(params: unknown): ToolReply;
}

export interface SessionOptions {
  systemPrompt: string;
  tool: SessionTool;
  thinking: ThinkingLevel;
  /** Normalized events. */
  onEvent(event: AgentEvent): void;
  /** Raw backend events, for the machine-readable trace. */
  onRawEvent(event: unknown): void;
}

export interface AgentSession {
  /** Sends a user message and resolves when the agent stops on its own or is aborted. */
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

/** Creates agent sessions. The PI SDK implements it in production; tests supply a scripted fake. */
export interface AgentBackend {
  createSession(options: SessionOptions): Promise<AgentSession>;
}
