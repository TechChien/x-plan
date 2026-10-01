import { describe, expect, test } from "vitest";
import { findItem, recordAnswers } from "../src/clarify/agenda.ts";
import { applyRound, markAsked, replay } from "../src/clarify/apply.ts";
import { addConflicts, checkConflicts, conflictSides, consistencyToYaml, newDecisions } from "../src/clarify/consistency.ts";
import type { ClarifyState, ConflictOp } from "../src/clarify/schema.ts";
import { returnsBrief } from "./helpers/brief.ts";
import { accepted, afterRoundOne, dec, meta, prep } from "./helpers/clarify.ts";

/** Round 2 decides CTR-1 (superseding BR-1) and OQ-3. */
function afterRoundTwo(): ClarifyState {
  return applyRound(afterRoundOne(), {
    n: 2,
    final: false,
    prepare: [],
    accepted: accepted({
      decisions: [
        dec("DEC-1", "R1/CTR-1", ["CTR-1"], { conclusion: "取消期限為下單後 7 天", supersedes: ["BR-1"] }),
        dec("DEC-2", "R1/OQ-3", ["OQ-3"], { conclusion: "鑑賞期為 7 天" }),
      ],
    }),
    ordering: "t",
  });
}

const conflict = (ids: string[], extra: Partial<ConflictOp> = {}): ConflictOp => ({
  ids,
  conflict: `${ids.join(" 與 ")} 互相衝突`,
  question: "以哪一個為準？",
  recommendation: `以 ${ids[0]} 為準`,
  basis: "brief",
  options: [],
  ...extra,
});

const ctx = { language: "zh" as const, limit: 5 };

describe("consistencyToYaml", () => {
  test("lists this round's Decisions as new, and leaves out Brief facts a Decision superseded", () => {
    const yaml = consistencyToYaml(returnsBrief(), afterRoundTwo());
    expect(yaml).toMatch(/^new:\n {2}- id: DEC-1/);
    expect(yaml).toContain("id: BR-2");
    expect(yaml).not.toContain("id: BR-1");
    expect(yaml).not.toContain("decided:");
  });
});

describe("checkConflicts", () => {
  test("accepts a conflict that involves a new Decision and names only what is in force", () => {
    const state = afterRoundTwo();
    expect(newDecisions(state).map((d) => d.id)).toEqual(["DEC-1", "DEC-2"]);
    const result = checkConflicts(returnsBrief(), state, { conflicts: [conflict(["DEC-2", "BR-2"])] }, ctx);
    expect(result.issues).toEqual([]);
    expect(result.accepted).toHaveLength(1);
  });

  test("rejects conflicts without a new Decision, with unknown or superseded ids, declared replacements and repeats", () => {
    const state = afterRoundTwo();
    const result = checkConflicts(
      returnsBrief(),
      state,
      {
        conflicts: [
          conflict(["BR-2", "FEAT-1"]),
          conflict(["DEC-2", "DEC-9"]),
          conflict(["DEC-1", "BR-1"]),
          conflict(["DEC-2", "BR-2"]),
          conflict(["BR-2", "DEC-2"]),
        ],
      },
      ctx,
    );
    expect(result.issues.map((i) => [i.path, i.errors])).toEqual([
      ["conflicts[0]", ["names no Decision from <new>: only conflicts involving this round's Decisions are checked"]],
      ["conflicts[1]", ["DEC-9 is neither an active Decision nor a Brief fact in force"]],
      ["conflicts[2]", ["BR-1 is neither an active Decision nor a Brief fact in force", "DEC-1 already supersedes BR-1: that is a correction, not a conflict"]],
      ["conflicts[4]", ["the same conflict is listed twice"]],
    ]);
    expect(result.accepted.map((c) => c.ids)).toEqual([["DEC-2", "BR-2"]]);
  });

  test("Decisions drawn from the same Answer are one statement and never conflict among themselves", () => {
    const state = applyRound(afterRoundOne(), {
      n: 2,
      final: false,
      prepare: [],
      accepted: accepted({
        decisions: [
          dec("DEC-1", "R1/CTR-1", ["CTR-1"], { conclusion: "取消期限為下單後 7 天", supersedes: ["BR-1"] }),
          dec("DEC-2", "R1/CTR-1", ["CTR-1"], { conclusion: "VIP 會員可於下單後 14 天內取消", relatedIds: ["BR-2"] }),
        ],
      }),
      ordering: "t",
    });
    const result = checkConflicts(
      returnsBrief(),
      state,
      { conflicts: [conflict(["DEC-1", "DEC-2"]), conflict(["DEC-1", "DEC-2", "BR-2"]), conflict(["DEC-1", "DEC-2", "FEAT-1"]), conflict(["DEC-2", "BR-2"])] },
      ctx,
    );
    expect(result.issues).toEqual([
      { path: "conflicts[0]", errors: ["DEC-1, DEC-2 come from the same Answer R1/CTR-1: they are one statement of the user, read together"] },
      { path: "conflicts[1]", errors: ["DEC-1, DEC-2 come from the same Answer R1/CTR-1, which is about BR-2: they are one statement of the user, read together"] },
    ]);
    // FEAT-1 is a fact the Answer did not speak about; one Decision against a fact is checked by the prompt, not here.
    expect(result.accepted.map((c) => c.ids)).toEqual([
      ["DEC-1", "DEC-2", "FEAT-1"],
      ["DEC-2", "BR-2"],
    ]);
  });

  test("a conflict already raised is not raised again; text in the wrong language is kept with a warning, never retried", () => {
    const state = addConflicts(afterRoundTwo(), [conflict(["DEC-2", "BR-2"])], { final: false, maxDepth: 2 });
    const again = checkConflicts(returnsBrief(), state, { conflicts: [conflict(["BR-2", "DEC-2"])] }, ctx);
    expect(again.issues[0]?.errors).toEqual(["this conflict was already raised as FQ-1"]);
    const english = checkConflicts(returnsBrief(), afterRoundTwo(), { conflicts: [conflict(["DEC-1", "DEC-2"], { question: "Which one of these two decisions holds for cancelling orders now?" })] }, ctx);
    expect(english.issues).toEqual([]);
    expect(english.accepted).toHaveLength(1);
    expect(english.languageWarnings).toEqual(["conflicts[0]"]);
  });
});

