import { describe, expect, test } from "vitest";
import { item, recordAnswers } from "../src/clarify/agenda.ts";
import { applyRound } from "../src/clarify/apply.ts";
import { checkRound, type RoundCheckContext } from "../src/clarify/check.ts";
import { CLARIFY_LIMITS, type ClarifyState, type DecisionOp, type FollowUp, type RoundSubmission } from "../src/clarify/schema.ts";
import { returnsBrief } from "./helpers/brief.ts";
import { accepted, afterRoundOne, ask, dec, meta, prep } from "./helpers/clarify.ts";

const op = (answerRef: string, resolves: string[], conclusion: string, extra: Partial<DecisionOp> = {}): DecisionOp => ({
  answerRef,
  resolves,
  conclusion,
  supersedes: [],
  confirms: [],
  revises: [],
  relatedIds: [],
  ...extra,
});

const fu = (extra: Partial<FollowUp> = {}): FollowUp => ({
  origin: "follow-up",
  parentId: "OQ-3",
  question: "7 天從哪天起算？",
  recommendation: "到貨日起算",
  basis: "convention",
  options: ["下單日", "到貨日"],
  relatedIds: ["FEAT-2"],
  ...extra,
});

const gap = (extra: Partial<FollowUp> = {}): FollowUp => ({
  origin: "gherkin-gap",
  question: "退貨成功後頁面顯示什麼？",
  recommendation: "顯示退貨單號",
  basis: "convention",
  options: [],
  relatedIds: ["FEAT-2"],
  ...extra,
});

/** Round 2 after `afterRoundOne`: interprets CTR-1, OQ-2 and OQ-3 and prepares OQ-1 and OQ-4. */
function valid(): RoundSubmission {
  return {
    decisions: [
      op("R1/CTR-1", ["CTR-1"], "一般會員取消期限為 7 天", { supersedes: ["BR-1"] }),
      op("R1/CTR-1", ["CTR-1"], "VIP 會員取消期限為 14 天", { relatedIds: ["FEAT-1"] }),
      op("R1/OQ-2", ["OQ-2"], "退貨運費由賣家負擔"),
    ],
    followUps: [fu()],
    prepared: [prep("OQ-1"), prep("OQ-4")],
  };
}

const ctx = (extra: Partial<RoundCheckContext> = {}): RoundCheckContext => ({
  brief: returnsBrief(),
  round: 2,
  prepare: ["OQ-1", "OQ-4"],
  final: false,
  isLast: false,
  language: "zh",
  limits: CLARIFY_LIMITS,
  ...extra,
});

const errorsOf = (state: ClarifyState, submission: RoundSubmission, c = ctx()) =>
  checkRound(state, submission, c).issues.flatMap((i) => i.errors.map((e) => `${i.path}: ${e}`));

function mutate(change: (s: RoundSubmission) => void): RoundSubmission {
  const s = valid();
  change(s);
  return s;
}

