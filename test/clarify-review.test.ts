import { describe, expect, test } from "vitest";
import { recordAnswers } from "../src/clarify/agenda.ts";
import { applyRound, markAsked } from "../src/clarify/apply.ts";
import { judgeReview, reviewErrors, reviewToYaml, underReview, type ReviewSubmission } from "../src/clarify/review.ts";
import type { ClarifyState, Decision } from "../src/clarify/schema.ts";
import { returnsBrief } from "./helpers/brief.ts";
import { accepted, afterRoundOne, dec, meta, prep } from "./helpers/clarify.ts";

/** Round 2 decides CTR-1, follows OQ-3 up with FQ-1 and asks FQ-1 and OQ-1; the user answers both. */
function afterRoundTwo(): ClarifyState {
  let state = applyRound(afterRoundOne(), {
    n: 2,
    final: false,
    prepare: ["OQ-1"],
    accepted: accepted({
      decisions: [dec("DEC-1", "R1/CTR-1", ["CTR-1"], { conclusion: "一般會員 7 天", supersedes: ["BR-1"] })],
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

const submitted = (_state: ClarifyState): Decision[] => [
  { ...dec("DEC-2", "R2/FQ-1", ["FQ-1", "OQ-3"], { conclusion: "鑑賞期自到貨日起算 7 天" }), round: 3, status: "active" },
  { ...dec("DEC-3", "R2/OQ-1", ["OQ-1"], { conclusion: "已出貨的訂單不能取消" }), round: 3, status: "active" },
];

const review = (findings: Partial<ReviewSubmission["reviews"][number]>[]): ReviewSubmission => ({
  reviews: findings.map((f, i) => ({ decision: `decisions[${i}]`, claims: [{ text: "x", source: "answer" }], addressesQuestion: true, unanswered: [], partlyCorrected: [], ...f })),
});

const ctx = { attempt: 1, final: false, maxFollowUpDepth: 2, followUps: [] };

describe("reviewToYaml", () => {
  test("gives each Decision its Answer as shown to the user, the Answers it follows up, the Brief items named and earlier Decisions", () => {
    const state = afterRoundTwo();
    expect(reviewToYaml(returnsBrief(), state, underReview(state, submitted(state)))).toMatchSnapshot();
  });
});

describe("judgeReview", () => {
  test("paths follow submission order from the next free Decision id", () => {
    const state = afterRoundTwo();
    expect(underReview(state, submitted(state)).map((i) => [i.path, i.decision.id])).toEqual([
      ["decisions[0]", "DEC-2"],
      ["decisions[1]", "DEC-3"],
    ]);
  });

  test("an unsupported claim is embellished; a partial Answer that can still be followed up is partial", () => {
    const state = afterRoundTwo();
    const out = judgeReview(state, underReview(state, submitted(state)), review([{ claims: [{ text: "共 7 天", source: "none" }] }, { unanswered: ["會員之後怎麼辦"] }]), ctx);
    expect(out.records.map((r) => [r.path, r.verdicts])).toEqual([
      ["decisions[0]", ["embellished"]],
      ["decisions[1]", ["partial"]],
    ]);
    expect(out.issues[1]?.errors[0]).toMatch(/R2\/OQ-1 leaves part of OQ-1 unanswered: 會員之後怎麼辦\. Ask a follow-up \(origin "follow-up", parentId OQ-1\)/);
    expect(out.leaveOpen.size).toBe(0);
  });

  test("a partial Answer is not flagged when the submission already follows it up, or when it cannot be followed up", () => {
    const state = afterRoundTwo();
    const items = underReview(state, submitted(state));
    const partial = review([{ unanswered: ["是否含例假日"] }, { unanswered: ["會員之後怎麼辦"] }]);
    const followUp = { id: "FQ-2", origin: "follow-up" as const, parentId: "OQ-1", question: "q", recommendation: "r", basis: "convention" as const, options: [], relatedIds: [] };
    // FQ-1 is already a follow-up; with a depth limit of 1 it cannot be followed up again.
    const out = judgeReview(state, items, partial, { ...ctx, maxFollowUpDepth: 1, followUps: [followUp] });
    expect(out.issues).toEqual([]);
    expect(out.records.map((r) => r.unanswered)).toEqual([["是否含例假日"], ["會員之後怎麼辦"]]);
    expect(judgeReview(state, items, partial, { ...ctx, final: true }).issues).toEqual([]);
  });

  test("an off-topic Answer is asked again when possible, otherwise its item is left open", () => {
    const state = afterRoundTwo();
    const items = underReview(state, submitted(state));
    const offTopic = review([{}, { addressesQuestion: false }]);
    const open = judgeReview(state, items, offTopic, ctx);
    expect(open.records[1]?.verdicts).toEqual(["off-topic"]);
    expect(open.issues[0]?.errors[0]).toMatch(/does not respond to the question of OQ-1.*remove this Decision and ask a follow-up/);
    expect(open.leaveOpen.size).toBe(0);
    const closing = judgeReview(state, items, offTopic, { ...ctx, final: true });
    expect(closing.issues[0]?.errors[0]).toMatch(/OQ-1 cannot be asked again and stays unresolved/);
    expect([...closing.leaveOpen]).toEqual(["OQ-1"]);
  });
});

describe("judgeReview on supersedes", () => {
  test("superseding a whole Brief item the user only partly corrected is sent back: keep the item, name it in relatedIds", () => {
    const state = afterRoundTwo();
    const items = underReview(state, [{ ...dec("DEC-2", "R2/OQ-1", ["OQ-1"], { conclusion: "出貨後不可取消", supersedes: ["BR-2", "FEAT-1"] }), round: 3, status: "active" }]);
    const out = judgeReview(state, items, review([{ partlyCorrected: ["FEAT-1"] }]), ctx);
    expect(out.records[0]?.verdicts).toEqual(["overreach"]);
    expect(out.records[0]?.partlyCorrected).toEqual(["FEAT-1"]);
    expect(out.issues[0]?.errors).toEqual([
      "supersedes FEAT-1, but R2/OQ-1 corrects only part of it: the rest still holds. Do not supersede FEAT-1; name it in relatedIds and state the correction in the conclusion",
    ]);
  });
});

describe("reviewErrors", () => {
  test("every Decision is reviewed exactly once, and nothing else", () => {
    const state = afterRoundTwo();
    const items = underReview(state, submitted(state));
    const r = review([{}, {}]);
    expect(reviewErrors(r, items)).toEqual([]);
    const wrong: ReviewSubmission = { reviews: [r.reviews[0]!, r.reviews[0]!, { ...r.reviews[0]!, decision: "decisions[7]" }] };
    expect(reviewErrors(wrong, items)).toEqual(["decisions[7] is not a Decision in <review>", "decisions[0] is reviewed more than once", "decisions[1] has no review"]);
    const notSuperseded: ReviewSubmission = { reviews: [{ ...r.reviews[0]!, partlyCorrected: ["BR-2"] }, r.reviews[1]!] };
    expect(reviewErrors(notSuperseded, items)).toEqual(["decisions[0]: partlyCorrected BR-2 is not in its supersedes"]);
  });
});
