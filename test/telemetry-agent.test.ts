import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, test } from "vitest";
import type { SubmitTask } from "../src/agent/submit-task.ts";
import type { AgentBackend } from "../src/agent/types.ts";
import { parseConfig } from "../src/config.ts";
import { runTraced } from "../src/shared/traced.ts";
import { startTelemetry, type Telemetry } from "../src/telemetry/setup.ts";
import { ScriptedBackend, type ScriptedTurn } from "./helpers/scripted-backend.ts";
import { CollectingExporter } from "./helpers/spans.ts";

let telemetry: Telemetry | undefined;
afterEach(async () => telemetry?.shutdown());

async function start(captureContent = false): Promise<CollectingExporter> {
  const exporter = new CollectingExporter();
  telemetry = await startTelemetry(parseConfig({ provider: { baseUrl: "http://unused" }, telemetry: { enabled: true, captureContent } }), { log: () => {}, env: {}, exporter });
  return exporter;
}

const withModel = (b: ScriptedBackend): AgentBackend => Object.assign(b, { model: "gpt-test" });

function task(check: SubmitTask<{ n: number }, number>["tool"]["check"] = ({ n }) => (n === 3 ? { accept: n } : { retry: `${n} is wrong` })): SubmitTask<{ n: number }, number> {
  return {
    label: "count",
    systemPrompt: "SECRET SYSTEM",
    userMessage: "SECRET DOCUMENT",
    nudge: "submit",
    thinking: "low",
    maxSubmitAttempts: 3,
    maxNudges: 1,
    tool: { name: "submit_n", description: "d", parameters: Type.Object({ n: Type.Integer() }), check },
  };
}

/** A schema failure, a check failure, then an accepted submission. */
const turns: ScriptedTurn[] = [{ call: { n: "x" } }, { call: { n: 2 } }, { call: { n: 3 } }];
const traceDir = () => mkdtempSync(join(tmpdir(), "xplan-spans-"));

describe("agent spans", () => {
  test("one invoke_agent span with a chat span per response and an execute_tool span per call", async () => {
    const exporter = await start();
    const outcome = await runTraced(withModel(new ScriptedBackend([turns])), task(), traceDir());
    await telemetry!.shutdown();
    expect(outcome.status).toBe("accepted");

    const agent = exporter.one("invoke_agent count");
    expect(agent.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "count",
      "xplan.outcome": "accepted",
      "xplan.submit_attempts": 3,
      "xplan.schema_failures": 1,
      "xplan.check_failures": 1,
      "xplan.usage.input_tokens": 300,
    });
    const chats = exporter.named("chat gpt-test");
    expect(chats).toHaveLength(3);
    expect(chats[0]!.attributes).toMatchObject({ "gen_ai.request.model": "gpt-test", "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 50, "gen_ai.usage.reasoning.output_tokens": 10 });
    const tools = exporter.named("execute_tool submit_n");
    expect(tools.map((t) => t.status.code)).toEqual([2, 2, 0]);
    for (const child of [...chats, ...tools]) expect(exporter.parentOf(child)).toBe(agent);
  });

  test("no content leaves the machine unless captureContent is on", async () => {
    const exporter = await start(false);
    await runTraced(withModel(new ScriptedBackend([turns])), task(), traceDir());
    await telemetry!.shutdown();
    const everything = JSON.stringify(exporter.spans.map((s) => [s.attributes, s.status, s.events]));
    for (const secret of ["SECRET", "thinking…", "is wrong", '"n":']) expect(everything).not.toContain(secret);
  });

  test("with captureContent the prompts, reasoning, arguments and results are attached", async () => {
    const exporter = await start(true);
    await runTraced(withModel(new ScriptedBackend([turns])), task(), traceDir());
    await telemetry!.shutdown();
    expect(exporter.one("invoke_agent count").attributes).toMatchObject({
      "gen_ai.system_instructions": JSON.stringify([{ type: "text", content: "SECRET SYSTEM" }]),
      "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content: "SECRET DOCUMENT" }] }]),
    });
    expect(JSON.parse(exporter.named("chat gpt-test")[0]!.attributes["gen_ai.output.messages"] as string)[0].parts[0]).toEqual({ type: "reasoning", content: "thinking…" });
    const rejected = exporter.named("execute_tool submit_n")[1]!;
    expect(rejected.attributes).toMatchObject({ "gen_ai.tool.call.arguments": '{"n":2}', "gen_ai.tool.call.result": "2 is wrong" });
  });

  test("an agent run by a check (Grounding Review) nests under the tool call that ran it", async () => {
    const exporter = await start();
    const backend = withModel(new ScriptedBackend(() => [{ call: { n: 3 } }]));
    const dir = traceDir();
    const review = task();
    const outer = task(async ({ n }) => {
      await runTraced(backend, { ...review, label: "review", tool: { ...review.tool, name: "submit_review" } }, dir);
      return { accept: n };
    });
    await runTraced(backend, outer, dir);
    await telemetry!.shutdown();
    expect(exporter.parentOf(exporter.one("invoke_agent review"))).toBe(exporter.one("execute_tool submit_n"));
    expect(exporter.parentOf(exporter.one("execute_tool submit_n"))).toBe(exporter.one("invoke_agent count"));
  });

  test("a failed task marks its span failed", async () => {
    const exporter = await start();
    const outcome = await runTraced(withModel(new ScriptedBackend([[{ text: "no" }, { text: "still no" }]])), task(), traceDir());
    await telemetry!.shutdown();
    expect(outcome.status).toBe("failed");
    expect(exporter.one("invoke_agent count")).toMatchObject({ attributes: { "xplan.outcome": "failed", "xplan.failure": "no-submit" }, status: { code: 2 } });
  });
});
