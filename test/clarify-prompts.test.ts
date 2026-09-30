import { describe, expect, test } from "vitest";
import { item, recordAnswers } from "../src/clarify/agenda.ts";
import { applyRound, markAsked } from "../src/clarify/apply.ts";
import { buildFinalPrompt, buildRoundPrompt } from "../src/clarify/prompts.ts";
import { createState } from "../src/clarify/agenda.ts";
import type { ClarifyState } from "../src/clarify/schema.ts";
import { PromptLibrary } from "../src/prompts/template.ts";
import { returnsBrief } from "./helpers/brief.ts";
import { accepted, afterRoundOne, dec, meta, prep } from "./helpers/clarify.ts";

const lib = () => new PromptLibrary();
const opts = { maxGaps: 2 };

/** Round 2 decides CTR-1 and OQ-2, follows OQ-3 up and asks FQ-1 and OQ-1; the user answers both. */
function afterRoundTwo(): ClarifyState {
  let state = applyRound(afterRoundOne(), {
    n: 2,
    final: false,
    prepare: ["OQ-1"],
    accepted: accepted({
      decisions: [dec("DEC-1", "R1/CTR-1", ["CTR-1"], { conclusion: "一般會員 7 天", supersedes: ["BR-1"] }), dec("DEC-2", "R1/OQ-2", ["OQ-2"], { conclusion: "賣家負擔" })],
      followUps: [{ id: "FQ-1", origin: "follow-up", parentId: "OQ-3", question: "從哪天起算？", recommendation: "到貨日", basis: "convention", options: ["下單日", "到貨日"], relatedIds: [] }],
      prepared: [prep("OQ-1")],
    }),
    ordering: "t",
  });
  state = markAsked(state, ["FQ-1", "OQ-1"], "t");
  return recordAnswers(
    state,
    [
      { type: "response", itemId: "FQ-1", kind: "text", text: "到貨日" },
      { type: "response", itemId: "OQ-1", kind: "text", text: "出貨後不可取消" },
    ],
    meta,
  );
}

const logEnd = (message: string) => message.indexOf("</log>");

describe("buildRoundPrompt", () => {
  test("round 1 snapshot", () => {
    const prompt = buildRoundPrompt(lib(), returnsBrief(), createState(returnsBrief(), "sha", "zh"), ["CTR-1", "OQ-1", "OQ-2", "OQ-3", "OQ-4"], opts);
    expect(prompt.systemPrompt).toMatchSnapshot("system");
    expect(prompt.userMessage).toMatchSnapshot("user");
  });

  test("round 3 snapshot: log, state, pending answers and a re-asked item", () => {
    const state = afterRoundTwo();
    expect(buildRoundPrompt(lib(), returnsBrief(), state, ["OQ-4"], opts).userMessage).toMatchSnapshot();
  });

  test("the system prompt is the same in every round", () => {
    const first = buildRoundPrompt(lib(), returnsBrief(), createState(returnsBrief(), "sha", "zh"), ["CTR-1"], opts);
    expect(buildRoundPrompt(lib(), returnsBrief(), afterRoundTwo(), ["OQ-4"], opts).systemPrompt).toBe(first.systemPrompt);
  });

  test("everything up to the end of the log is a verbatim prefix of the next round's message (prefix cache, ADR 0006)", () => {
    const states = [createState(returnsBrief(), "sha", "zh"), afterRoundOne(), afterRoundTwo()];
    const messages = states.map((s) => buildRoundPrompt(lib(), returnsBrief(), s, ["OQ-4"], opts).userMessage);
    for (let k = 0; k + 1 < messages.length; k++) {
      const stable = messages[k]!.slice(0, logEnd(messages[k]!));
      expect(messages[k + 1]!.startsWith(stable)).toBe(true);
      expect(logEnd(messages[k + 1]!)).toBeGreaterThan(logEnd(messages[k]!));
    }
  });

  test("the Brief is rendered without annotations even after facts are superseded", () => {
    const message = buildRoundPrompt(lib(), returnsBrief(), afterRoundTwo(), [], opts).userMessage;
    const brief = message.slice(message.indexOf("<brief>"), message.indexOf("</brief>"));
    expect(brief).not.toContain("DEC-");
    expect(message.slice(message.indexOf("<state>"))).toMatch(/supersededBriefItems:\n\s+BR-1:\n\s+- DEC-1/);
  });

  test("pending answers carry the ref, the question as asked and the user's words", () => {
    const message = buildRoundPrompt(lib(), returnsBrief(), afterRoundTwo(), [], opts).userMessage;
    const pending = message.slice(message.indexOf("<pending-answers>"), message.indexOf("</pending-answers>"));
    expect(pending).toContain("ref: R2/FQ-1");
    expect(pending).toContain("followsUp: OQ-3");
    expect(pending).toContain("answer: 到貨日");
    expect(pending).toContain("ref: R2/OQ-1");
    expect(pending).not.toContain("item: OQ-3"); // OQ-3 itself waits on its follow-up
  });

  test("the next Decision id matches the one the check will assign", () => {
    expect(buildRoundPrompt(lib(), returnsBrief(), afterRoundTwo(), [], opts).userMessage).toContain("firstNewDecisionId: DEC-3");
  });
});

describe("buildFinalPrompt", () => {
  test("also hands over followed-up items and asks for nothing", () => {
    const state = afterRoundTwo();
    item(state, "FQ-1").status = "asked"; // pretend the user stopped before answering the follow-up
    state.answers = state.answers.filter((a) => a.itemId !== "FQ-1");
    const prompt = buildFinalPrompt(lib(), returnsBrief(), state);
    expect(prompt.userMessage).toContain("ref: R1/OQ-3");
    expect(prompt.userMessage).toContain("were not all answered");
    expect(prompt.userMessage).not.toContain("<prepare>");
    expect(prompt.systemPrompt).toContain("submit_final");
  });
});
