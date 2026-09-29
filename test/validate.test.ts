import { describe, expect, test } from "vitest";
import { SourceIndex } from "../src/extract/evidence.ts";
import { checkFacts, dropInvalid } from "../src/extract/validate.ts";
import { actor, ev, feature, rule } from "./helpers/facts.ts";

const index = new SourceIndex([{ path: "prd.md", converted: false, text: "會員\n會員可取消訂單\n3 天內可取消\n客服人員" }]);
const ctx = { index, allowedFiles: new Set(["prd.md"]) };

describe("checkFacts", () => {
  test("a clean submission has no issues", () => {
    const r = checkFacts(
      { actors: [actor("ACT-1", "會員", [ev("prd.md", 1, "會員")])], features: [feature("FEAT-1", "取消訂單", [ev("prd.md", 2, "會員可取消訂單")], ["ACT-1"])] },
      ctx,
    );
    expect(r.issues).toEqual([]);
  });

  test("reports bad quotes, foreign files, wrong prefixes, duplicate ids and dangling or mistyped references", () => {
    const r = checkFacts(
      {
        actors: [actor("ACT-1", "會員", [ev("prd.md", 1, "訪客")]), actor("ACT-1", "客服", [ev("faq.md", 1, "客服")])],
        features: [feature("F-1", "取消", [ev("prd.md", 2, "會員可取消訂單")], ["ACT-9", "BR-1"])],
        businessRules: [rule("BR-1", "3 天", [ev("prd.md", 3, "3 天內可取消")])],
      },
      ctx,
    );
    const messages = r.issues.flatMap((i) => i.errors.map((e) => `${i.section}[${i.index}] ${e}`));
    expect(messages).toEqual([
      'actors[0] id "ACT-1" is used more than once',
      'actors[0] evidence[0]: quote not found in prd.md: "訪客"',
      'actors[1] id "ACT-1" is used more than once',
      'actors[1] evidence[0]: file "faq.md" was not provided in this batch',
      'features[0] id "F-1" must match FEAT-<number>',
      'features[0] actorIds: "ACT-9" does not exist',
      'features[0] actorIds: "BR-1" must be a ACT id',
    ]);
  });

  test("counts relocated evidence and returns the corrected line numbers", () => {
    const r = checkFacts({ actors: [actor("ACT-1", "客服", [ev("prd.md", 1, "客服人員")])] }, ctx);
    expect(r.issues).toEqual([]);
    expect(r.relocated).toBe(1);
    expect(r.facts.actors![0]!.evidence[0]!.lineStart).toBe(4);
  });
});

describe("dropInvalid", () => {
  test("removes items with issues, prunes references to them, and cascades single required references", () => {
    const facts = {
      actors: [actor("ACT-1", "會員", [ev("prd.md", 1, "會員")])],
      features: [feature("FEAT-1", "取消", [ev("prd.md", 2, "x")], ["ACT-1"])],
      businessRules: [rule("BR-1", "3 天", [ev("prd.md", 3, "3 天內可取消")], ["FEAT-1"])],
      acceptanceCriteria: [{ id: "AC-1", featureId: "FEAT-1", kind: "hint" as const, text: "t", evidence: [ev("prd.md", 3, "3 天內可取消")] }],
    };
    const { facts: kept, dropped } = dropInvalid(facts, [{ section: "features", index: 0, id: "FEAT-1", errors: ["bad quote"] }]);
    expect(kept.features).toEqual([]);
    expect(kept.businessRules![0]!.featureIds).toEqual([]);
    expect(kept.acceptanceCriteria).toEqual([]);
    expect(dropped.map((d) => [d.section, d.errors[0]])).toEqual([
      ["features", "bad quote"],
      ["acceptanceCriteria", "featureId points to a rejected item"],
    ]);
  });
});
