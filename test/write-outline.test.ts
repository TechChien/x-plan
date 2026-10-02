import { describe, expect, test } from "vitest";
import type { AlignedBrief } from "../src/clarify/aligned.ts";
import { coverageSets } from "../src/write/coverage.ts";
import { applyOutline, checkOutline } from "../src/write/outline.ts";
import type { OutlineFeature, OutlineScenario, OutlineSubmission } from "../src/write/schema.ts";
import { alignedFixture } from "./helpers/write.ts";

const scn = (title: string, kind: OutlineScenario["kind"], sourceIds: string[], extra: Partial<OutlineScenario> = {}): OutlineScenario => ({
  title,
  kind,
  sourceIds,
  agendaIds: [],
  ...extra,
});

/** Covers everything the fixture requires: FEAT-1/2, BR-2/3, AC-1/2, DEC-1/5/6, with DEC-4 marked not behavioural. */
function validOutline(): OutlineSubmission {
  return {
    features: [
      {
        featureId: "FEAT-1",
        rules: [
          {
            sourceId: "DEC-1",
            title: "一般會員 7 天內可取消",
            scenarios: [scn("下單當天取消", "specified", ["AC-2", "BR-2"]), scn("下單第 8 天取消被拒", "derived", [])],
          },
          { sourceId: "DEC-5", title: "VIP 10 天內可取消", scenarios: [scn("VIP 第 10 天取消", "specified", [])] },
        ],
        scenarios: [scn("已出貨的訂單取消", "deferred", ["FEAT-1"], { agendaIds: ["OQ-1"] })],
      },
      {
        featureId: "FEAT-2",
        rules: [{ sourceId: "BR-3", title: "鑑賞期內可退貨", scenarios: [scn("到貨第 2 天申請退貨", "specified", ["AC-1", "DEC-6"])] }],
        scenarios: [scn("退貨頁面的內容", "open", ["FEAT-2"], { agendaIds: ["OQ-4"] }), scn("退貨申請的回應時間", "specified", ["NFR-1"])],
      },
    ],
    notBehavioral: [{ id: "DEC-4", reason: "只是名詞定義" }],
  };
}

function check(submission: OutlineSubmission, opts: { isLast?: boolean; aligned?: AlignedBrief } = {}) {
  const aligned = opts.aligned ?? alignedFixture();
  return checkOutline(submission, { aligned, sets: coverageSets(aligned), isLast: opts.isLast ?? false, language: "zh" });
}

const messages = (result: ReturnType<typeof check>) => result.issues.flatMap((i) => i.errors.map((e) => `${i.path}: ${e}`));

function edit(mutate: (o: OutlineSubmission) => void): OutlineSubmission {
  const o = validOutline();
  mutate(o);
  return o;
}

