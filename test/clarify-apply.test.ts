import { describe, expect, test } from "vitest";
import { item, recordAnswers } from "../src/clarify/agenda.ts";
import { applyRound, markAsked, replay } from "../src/clarify/apply.ts";
import type { AcceptedFollowUp } from "../src/clarify/schema.ts";
import { returnsBrief } from "./helpers/brief.ts";
import { accepted, afterRoundOne, ask, dec, meta, prep } from "./helpers/clarify.ts";

const followUp = (id: string, parentId: string): AcceptedFollowUp => ({
  id,
  origin: "follow-up",
  parentId,
  question: "7 天從哪天起算？",
  recommendation: "到貨日",
  basis: "convention",
  options: ["下單日", "到貨日"],
  relatedIds: [],
});

describe("applyRound + markAsked", () => {
  test("prepared questions are stored on their items and the asked batch is recorded as shown", () => {
    const state = afterRoundOne();
    expect(item(state, "OQ-2").view).toEqual({ question: "OQ-2？", recommendation: "建議 OQ-2", basis: "convention", options: [] });
    expect(state.rounds[0]?.asked.map((q) => q.id)).toEqual(["CTR-1", "OQ-1", "OQ-2", "OQ-3"]);
    expect(item(state, "CTR-1").askedIn).toEqual([1]);
  });

  test("markAsked moves the batch to asked and waits for the user; an empty batch goes straight to the next round", () => {
    const applied = applyRound(afterRoundOne(), { n: 2, final: false, prepare: ["OQ-4"], accepted: accepted({ prepared: [prep("OQ-4")] }), ordering: "t" });
    expect(markAsked(applied, ["OQ-4"], "t")).toMatchObject({ phase: "answer" });
    expect(item(markAsked(applied, ["OQ-4"], "t"), "OQ-4").status).toBe("asked");
    expect(markAsked(applied, [], "t").phase).toBe("interpret");
  });

  test("a Decision closes the items it resolves", () => {
    const state = applyRound(afterRoundOne(), {
      n: 2,
      final: false,
      prepare: [],
      accepted: accepted({ decisions: [dec("DEC-1", "R1/CTR-1", ["CTR-1"], { supersedes: ["BR-1"] }), dec("DEC-2", "R1/CTR-1", ["CTR-1"])] }),
      ordering: "t",
    });
    expect(item(state, "CTR-1")).toMatchObject({ status: "decided", resolvedBy: ["DEC-1", "DEC-2"] });
    expect(state.decisions.map((d) => [d.id, d.round, d.status])).toEqual([
      ["DEC-1", 2, "active"],
      ["DEC-2", 2, "active"],
    ]);
  });

  test("revises marks the earlier Decision as revised", () => {
    let state = applyRound(afterRoundOne(), { n: 2, final: false, prepare: [], accepted: accepted({ decisions: [dec("DEC-1", "R1/OQ-2", ["OQ-2"])] }), ordering: "t" });
    state = applyRound(state, { n: 3, final: false, prepare: [], accepted: accepted({ decisions: [dec("DEC-2", "R1/OQ-3", ["OQ-3"], { revises: ["DEC-1"] })] }), ordering: "t" });
    expect(state.decisions[0]).toMatchObject({ status: "revised", revisedBy: "DEC-2" });
  });

  test("a follow-up becomes a pending FQ item under its parent, which waits as followed-up", () => {
    const state = applyRound(afterRoundOne(), { n: 2, final: false, prepare: [], accepted: accepted({ followUps: [followUp("FQ-1", "OQ-3")] }), ordering: "t" });
    expect(item(state, "OQ-3")).toMatchObject({ status: "followed-up", children: ["FQ-1"] });
    expect(item(state, "FQ-1")).toMatchObject({
      kind: "FQ",
      origin: "follow-up",
      status: "pending",
      parentId: "OQ-3",
      depth: 1,
      text: "7 天從哪天起算？",
      view: { question: "7 天從哪天起算？", recommendation: "到貨日", basis: "convention", options: ["下單日", "到貨日"] },
    });
  });

  test("a parent decided in the same submission stays decided", () => {
    const state = applyRound(afterRoundOne(), {
      n: 2,
      final: false,
      prepare: [],
      accepted: accepted({ decisions: [dec("DEC-1", "R1/CTR-1", ["CTR-1"], { supersedes: ["BR-1"] })], followUps: [followUp("FQ-1", "CTR-1")] }),
      ordering: "t",
    });
    expect(item(state, "CTR-1").status).toBe("decided");
  });

  test("the follow-up's decision can close its parent at the same time", () => {
    // Round 2 creates FQ-1; round 3 asks it.
    let state = ask(applyRound(afterRoundOne(), { n: 2, final: false, prepare: [], accepted: accepted({ followUps: [followUp("FQ-1", "OQ-3")] }), ordering: "t" }), []);
    state = recordAnswers(state, [{ type: "response", itemId: "FQ-1", kind: "text", text: "到貨日" }], meta);
    state = applyRound(state, { n: 4, final: false, prepare: [], accepted: accepted({ decisions: [dec("DEC-1", "R3/FQ-1", ["FQ-1", "OQ-3"])] }), ordering: "t" });
    expect([item(state, "FQ-1").status, item(state, "OQ-3").status]).toEqual(["decided", "decided"]);
  });
});

describe("replay", () => {
  test("rebuilds the same Agenda from the Brief, the recorded rounds and the Answers", () => {
    let state = applyRound(afterRoundOne(), {
      n: 2,
      final: false,
      prepare: ["OQ-4"],
      accepted: accepted({ decisions: [dec("DEC-1", "R1/CTR-1", ["CTR-1"], { supersedes: ["BR-1"] })], followUps: [followUp("FQ-1", "OQ-3")], prepared: [prep("OQ-4")] }),
      ordering: "t",
    });
    state = markAsked(state, ["FQ-1", "OQ-4"], "t");
    state = recordAnswers(state, [{ type: "response", itemId: "FQ-1", kind: "na", text: "" }, { type: "note", text: "VIP 其實是 10 天", target: "DEC-1" }], meta);
    expect(replay(returnsBrief(), state)).toEqual(state);
  });
});
