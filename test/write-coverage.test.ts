import { describe, expect, test } from "vitest";
import { coverageSets, uncovered } from "../src/write/coverage.ts";
import { rule } from "./helpers/facts.ts";
import { alignedDec, alignedFixture } from "./helpers/write.ts";

describe("coverageSets", () => {
  const sets = coverageSets(alignedFixture());

  test("every Feature not superseded gets a .feature", () => {
    expect(sets.features).toEqual(["FEAT-1", "FEAT-2"]);
  });

  test("must cover Features, rules, criteria, Non-functional Requirements and every active Decision", () => {
    expect(sets.mustCover).toEqual(["FEAT-1", "FEAT-2", "BR-2", "BR-3", "AC-1", "AC-2", "NFR-1", "DEC-1", "DEC-3", "DEC-4", "DEC-5", "DEC-6"]);
  });

  test("a confirm Decision is also covered by citing the Assumption it confirms", () => {
    expect(sets.coveredVia).toEqual(new Map([["DEC-3", ["ASM-2"]]]));
    expect(uncovered(sets, ["ASM-2"])).not.toContain("DEC-3");
    expect(uncovered(sets, ["DEC-3"])).not.toContain("DEC-3");
  });

  test("a superseded Non-functional Requirement need not be covered", () => {
    const aligned = alignedFixture();
    aligned.supersededBy["NFR-1"] = ["DEC-1"];
    const sets = coverageSets(aligned);
    expect(sets.mustCover).not.toContain("NFR-1");
    expect(sets.notBehavioralAllowed).not.toContain("NFR-1");
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

  test("Non-functional Requirements and Decisions that replace no behaviour may be marked not behavioural", () => {
    // DEC-1 replaces a Business Rule; DEC-6 replaces a Term that DEC-4 uses (below). DEC-3 confirms an Assumption.
    expect(sets.notBehavioralAllowed).toEqual(["NFR-1", "DEC-3", "DEC-4", "DEC-5"]);
  });

  test("a reconciling Decision settles a contradiction between behaviours, so it cannot be marked not behavioural", () => {
    const aligned = alignedFixture();
    aligned.decisions.push(alignedDec("DEC-7", { effect: "reconcile", relatedIds: ["BR-2", "BR-3"], resolves: ["CTR-1"] }));
    expect(coverageSets(aligned).notBehavioralAllowed).not.toContain("DEC-7");
    expect(coverageSets(aligned).mustCover).toContain("DEC-7");
  });
});

describe("a Decision that replaces a Term", () => {
  test("may be marked not behavioural when nothing that must be covered uses the term", () => {
    const aligned = alignedFixture();
    aligned.decisions.find((d) => d.id === "DEC-4")!.conclusion = "退貨期自到貨日起算";
    const sets = coverageSets(aligned);
    expect(sets.notBehavioralAllowed).toContain("DEC-6");
    expect(sets.notBehavioralBlocked.has("DEC-6")).toBe(false);
  });

  test("carries behaviour when a Feature, rule, criterion or other Decision uses the term, so it must be cited", () => {
    const sets = coverageSets(alignedFixture());
    expect(sets.notBehavioralAllowed).not.toContain("DEC-6");
    expect(sets.notBehavioralBlocked.get("DEC-6")).toEqual({ terms: ["鑑賞期"], mentionedIn: ["DEC-4"] });
  });

  test("an alias counts as a use of the term", () => {
    const aligned = alignedFixture();
    aligned.decisions.find((d) => d.id === "DEC-4")!.conclusion = "退貨期自到貨日起算";
    aligned.brief.glossary[0]!.aliases = ["猶豫期"];
    aligned.brief.businessRules.push(rule("BR-5", "猶豫期內可無條件退貨", [], ["FEAT-2"]));
    expect(coverageSets(aligned).notBehavioralBlocked.get("DEC-6")).toEqual({ terms: ["鑑賞期", "猶豫期"], mentionedIn: ["BR-5"] });
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
    expect(uncovered(sets, ["FEAT-1", "FEAT-2", "BR-2", "AC-1", "DEC-1", "DEC-4", "DEC-6"])).toEqual(["BR-3", "AC-2", "NFR-1", "DEC-3", "DEC-5"]);
  });
});
