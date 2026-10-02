import { describe, expect, test } from "vitest";
import { coverageSets, uncovered } from "../src/write/coverage.ts";
import { rule } from "./helpers/facts.ts";
import { alignedDec, alignedFixture } from "./helpers/write.ts";

describe("coverageSets", () => {
  const sets = coverageSets(alignedFixture());

  test("every Feature not superseded gets a .feature", () => {
    expect(sets.features).toEqual(["FEAT-1", "FEAT-2"]);
  });

  test("must cover Features, rules, criteria and active Decisions that do more than confirm", () => {
    expect(sets.mustCover).toEqual(["FEAT-1", "FEAT-2", "BR-2", "BR-3", "AC-1", "AC-2", "DEC-1", "DEC-4", "DEC-5", "DEC-6"]);
  });

  test("superseded items, unconfirmed Assumptions and revised Decisions cannot be cited, each with the reason", () => {
    expect(Object.fromEntries(sets.forbidden)).toEqual({
      "BR-1": { kind: "superseded", by: ["DEC-1"] },
      "TERM-1": { kind: "superseded", by: ["DEC-6"] },
      "ASM-1": { kind: "unconfirmed-assumption" },
      "DEC-2": { kind: "revised-decision", by: "DEC-5" },
    });
  });

  test("facts, confirmed Assumptions and active Decisions can be cited; questions cannot", () => {
    for (const id of ["FEAT-1", "BR-2", "AC-1", "NFR-1", "ASM-2", "DEC-1", "DEC-3", "DEC-6"]) expect(sets.citable.has(id)).toBe(true);
    for (const id of ["BR-1", "TERM-1", "ASM-1", "DEC-2", "OQ-1", "CTR-1", "NOPE-1"]) expect(sets.citable.has(id)).toBe(false);
  });

  test("only Decisions that replace no behaviour may be marked not behavioural", () => {
    // DEC-1 replaces a Business Rule, DEC-3 only confirms; DEC-6 replaces a Term.
    expect(sets.notBehavioralAllowed).toEqual(["DEC-4", "DEC-5", "DEC-6"]);
  });

  test("a reconciling Decision settles a contradiction between behaviours, so it cannot be marked not behavioural", () => {
    const aligned = alignedFixture();
    aligned.decisions.push(alignedDec("DEC-7", { effect: "reconcile", relatedIds: ["BR-2", "BR-3"], resolves: ["CTR-1"] }));
    expect(coverageSets(aligned).notBehavioralAllowed).not.toContain("DEC-7");
    expect(coverageSets(aligned).mustCover).toContain("DEC-7");
  });
});

describe("a superseded Feature", () => {
  function cancelled() {
    const aligned = alignedFixture();
    aligned.brief.businessRules.push(rule("BR-4", "退貨與取消都要登入", [], ["FEAT-1", "FEAT-2"]));
    aligned.decisions.push(alignedDec("DEC-7", { conclusion: "本版不做退貨", supersedes: ["FEAT-2"], effect: "replace" }));
    aligned.supersededBy["FEAT-2"] = ["DEC-7"];
    return coverageSets(aligned);
  }

  test("gets no .feature, and its own rules and criteria go with it", () => {
    const sets = cancelled();
    expect(sets.features).toEqual(["FEAT-1"]);
    expect(sets.mustCover).not.toContain("BR-3");
    expect(sets.mustCover).not.toContain("AC-1");
    expect(sets.forbidden.get("BR-3")).toEqual({ kind: "cancelled-feature", featureIds: ["FEAT-2"], by: ["DEC-7"] });
    expect(sets.forbidden.get("AC-1")).toEqual({ kind: "cancelled-feature", featureIds: ["FEAT-2"], by: ["DEC-7"] });
  });

  test("a rule that also applies to a remaining Feature stays", () => {
    const sets = cancelled();
    expect(sets.mustCover).toContain("BR-4");
    expect(sets.citable.has("BR-4")).toBe(true);
  });
});

describe("uncovered", () => {
  test("lists what must be covered and is neither cited nor marked not behavioural, in mustCover order", () => {
    const sets = coverageSets(alignedFixture());
    expect(uncovered(sets, ["FEAT-1", "FEAT-2", "BR-2", "AC-1", "DEC-1", "DEC-4", "DEC-6"])).toEqual(["BR-3", "AC-2", "DEC-5"]);
  });
});
