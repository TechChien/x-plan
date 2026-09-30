import { describe, expect, test } from "vitest";
import { createState, item } from "../src/clarify/agenda.ts";
import { checkSelection, ruleOrderer } from "../src/clarify/ordering.ts";
import type { AgendaItem, ClarifyState } from "../src/clarify/schema.ts";
import { returnsBrief } from "./helpers/brief.ts";

const fq = (id: string, origin: "follow-up" | "gherkin-gap", parentId?: string): AgendaItem => ({
  id,
  kind: "FQ",
  origin,
  status: "pending",
  text: "?",
  relatedIds: ["FEAT-2"],
  ...(parentId ? { parentId } : {}),
  depth: parentId ? 1 : 0,
  children: [],
  laterCount: 0,
  askedIn: [],
});

function state(): ClarifyState {
  return createState(returnsBrief(), "sha", "zh");
}

describe("ruleOrderer.selectPrepare (provisional rule, ADR 0009)", () => {
  test("contradictions first, then open questions by severity, then assumptions with the least confident first", async () => {
    const { ids } = await ruleOrderer.selectPrepare(state(), 10);
    expect(ids).toEqual(["CTR-1", "OQ-1", "OQ-2", "OQ-3", "OQ-4", "ASM-2", "ASM-1"]);
  });

  test("takes at most `limit` items and only pending ones", async () => {
    const s = state();
    item(s, "CTR-1").status = "decided";
    item(s, "OQ-1").status = "deferred";
    expect((await ruleOrderer.selectPrepare(s, 3)).ids).toEqual(["OQ-2", "OQ-3", "OQ-4"]);
  });

  test("a waiting follow-up ranks with the item it follows up; gherkin gaps come last", async () => {
    const s = state();
    item(s, "OQ-2").status = "followed-up";
    s.agenda.push(fq("FQ-1", "gherkin-gap"), fq("FQ-2", "follow-up", "OQ-2"));
    expect((await ruleOrderer.selectPrepare(s, 10)).ids).toEqual(["CTR-1", "OQ-1", "FQ-2", "OQ-3", "OQ-4", "ASM-2", "ASM-1", "FQ-1"]);
  });

  test("explains its choice for the trace", async () => {
    expect((await ruleOrderer.selectPrepare(state(), 2)).rationale).toMatch(/rule/i);
  });
});

describe("ruleOrderer.composeBatch", () => {
  test("new follow-ups first, then the prepared items in order, then gaps, cut at the batch size", async () => {
    const { ids } = await ruleOrderer.composeBatch(state(), { followUps: ["FQ-3"], prepared: ["CTR-1", "OQ-1", "OQ-2"], gaps: ["FQ-4", "FQ-5"] }, 5);
    expect(ids).toEqual(["FQ-3", "CTR-1", "OQ-1", "OQ-2", "FQ-4"]);
  });
});

describe("checkSelection guards any orderer's result", () => {
  test("accepts a valid selection", () => {
    expect(checkSelection(["OQ-1", "OQ-2"], ["OQ-1", "OQ-2", "OQ-3"], 5)).toEqual([]);
  });

  test("rejects ids outside the candidates, duplicates and too many ids", () => {
    expect(checkSelection(["OQ-1", "OQ-9", "OQ-1", "OQ-2"], ["OQ-1", "OQ-2"], 3)).toEqual([
      "OQ-9 is not a candidate",
      "OQ-1 is selected twice",
      "4 items selected, at most 3 allowed",
    ]);
  });
});