describe("checkOutline", () => {
  test("a complete outline passes untouched", () => {
    const result = check(validOutline());
    expect(messages(result)).toEqual([]);
    expect(result.accepted).toEqual(validOutline());
    expect(result.uncovered).toEqual([]);
  });

  describe("rule 1: one block per Feature", () => {
    test("an unknown, superseded or repeated Feature is refused", () => {
      const aligned = alignedFixture();
      aligned.supersededBy["FEAT-1"] = ["DEC-1"];
      const result = check(
        edit((o) => {
          o.features.push({ featureId: "FEAT-9", rules: [], scenarios: [scn("x", "specified", ["BR-3"])] });
          o.features.push({ ...o.features[1]! });
        }),
        { aligned },
      );
      expect(messages(result)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^features\[0\]: FEAT-1 was replaced by DEC-1/),
          expect.stringMatching(/^features\[2\]: FEAT-9 is not a Feature/),
          expect.stringMatching(/^features\[3\]: FEAT-2 already has a block/),
        ]),
      );
    });

    test("a block names either a Feature or a new Feature, not both or neither", () => {
      const result = check(
        edit((o) => {
          o.features[0]!.newFeature = { name: "n", description: "d", sourceIds: ["DEC-4"] };
          delete o.features[1]!.featureId;
        }),
      );
      expect(messages(result)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^features\[0\]: .*either featureId or newFeature/), expect.stringMatching(/^features\[1\]: .*either featureId or newFeature/)]),
      );
    });

    test("a Feature with no block, or a block with no scenario, is uncovered", () => {
      const result = check(edit((o) => o.features.splice(1, 1)));
      expect(result.uncovered).toEqual(expect.arrayContaining(["FEAT-2", "BR-3", "AC-1", "DEC-6"]));
      const empty = check(edit((o) => ((o.features[1]!.rules = []), (o.features[1]!.scenarios = []))));
      expect(empty.uncovered).toContain("FEAT-2");
    });
  });

  describe("rule 2: a new Feature stands on a new Decision", () => {
    const withNew = (sourceIds: string[]): OutlineFeature => ({
      newFeature: { name: "管理者強制退貨", description: "管理者可以強制退貨", sourceIds },
      rules: [],
      scenarios: [scn("管理者強制退貨", "specified", sourceIds)],
    });

    test("accepted when it cites an active Decision whose effect is new", () => {
      expect(messages(check(edit((o) => o.features.push(withNew(["DEC-4"])))))).toEqual([]);
    });

    test("refused when it stands on anything else", () => {
      expect(messages(check(edit((o) => o.features.push(withNew(["DEC-1"])))))).toEqual([
        expect.stringMatching(/^features\[2\]: a new Feature must cite an active Decision whose effect is new/),
      ]);
    });
  });

  describe("rule 3: coverage", () => {
    test("everything that must be covered and is not is reported as one issue", () => {
      const result = check(edit((o) => o.features[0]!.rules.splice(1, 1)));
      expect(result.uncovered).toEqual(["DEC-5"]);
      expect(messages(result)).toEqual([expect.stringMatching(/^coverage: .*DEC-5/)]);
    });

    test("on the last attempt the rest is accepted and the gap is kept", () => {
      const result = check(edit((o) => o.features[0]!.rules.splice(1, 1)), { isLast: true });
      expect(result.accepted.features[0]!.rules).toHaveLength(1);
      expect(result.uncovered).toEqual(["DEC-5"]);
    });

    test("a Feature id cited in another Feature's scenario does not cover that Feature", () => {
      const result = check(
        edit((o) => {
          o.features[0]!.scenarios[0]!.sourceIds.push("FEAT-2");
          o.features.splice(1, 1);
        }),
      );
      expect(result.uncovered).toContain("FEAT-2");
    });
  });

  describe("rule 4: what a scenario may cite", () => {
    test("a superseded item is refused with the Decision to cite instead", () => {
      const result = check(edit((o) => o.features[0]!.rules[0]!.scenarios[1]!.sourceIds.push("BR-1")));
      expect(messages(result)).toEqual([expect.stringMatching(/^features\[0\]\.rules\[0\]\.scenarios\[1\]: BR-1 was replaced by DEC-1; cite DEC-1 instead/)]);
    });

    test("a refused scenario no longer covers what it cited", () => {
      const result = check(edit((o) => o.features[0]!.rules[0]!.scenarios[0]!.sourceIds.push("BR-1")));
      expect(result.uncovered).toEqual(["BR-2", "AC-2"]);
    });

    test("an unconfirmed Assumption, a revised Decision, a question or an unknown id is refused", () => {
      const result = check(edit((o) => o.features[1]!.scenarios[1]!.sourceIds.push("ASM-1", "DEC-2", "OQ-4", "XYZ-1")));
      const text = messages(result).join("\n");
      expect(text).toMatch(/ASM-1 is an Assumption the user never confirmed/);
      expect(text).toMatch(/DEC-2 was corrected by DEC-5; cite DEC-5 instead/);
      expect(text).toMatch(/OQ-4 is an Agenda Item: list it in agendaIds/);
      expect(text).toMatch(/XYZ-1 is not an id in <aligned>/);
    });

    test("a specified or derived scenario must stand on something", () => {
      const result = check(edit((o) => o.features[1]!.scenarios.push(scn("憑空的情境", "specified", []))));
      expect(messages(result)).toEqual([expect.stringMatching(/^features\[1\]\.scenarios\[2\]: .*cites nothing/)]);
    });

    test("on the last attempt a scenario that cites what it may not is set aside", () => {
      const result = check(
        edit((o) => o.features[0]!.rules[0]!.scenarios[1]!.sourceIds.push("BR-1")),
        { isLast: true },
      );
      expect(result.accepted.features[0]!.rules[0]!.scenarios.map((s) => s.title)).toEqual(["下單當天取消"]);
      expect(result.rejected).toEqual([expect.objectContaining({ path: "features[0].rules[0].scenarios[1]", errors: [expect.stringMatching(/BR-1/)] })]);
    });
  });

  test("rule 5: an Acceptance Criterion is covered only by a specified scenario", () => {
    const result = check(edit((o) => (o.features[1]!.rules[0]!.scenarios[0]!.kind = "derived")));
    expect(result.uncovered).toEqual(["AC-1"]);
    expect(messages(result)).toEqual([expect.stringMatching(/^coverage: .*AC-1.*specified/)]);
  });

  describe("rule 6: not behavioural", () => {
    test("only Decisions allowed to be, each with a reason", () => {
      const result = check(edit((o) => o.notBehavioral.push({ id: "DEC-1", reason: "x" }, { id: "DEC-5", reason: " " })));
      expect(messages(result)).toEqual([
        expect.stringMatching(/^notBehavioral\[1\]: DEC-1 cannot be marked not behavioural/),
        expect.stringMatching(/^notBehavioral\[2\]: .*reason/),
      ]);
    });

    test("a Decision redefining a name that something else uses is refused, saying where it is used", () => {
      const result = check(edit((o) => o.notBehavioral.push({ id: "DEC-6", reason: "名詞" })));
      expect(messages(result)).toEqual([expect.stringMatching(/^notBehavioral\[1\]: DEC-6 redefines 鑑賞期, which DEC-4 uses/)]);
    });
  });

  describe("rule 7: open and deferred scenarios", () => {
    test("a deferred scenario names a deferred item, an open one an unresolved item", () => {
      const result = check(
        edit((o) => {
          o.features[0]!.scenarios[0]!.agendaIds = ["OQ-4"];
          o.features[1]!.scenarios[0]!.agendaIds = ["OQ-1"];
        }),
      );
      expect(messages(result)).toEqual([
        expect.stringMatching(/^features\[0\]\.scenarios\[0\]: OQ-4 is unresolved, not deferred/),
        expect.stringMatching(/^features\[1\]\.scenarios\[0\]: OQ-1 is deferred, not unresolved/),
      ]);
    });

    test("an open scenario with no Agenda Item says what is missing", () => {
      const ok = check(edit((o) => o.features[1]!.scenarios.push(scn("查詢退貨進度", "open", ["FEAT-2"], { openReason: "缺少驗收條件" }))));
      expect(messages(ok)).toEqual([]);
      const bad = check(edit((o) => o.features[1]!.scenarios.push(scn("查詢退貨進度", "open", ["FEAT-2"]))));
      expect(messages(bad)).toEqual([expect.stringMatching(/^features\[1\]\.scenarios\[2\]: .*openReason/)]);
    });

    test("a specified or derived scenario names no Agenda Item", () => {
      const result = check(edit((o) => (o.features[1]!.scenarios[1]!.agendaIds = ["OQ-4"])));
      expect(messages(result)).toEqual([expect.stringMatching(/^features\[1\]\.scenarios\[1\]: .*only open and deferred scenarios/)]);
    });
  });

  test("rule 8: a Non-functional Requirement without a target is not a scenario unless a Decision gives one", () => {
    const aligned = alignedFixture();
    delete aligned.brief.nonFunctional[0]!.target;
    expect(messages(check(validOutline(), { aligned }))).toEqual([expect.stringMatching(/^features\[1\]\.scenarios\[1\]: NFR-1 has no target/)]);
    const withDecision = edit((o) => o.features[1]!.scenarios[1]!.sourceIds.push("DEC-4"));
    expect(messages(check(withDecision, { aligned }))).toEqual([]);
  });

  describe("rule 9: Rule blocks", () => {
    test("a Rule stands for a Business Rule or an active Decision, once per Feature", () => {
      const result = check(
        edit((o) => {
          o.features[1]!.rules.push({ sourceId: "AC-1", title: "x", scenarios: [] });
          o.features[1]!.rules.push({ sourceId: "BR-3", title: "y", scenarios: [] });
        }),
      );
      expect(messages(result)).toEqual([
        expect.stringMatching(/^features\[1\]\.rules\[1\]: AC-1 is not a Business Rule or an active Decision/),
        expect.stringMatching(/^features\[1\]\.rules\[2\]: BR-3 already has a Rule/),
      ]);
    });

    test("a Rule for a superseded rule is set aside with its scenarios on the last attempt", () => {
      const result = check(
        edit((o) => o.features[0]!.rules.push({ sourceId: "BR-1", title: "舊規則", scenarios: [scn("第 3 天取消", "specified", ["BR-2"])] })),
        { isLast: true },
      );
      expect(result.accepted.features[0]!.rules.map((r) => r.sourceId)).toEqual(["DEC-1", "DEC-5"]);
      expect(result.rejected[0]).toMatchObject({ path: "features[0].rules[2]" });
    });
  });

  test("rule 10: text in the wrong language is reported but kept", () => {
    const result = check(edit((o) => (o.features[0]!.rules[0]!.scenarios[0]!.title = "下單當天取消订单")), { isLast: true });
    expect(messages(result)).toEqual([expect.stringMatching(/^features\[0\]\.rules\[0\]\.scenarios\[0\]: not written in/)]);
    expect(result.languageWarnings).toEqual(["features[0].rules[0].scenarios[0]"]);
    expect(result.accepted.features[0]!.rules[0]!.scenarios[0]!.title).toBe("下單當天取消订单");
  });
});

