import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { readApiKey, type XPlanConfig } from "../config.ts";
import type { AgentBackend, AgentEvent, AgentSession, SessionOptions } from "./types.ts";

const PROVIDER_ID = "xplan";

/**
 * LiteLLM in front of vLLM serving gpt-oss: a plain OpenAI chat-completions endpoint.
 * These defaults avoid features such proxies commonly reject; `provider.compat` in the config overrides them.
 */
const DEFAULT_COMPAT = {
  supportsDeveloperRole: false,
  supportsStore: false,
  supportsReasoningEffort: true,
  thinkingFormat: "openai",
  maxTokensField: "max_tokens",
} as const;

/** Runs agents in-process through the PI SDK, with no built-in tools, resources or persisted state. */
export class PiBackend implements AgentBackend {
  private constructor(
    private readonly runtime: ModelRuntime,
    private readonly model: Model<any>,
    private readonly workDir: string,
  ) {}

  static async create(config: XPlanConfig, workDir: string): Promise<PiBackend> {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const { provider } = config;
    runtime.registerProvider(PROVIDER_ID, {
      name: "x-plan",
      baseUrl: provider.baseUrl,
      api: "openai-completions",
      models: [
        {
          id: provider.model,
          name: provider.model,
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: provider.contextWindow,
          maxTokens: provider.maxOutputTokens,
          compat: { ...DEFAULT_COMPAT, ...provider.compat } as Model<"openai-completions">["compat"],
        },
      ],
    });
    await runtime.setRuntimeApiKey(PROVIDER_ID, readApiKey(config));
    const model = runtime.getModel(PROVIDER_ID, provider.model);
    if (!model) throw new Error(`Model ${provider.model} could not be registered`);
    return new PiBackend(runtime, model, workDir);
  }

  async createSession(options: SessionOptions): Promise<AgentSession> {
    const tool = defineTool({
      name: options.tool.name,
      label: options.tool.name,
      description: options.tool.description,
      parameters: options.tool.parameters,
      executionMode: "sequential",
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      async execute(_id, params) {
        const reply = options.tool.execute(params);
        if (reply.isError) throw new Error(reply.text);
        return { content: [{ type: "text", text: reply.text }], details: undefined, terminate: reply.terminate };
      },
    });

    const { session } = await createAgentSession({
      cwd: this.workDir,
      agentDir: this.workDir,
      model: this.model,
      thinkingLevel: options.thinking,
      modelRuntime: this.runtime,
      resourceLoader: fixedPromptLoader(options.systemPrompt),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 } }),
      sessionManager: SessionManager.inMemory(this.workDir),
      tools: [tool.name],
      customTools: [tool],
    });

    let messageStarted = Date.now();
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "message_update") options.onRawEvent(event);
      const normalized = normalize(event, messageStarted);
      if (event.type === "message_start") messageStarted = Date.now();
      if (normalized) options.onEvent(normalized);
    });
    if (session.systemPrompt !== options.systemPrompt) {
      options.onEvent({ type: "note", text: `PI altered the system prompt. Effective system prompt:\n\n${session.systemPrompt}` });
    }

    return {
      prompt: (text) => session.prompt(text),
      abort: () => session.abort(),
      dispose: () => {
        unsubscribe();
        session.dispose();
      },
    };
  }
}

function fixedPromptLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

type PiEvent = Parameters<Parameters<Awaited<ReturnType<typeof createAgentSession>>["session"]["subscribe"]>[0]>[0];

function normalize(event: PiEvent, messageStarted: number): AgentEvent | undefined {
  switch (event.type) {
    case "message_end": {
      const message = event.message as { role?: string } & Record<string, any>;
      if (message.role !== "assistant") return undefined;
      const content = (message.content ?? []) as any[];
      return {
        type: "assistant",
        thinking: content.filter((c) => c.type === "thinking").map((c) => c.thinking).join("\n"),
        text: content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
        toolCalls: content.filter((c) => c.type === "toolCall").map((c) => ({ name: c.name, args: c.arguments })),
        usage: {
          input: message.usage?.input ?? 0,
          output: message.usage?.output ?? 0,
          reasoning: message.usage?.reasoning ?? 0,
          cacheRead: message.usage?.cacheRead ?? 0,
        },
        stopReason: message.stopReason,
        errorMessage: message.errorMessage,
        durationMs: Date.now() - messageStarted,
      };
    }
    case "tool_execution_start":
      return { type: "tool_start", name: event.toolName, args: event.args };
    case "tool_execution_end": {
      const content = (event.result?.content ?? []) as { type: string; text?: string }[];
      return { type: "tool_result", name: event.toolName, isError: event.isError, text: content.map((c) => c.text ?? "").join("\n") };
    }
    default:
      return undefined;
  }
}
