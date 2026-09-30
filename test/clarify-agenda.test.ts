import { describe, expect, test } from "vitest";
import { createState, item, recordAnswers, settle, type UserInput } from "../src/clarify/agenda.ts";
import type { AgendaStatus, ClarifyState, ResponseKind } from "../src/clarify/schema.ts";
import { returnsBrief } from "./helpers/brief.ts";

const meta = { via: "test", at: "2026-09-30T00:00:00.000Z" };

/** A state whose round-1 batch shows `ids` to the user. */
function asked(ids: string[]): ClarifyState {
  const state = createState(returnsBrief(), "sha", "zh");
  for (const id of ids) {
    const it = item(state, id);
    it.status = "asked";
    it.askedIn.push(1);
    it.view = { question: it.text, recommendation: `建議：${id}`, basis: "convention", options: [] };
  }
  state.rounds.push({ n: 1, final: false, prepare: ids, accepted: { decisions: [], followUps: [], prepared: [] }, asked: [], ordering: { prepare: "", batch: "" } });
  state.phase = "answer";
  return state;
}

const respond = (itemId: string, kind: ResponseKind, text = ""): UserInput => ({ type: "response", itemId, kind, text });

describe("createState", () => {
  test("puts the Brief's contradictions, open questions and assumptions on the agenda, all pending", () => {
    const state = createState(returnsBrief(), "sha", "zh");
    expect(state.agenda.map((i) => [i.id, i.kind, i.status])).toEqual([
      ["OQ-1", "OQ", "pending"],
      ["OQ-2", "OQ", "pending"],
      ["OQ-3", "OQ", "pending"],
      ["OQ-4", "OQ", "pending"],
      ["CTR-1", "CTR", "pending"],
      ["ASM-1", "ASM", "pending"],
      ["ASM-2", "ASM", "pending"],
    ]);
    expect(item(state, "CTR-1")).toMatchObject({ text: "取消期限 3 天與 7 天不一致", relatedIds: ["BR-1", "BR-2"], origin: "brief", depth: 0 });
    expect(item(state, "OQ-1").severity).toBe("blocking");
    expect(item(state, "ASM-2").confidence).toBe("low");
    expect(state.phase).toBe("interpret");
  });
});

describe("recordAnswers", () => {
  test.each<[ResponseKind, AgendaStatus]>([
    ["text", "answered"],
    ["accept", "answered"],
    ["later", "pending"],
    ["defer", "deferred"],
    ["na", "dismissed"],
  ])("%s moves an asked item to %s", (kind, status) => {
    const state = recordAnswers(asked(["OQ-2"]), [respond("OQ-2", kind, "賣家負擔")], meta);
    expect(item(state, "OQ-2").status).toBe(status);
    expect(state.answers).toEqual([{ ref: "R1/OQ-2", itemId: "OQ-2", round: 1, kind, text: kind === "accept" ? "建議：OQ-2" : "賣家負擔", ...meta }]);
    expect(state.phase).toBe("interpret");
  });

  test("/ok records the recommendation exactly as it was shown, not what the answerer passed", () => {
    const state = recordAnswers(asked(["OQ-2"]), [respond("OQ-2", "accept", "whatever")], meta);
    expect(state.answers[0]?.text).toBe("建議：OQ-2");
  });

  test("the second /later on the same item defers it", () => {
    let state = recordAnswers(asked(["OQ-2"]), [respond("OQ-2", "later")], meta);
    expect(item(state, "OQ-2")).toMatchObject({ status: "pending", laterCount: 1 });
    const it = item(state, "OQ-2");
    it.status = "asked";
    state.rounds.push({ ...state.rounds[0]!, n: 2 });
    state = recordAnswers(state, [respond("OQ-2", "later")], meta);
    expect(item(state, "OQ-2")).toMatchObject({ status: "deferred", laterCount: 2 });
  });

  test("items the user did not get to stay asked", () => {
    const state = recordAnswers(asked(["OQ-1", "OQ-2"]), [respond("OQ-1", "text", "不可取消"), { type: "done" }], meta);
    expect(item(state, "OQ-2").status).toBe("asked");
    expect(state.doneRequested).toBe(true);
  });

  test("a note becomes an answered NOTE item, with an optional target", () => {
    const state = recordAnswers(asked(["OQ-2"]), [{ type: "note", text: "VIP 是 10 天", target: "OQ-1" }, { type: "note", text: "補充" }], meta);
    expect(state.agenda.slice(-2).map((i) => [i.id, i.kind, i.origin, i.status, i.target, i.text])).toEqual([
      ["NOTE-1", "NOTE", "user", "answered", "OQ-1", "VIP 是 10 天"],
      ["NOTE-2", "NOTE", "user", "answered", undefined, "補充"],
    ]);
    expect(state.answers.map((a) => a.ref)).toEqual(["R1/NOTE-1", "R1/NOTE-2"]);
  });

  test("rejects responses to items that were not asked, and notes aimed at unknown ids", () => {
    expect(() => recordAnswers(asked(["OQ-2"]), [respond("OQ-3", "text", "x")], meta)).toThrow(/OQ-3 was not asked/);
    expect(() => recordAnswers(asked(["OQ-2"]), [{ type: "note", text: "x", target: "OQ-99" }], meta)).toThrow(/OQ-99/);
  });

  test("does not modify the state it was given", () => {
    const before = asked(["OQ-2"]);
    const snapshot = structuredClone(before);
    recordAnswers(before, [respond("OQ-2", "text", "賣家")], meta);
    expect(before).toEqual(snapshot);
  });
});

describe("settle: a parent whose follow-ups all ended without a Decision on it", () => {
  function withChildren(childStatuses: AgendaStatus[], parentStatus: AgendaStatus = "followed-up"): ClarifyState {
    const state = createState(returnsBrief(), "sha", "zh");
    const parent = item(state, "OQ-3");
    parent.status = parentStatus;
    childStatuses.forEach((status, i) => {
      const id = `FQ-${i + 1}`;
      parent.children.push(id);
      state.agenda.push({ id, kind: "FQ", origin: "follow-up", status, text: "起算點？", relatedIds: [], parentId: "OQ-3", depth: 1, children: [], laterCount: 0, askedIn: [] });
    });
    return state;
  }

  test.each<[string, AgendaStatus[], AgendaStatus]>([
    ["the only child was dismissed", ["dismissed"], "answered"],
    ["the only child was deferred", ["deferred"], "answered"],
    ["one child was decided and the other dismissed", ["decided", "dismissed"], "answered"],
    ["a child is still pending", ["decided", "pending"], "followed-up"],
    ["a child is still asked", ["asked"], "followed-up"],
  ])("when %s the parent becomes %s", (_, children, expected) => {
    expect(item(settle(withChildren(children)), "OQ-3").status).toBe(expected);
  });

  test("a parent that was already decided stays decided", () => {
    expect(item(settle(withChildren(["dismissed"], "decided")), "OQ-3").status).toBe("decided");
  });

  test("recordAnswers settles: dismissing the last follow-up sends its parent back for interpretation", () => {
    const state = withChildren(["asked"]);
    item(state, "FQ-1").askedIn.push(2);
    state.rounds.push({ n: 2, final: false, prepare: [], accepted: { decisions: [], followUps: [], prepared: [] }, asked: [], ordering: { prepare: "", batch: "" } });
    const next = recordAnswers(state, [respond("FQ-1", "na")], meta);
    expect(item(next, "OQ-3").status).toBe("answered");
  });
});