describe("applyOutline", () => {
  const aligned = alignedFixture();
  const submission = edit((o) =>
    o.features.push({
      newFeature: { name: "管理者強制退貨", description: "管理者可以強制退貨", sourceIds: ["DEC-4"] },
      rules: [],
      scenarios: [scn("管理者強制退貨", "specified", ["DEC-4"])],
    }),
  );
  const outline = applyOutline(check(submission, { aligned }).accepted, aligned, []);

  test("numbers scenarios in reading order: each Rule's, then the Feature's own", () => {
    expect(outline.scenarios.map((s) => [s.id, s.featureId, s.title])).toEqual([
      ["SCN-1", "FEAT-1", "下單當天取消"],
      ["SCN-2", "FEAT-1", "下單第 8 天取消被拒"],
      ["SCN-3", "FEAT-1", "VIP 第 10 天取消"],
      ["SCN-4", "FEAT-1", "已出貨的訂單取消"],
      ["SCN-5", "FEAT-2", "到貨第 2 天申請退貨"],
      ["SCN-6", "FEAT-2", "退貨頁面的內容"],
      ["SCN-7", "FEAT-2", "退貨申請的回應時間"],
      ["SCN-8", "FEAT-N1", "管理者強制退貨"],
    ]);
  });

  test("a scenario in a Rule also stands on the Rule's source", () => {
    expect(outline.scenarios[1]).toMatchObject({ ruleIndex: 0, kind: "derived", sourceIds: [], effectiveSourceIds: ["DEC-1"] });
    expect(outline.scenarios[0]!.effectiveSourceIds).toEqual(["AC-2", "BR-2", "DEC-1"]);
  });

  test("Features carry their name and description; new ones are numbered FEAT-N and keep what they stand on", () => {
    expect(outline.features.map((f) => [f.id, f.isNew, f.name])).toEqual([
      ["FEAT-1", false, "取消訂單"],
      ["FEAT-2", false, "申請退貨"],
      ["FEAT-N1", true, "管理者強制退貨"],
    ]);
    expect(outline.features[2]).toMatchObject({ description: "管理者可以強制退貨", sourceIds: ["DEC-4"], rules: [], scenarioIds: ["SCN-8"] });
    expect(outline.features[0]!.rules).toEqual([
      { sourceId: "DEC-1", title: "一般會員 7 天內可取消", scenarioIds: ["SCN-1", "SCN-2"] },
      { sourceId: "DEC-5", title: "VIP 10 天內可取消", scenarioIds: ["SCN-3"] },
    ]);
    expect(outline.features[0]!.scenarioIds).toEqual(["SCN-4"]);
  });

  test("keeps what was marked not behavioural and what is still uncovered", () => {
    const kept = applyOutline(check(validOutline()).accepted, alignedFixture(), ["DEC-5"]);
    expect(kept.notBehavioral).toEqual([{ id: "DEC-4", reason: "只是名詞定義" }]);
    expect(kept.uncovered).toEqual(["DEC-5"]);
  });
});