describe("checkRound", () => {
  test("accepts a valid round and numbers what it accepts", () => {
    const result = checkRound(afterRoundOne(), valid(), ctx());
    expect(result.issues).toEqual([]);
    expect(result.accepted.decisions.map((d) => d.id)).toEqual(["DEC-1", "DEC-2", "DEC-3"]);
    expect(result.accepted.followUps.map((f) => f.id)).toEqual(["FQ-1"]);
    expect(result.accepted.prepared.map((p) => p.id)).toEqual(["OQ-1", "OQ-4"]);
  });

  test.each<[string, (s: RoundSubmission) => void, RegExp]>([
    // Rule 1: no Answer is silently dropped.
    ["an Answer left uninterpreted", (s) => (s.followUps = []), /^round: R1\/OQ-3 .*neither resolved.*nor followed up/],
    // Rule 2: a Decision stands on a real Answer with content.
    ["answerRef to an item the user put off", (s) => (s.decisions[2]!.answerRef = "R1/OQ-1"), /^decisions\[2\]: answerRef R1\/OQ-1 is not an Answer awaiting interpretation/],
    ["answerRef to no Answer at all", (s) => (s.decisions[2]!.answerRef = "R9/OQ-2"), /^decisions\[2\]: answerRef R9\/OQ-2/],
    // Rule 3: only answered items can be closed.
    ["resolving an item nobody answered", (s) => s.decisions[2]!.resolves.push("OQ-4"), /^decisions\[2\]: .*OQ-4 has no Answer.*coveredBy/],
    ["resolving another answered item with this Answer", (s) => s.decisions[2]!.resolves.push("OQ-3"), /^decisions\[2\]: .*OQ-3 is not the item R1\/OQ-2 answers/],
    // Rule 4: references.
    ["superseding an unknown id", (s) => (s.decisions[0]!.supersedes = ["BR-9"]), /^decisions\[0\]: supersedes BR-9, which is not a fact or assumption in the Brief/],
    ["superseding an open question", (s) => (s.decisions[0]!.supersedes = ["OQ-1"]), /supersedes OQ-1, which is not a fact or assumption/],
    ["confirming something that is not an assumption", (s) => (s.decisions[2]!.confirms = ["BR-1"]), /^decisions\[2\]: confirms BR-1, which is not an assumption/],
    ["revising an unknown Decision", (s) => (s.decisions[2]!.revises = ["DEC-9"]), /^decisions\[2\]: revises DEC-9, which is not an active Decision/],
    ["an unknown related id", (s) => (s.decisions[1]!.relatedIds = ["FEAT-9"]), /^decisions\[1\]: relatedIds FEAT-9 does not exist/],
    // Rule 5: a contradiction is settled explicitly.
    [
      "a contradiction closed without saying which side holds",
      (s) => (s.decisions[0]!.supersedes = []),
      /^decisions\[0\]: resolves CTR-1 but no Decision on it supersedes \(Brief facts\) or revises \(Decisions\) one side \(BR-1, BR-2\), or names every side in relatedIds/,
    ],
    // Rule 6: exactly the assigned items are prepared.
    ["an assigned item left unprepared", (s) => s.prepared.pop(), /^round: prepared is missing OQ-4/],
    ["an item prepared that was not assigned", (s) => s.prepared.push(prep("ASM-1")), /^prepared\[2\]: ASM-1 was not assigned in <prepare>/],
    ["coveredBy pointing nowhere", (s) => (s.prepared[0]!.coveredBy = "DEC-9"), /^prepared\[0\]: coveredBy DEC-9 is not an active or accepted Decision/],
    // Rule 7: follow-ups and gaps.
    ["following up an item without a new Answer", (s) => (s.followUps[0]!.parentId = "OQ-1"), /^followUps\[0\]: parentId OQ-1 has no Answer being interpreted in this round/],
    ["a follow-up without a parent", (s) => delete s.followUps[0]!.parentId, /^followUps\[0\]: a follow-up needs parentId/],
    ["a gap with a parent", (s) => s.followUps.push(gap({ parentId: "OQ-3" })), /^followUps\[1\]: a gherkin-gap question has no parentId/],
    ["a gap that names no fact", (s) => s.followUps.push(gap({ relatedIds: ["OQ-3"] })), /^followUps\[1\]: a gherkin-gap question must name the facts it concerns/],
    ["too many gaps", (s) => s.followUps.push(gap(), gap(), gap()), /^followUps\[3\]: at most 2 gherkin-gap questions per round/],
    // Rule 9: output language (zh here).
    ["a conclusion in the wrong script", (s) => (s.decisions[2]!.conclusion = "退货运费由卖家负担"), /^decisions\[2\]: not written in Traditional Chinese/],
  ])("rejects %s", (_, change, expected) => {
    expect(errorsOf(afterRoundOne(), mutate(change))).toContainEqual(expect.stringMatching(expected));
  });

  test.each<[string, (s: RoundSubmission) => void]>([
    ["a contradiction reconciled by naming both sides", (s) => (s.decisions[0] = op("R1/CTR-1", ["CTR-1"], "VIP 14 天，一般會員 7 天", { relatedIds: ["BR-1", "BR-2"] }))],
    ["coveredBy a Decision accepted in this very submission", (s) => (s.prepared[1]!.coveredBy = "DEC-2")],
    ["confirming an assumption", (s) => (s.decisions[2]!.confirms = ["ASM-1"])],
    ["two gaps", (s) => s.followUps.push(gap(), gap())],
  ])("accepts %s", (_, change) => {
    expect(errorsOf(afterRoundOne(), mutate(change))).toEqual([]);
  });

  test("a fact already superseded by an active Decision can only be superseded again by revising that Decision", () => {
    const state = applyRound(afterRoundOne(), { n: 2, final: false, prepare: [], accepted: accepted({ decisions: [dec("DEC-1", "R1/CTR-1", ["CTR-1"], { supersedes: ["BR-1"] })] }), ordering: "t" });
    const note = recordAnswers(ask(state, []), [{ type: "note", text: "3 天其實是 VIP 以外的規定", target: "DEC-1" }], meta);
    const submission = (revises: string[]): RoundSubmission => ({ decisions: [op("R3/NOTE-1", ["NOTE-1"], "一般會員 3 天", { supersedes: ["BR-1"], revises })], followUps: [], prepared: [] });
    const c = ctx({ round: 4, prepare: [] });
    expect(errorsOf(note, submission([]), c)).toContainEqual(expect.stringMatching(/supersedes BR-1, already superseded by DEC-1; revise DEC-1 instead/));
    expect(errorsOf(note, submission(["DEC-1"]), c).filter((e) => !e.startsWith("round: R1"))).toEqual([]);
  });

  describe("follow-up chains", () => {
    /** Round 2 follows OQ-3 up with FQ-1; round 3 asks it and the user answers. */
    function followedUp(): ClarifyState {
      let state = applyRound(afterRoundOne(), {
        n: 2,
        final: false,
        prepare: [],
        accepted: accepted({
          decisions: [dec("DEC-1", "R1/CTR-1", ["CTR-1"], { supersedes: ["BR-1"] }), dec("DEC-2", "R1/OQ-2", ["OQ-2"])],
          followUps: [{ id: "FQ-1", ...fu() }],
        }),
        ordering: "t",
      });
      state = ask(state, []);
      return recordAnswers(state, [{ type: "response", itemId: "FQ-1", kind: "text", text: "看情況" }], meta);
    }
    const c = ctx({ round: 4, prepare: [] });

    test("closing the last follow-up must close its parent too (rule 8)", () => {
      const only = { decisions: [op("R3/FQ-1", ["FQ-1"], "從到貨日起算")], followUps: [], prepared: [] };
      expect(errorsOf(followedUp(), only, c)).toContainEqual(expect.stringMatching(/^round: all follow-ups of OQ-3 are finished but no Decision resolves OQ-3/));
      const both = { decisions: [op("R3/FQ-1", ["FQ-1", "OQ-3"], "鑑賞期為到貨後 7 天")], followUps: [], prepared: [] };
      expect(errorsOf(followedUp(), both, c)).toEqual([]);
    });

    test("a follow-up of a follow-up is the deepest allowed", () => {
      const deeper = (parentId: string): RoundSubmission => ({ decisions: [], followUps: [fu({ parentId })], prepared: [] });
      expect(errorsOf(followedUp(), deeper("FQ-1"), c)).toEqual([]);

      let state = applyRound(followedUp(), { n: 4, final: false, prepare: [], accepted: accepted({ followUps: [{ id: "FQ-2", ...fu({ parentId: "FQ-1" }) }] }), ordering: "t" });
      state = recordAnswers(ask(state, []), [{ type: "response", itemId: "FQ-2", kind: "text", text: "還是看情況" }], meta);
      expect(item(state, "FQ-2").depth).toBe(2);
      expect(errorsOf(state, deeper("FQ-2"), ctx({ round: 6, prepare: [] }))).toContainEqual(
        expect.stringMatching(/^followUps\[0\]: FQ-2 is already a follow-up of a follow-up; decide on the Answer you have/),
      );
    });

    test("the closing round interprets followed-up items too and cannot ask anything", () => {
      const final = ctx({ round: 4, prepare: [], final: true });
      const onlyChild = { decisions: [op("R3/FQ-1", ["FQ-1"], "起算點未定")] };
      expect(errorsOf(followedUp(), onlyChild as RoundSubmission, final)).toContainEqual(expect.stringMatching(/^round: R1\/OQ-3 .*neither resolved/));
    });
  });

  describe("on the last attempt", () => {
    test("drops invalid Decisions into rejected and keeps the rest, leaving ids unused rather than reused", () => {
      const s = mutate((x) => (x.decisions[1]!.relatedIds = ["FEAT-9"]));
      const result = checkRound(afterRoundOne(), s, ctx({ isLast: true }));
      expect(result.accepted.decisions.map((d) => d.id)).toEqual(["DEC-1", "DEC-3"]);
      expect(result.rejected).toEqual([{ round: 2, kind: "decision", item: { id: "DEC-2", ...s.decisions[1] }, errors: ["relatedIds FEAT-9 does not exist"] }]);
    });

    test("keeps items in the wrong language, with a warning", () => {
      const s = mutate((x) => (x.decisions[2]!.conclusion = "退货运费由卖家负担"));
      const result = checkRound(afterRoundOne(), s, ctx({ isLast: true }));
      expect(result.accepted.decisions).toHaveLength(3);
      expect(result.languageWarnings).toEqual(["decisions[2]"]);
    });

    test("drops an invalid coveredBy hint but keeps the prepared question", () => {
      const result = checkRound(afterRoundOne(), mutate((x) => (x.prepared[0]!.coveredBy = "DEC-9")), ctx({ isLast: true }));
      expect(result.accepted.prepared[0]).toEqual(prep("OQ-1"));
    });

    test("continues numbering after Decisions rejected in earlier rounds", () => {
      const state = afterRoundOne();
      state.rejected.push({ round: 1, kind: "decision", item: { id: "DEC-4" }, errors: [] });
      expect(checkRound(state, valid(), ctx()).accepted.decisions.map((d) => d.id)).toEqual(["DEC-5", "DEC-6", "DEC-7"]);
    });
  });
});