describe("addConflicts", () => {
  test("adds each conflict as a question asked next, recorded with the round so replay rebuilds it", () => {
    const state = addConflicts(afterRoundTwo(), [conflict(["DEC-2", "BR-2"])], { final: false, maxDepth: 2 });
    expect(findItem(state, "FQ-1")).toMatchObject({ kind: "FQ", origin: "conflict", status: "pending", relatedIds: ["DEC-2", "BR-2"], depth: 1 });
    expect(state.rounds.at(-1)?.conflicts?.map((c) => [c.id, c.status])).toEqual([["FQ-1", "pending"]]);
    expect(replay(returnsBrief(), state)).toEqual(state);
  });

  test("in the closing round, or when settling a conflict leads to another past the limit, it cannot be asked", () => {
    expect(addConflicts(afterRoundTwo(), [conflict(["DEC-2", "BR-2"])], { final: true, maxDepth: 2 }).rounds.at(-1)?.conflicts?.[0]?.status).toBe("unresolved");

    // FQ-1 (depth 1) is asked and settled by DEC-3, which then conflicts with DEC-1: depth 2.
    let state = addConflicts(afterRoundTwo(), [conflict(["DEC-2", "BR-2"])], { final: false, maxDepth: 2 });
    state = markAsked(state, ["FQ-1"], "t");
    state = recordAnswers(state, [{ type: "response", itemId: "FQ-1", kind: "text", text: "以 BR-2 為準" }], meta);
    state = applyRound(state, {
      n: 3,
      final: false,
      prepare: [],
      accepted: accepted({ decisions: [dec("DEC-3", "R2/FQ-1", ["FQ-1"], { conclusion: "鑑賞期依 BR-2 為 7 天", revises: ["DEC-2"] })], prepared: [] }),
      ordering: "t",
    });
    const deeper = addConflicts(state, [conflict(["DEC-3", "DEC-1"])], { final: false, maxDepth: 1 });
    expect(deeper.rounds.at(-1)?.conflicts?.[0]).toMatchObject({ id: "FQ-2", depth: 2, status: "unresolved" });
    expect(addConflicts(state, [conflict(["DEC-3", "DEC-1"])], { final: false, maxDepth: 2 }).rounds.at(-1)?.conflicts?.[0]?.status).toBe("pending");
  });
});

describe("conflictSides", () => {
  test("shows a Decision with the Answer it came from, and a fact by its text", () => {
    let state = applyRound(afterRoundTwo(), { n: 3, final: false, prepare: ["OQ-2"], accepted: accepted({ prepared: [prep("OQ-2")] }), ordering: "t" });
    state = addConflicts(state, [conflict(["DEC-2", "BR-2"])], { final: false, maxDepth: 2 });
    const sides = conflictSides(returnsBrief(), state, findItem(state, "FQ-1")!);
    expect(sides).toEqual([
      { id: "DEC-2", text: "鑑賞期為 7 天", answer: "R1/OQ-3: 鑑賞期就是 7 天那個" },
      { id: "BR-2", text: expect.stringContaining("下單後 7 天內可取消") },
    ]);
  });
});
