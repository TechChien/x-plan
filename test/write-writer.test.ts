import { describe, expect, test } from "vitest";
import type { AlignedBrief } from "../src/clarify/aligned.ts";
import { contextIds, coverageSets } from "../src/write/coverage.ts";
import type { FeatureSubmission } from "../src/write/schema.ts";
import { checkFeature, numbersIn } from "../src/write/writer.ts";
import { alignedFixture, outlineFixture, step, validFeature } from "./helpers/write.ts";

function check(submission: FeatureSubmission, opts: { isLast?: boolean; aligned?: AlignedBrief; featureId?: string } = {}) {
  const aligned = opts.aligned ?? alignedFixture();
  return checkFeature(submission, {
    aligned,
    sets: coverageSets(aligned),
    outline: outlineFixture(aligned),
    featureId: opts.featureId ?? "FEAT-1",
    isLast: opts.isLast ?? false,
    language: "zh",
  });
}

const messages = (result: ReturnType<typeof check>) => result.issues.flatMap((i) => i.errors.map((e) => `${i.path}: ${e}`));

function edit(mutate: (f: FeatureSubmission) => void): FeatureSubmission {
  const f = validFeature();
  mutate(f);
  return f;
}

describe("contextIds", () => {
  test("Actors, Terms, Entities and Dependencies that can be cited, and the Decisions that replaced one", () => {
    const aligned = alignedFixture();
    expect([...contextIds(aligned, coverageSets(aligned))]).toEqual(["ACT-1", "DEC-6"]);
  });
});

describe("checkFeature", () => {
  test("a feature that follows its outline passes, each scenario keeping the outline's kind", () => {
    const result = check(validFeature());
    expect(messages(result)).toEqual([]);
    expect(result.accepted.scenarios.map((s) => [s.id, s.kind])).toEqual([
      ["SCN-1", "specified"],
      ["SCN-2", "derived"],
      ["SCN-3", "specified"],
      ["SCN-4", "deferred"],
    ]);
    expect(result.missing).toEqual([]);
  });

  describe("rule 1: exactly the outline's scenarios", () => {
    test("a missing, foreign or repeated scenario is reported", () => {
      const result = check(
        edit((f) => {
          f.scenarios.splice(3, 1);
          f.scenarios.push({ ...f.scenarios[0]!, id: "SCN-5" }, { ...f.scenarios[0]! });
        }),
      );
      expect(messages(result)).toEqual([
        "scenarios[3]: SCN-5 is not a scenario of FEAT-1",
        "scenarios[4]: SCN-1 is written twice",
        "scenarios: SCN-4 is missing",
      ]);
    });

    test("on the last attempt what is missing is left for the stage to mark", () => {
      const result = check(edit((f) => f.scenarios.splice(3, 1)), { isLast: true });
      expect(result.missing).toEqual(["SCN-4"]);
      expect(result.accepted.scenarios.map((s) => s.id)).toEqual(["SCN-1", "SCN-2", "SCN-3"]);
    });
  });

  describe("rule 2: a step cites only its scenario's sources and the shared context", () => {
    test("an item the outline did not give this scenario is refused", () => {
      const result = check(edit((f) => f.scenarios[0]!.steps[2]!.sourceIds.push("DEC-5")));
      expect(messages(result)).toEqual(["scenarios[0].steps[2]: DEC-5 is not in <sources> for SCN-1 or in <context>"]);
    });

    test("a superseded item says what to cite instead, in steps and in Examples rows", () => {
      const result = check(
        edit((f) => {
          f.scenarios[0]!.steps[0]!.sourceIds.push("BR-1");
          f.scenarios[1]!.examples[0]!.rows[0]!.sourceIds.push("TERM-1");
        }),
      );
      expect(messages(result)).toEqual([
        "scenarios[0].steps[0]: BR-1 was replaced by DEC-1; cite DEC-1 instead",
        "scenarios[1].examples[0].rows[0]: TERM-1 was replaced by DEC-6; cite DEC-6 instead",
      ]);
    });

    test("Actors and the Decision that redefined a Term are context every scenario may cite", () => {
      expect(messages(check(edit((f) => f.scenarios[0]!.steps[0]!.sourceIds.push("ACT-1", "DEC-6"))))).toEqual([]);
    });

    test("the Background may cite what any scenario of the Feature stands on", () => {
      expect(messages(check(edit((f) => f.background[0]!.sourceIds.push("DEC-5"))))).toEqual([]);
      expect(messages(check(edit((f) => f.background[0]!.sourceIds.push("BR-3"))))).toEqual(["background[0]: BR-3 is not in <sources> for any scenario of FEAT-1 or in <context>"]);
    });

    test("on the last attempt such a scenario is set aside", () => {
      const result = check(edit((f) => f.scenarios[0]!.steps[2]!.sourceIds.push("DEC-5")), { isLast: true });
      expect(result.accepted.scenarios.map((s) => s.id)).toEqual(["SCN-2", "SCN-3", "SCN-4"]);
      expect(result.rejected).toEqual([expect.objectContaining({ path: "scenarios[0]" })]);
    });
  });

  describe("rule 3: Scenario Outline", () => {
    test("every column is used in the steps and every row has a cell per column", () => {
      const result = check(
        edit((f) => {
          const ex = f.scenarios[1]!.examples[0]!;
          ex.header.push("結果");
          ex.rows.push({ cells: ["9", "拒絕", "多的"], sourceIds: ["DEC-1"] });
        }),
      );
      expect(messages(result)).toEqual([
        "scenarios[1].examples[0]: column 結果 is not used as <結果> in any step",
        "scenarios[1].examples[0]: row 0 has 1 cells for 2 columns",
        "scenarios[1].examples[0]: row 1 has 3 cells for 2 columns",
      ]);
    });

    test("a derived scenario has derived Examples only", () => {
      const result = check(edit((f) => (f.scenarios[1]!.examples[0]!.derived = false)));
      expect(messages(result)).toEqual(["scenarios[1].examples[0]: SCN-2 is derived, so every Examples block is derived"]);
    });

    test("a placeholder with no column is a value left open, not an error", () => {
      expect(messages(check(edit((f) => (f.scenarios[0]!.steps[0]!.text = "會員買了 <任一一般商品>"))))).toEqual([]);
    });

    test("on the last attempt a broken table is set aside, since it would not render", () => {
      const result = check(edit((f) => f.scenarios[1]!.examples[0]!.rows[0]!.cells.push("x")), { isLast: true });
      expect(result.accepted.scenarios.map((s) => s.id)).not.toContain("SCN-2");
    });
  });

  describe("rule 4: numbers stated as required come from what the step cites", () => {
    test("a number the cited items do not give is refused", () => {
      const result = check(edit((f) => (f.scenarios[2]!.steps[0]!.text = "VIP 會員下單已 14 天")));
      expect(messages(result)).toEqual(["scenarios[2].steps[0]: 14 is not given by DEC-5; cite the item that gives it, or write <…> for a value no item gives"]);
    });

    test("full-width digits in the step and Chinese numerals in the source are read as numbers", () => {
      const aligned = alignedFixture();
      aligned.decisions.find((d) => d.id === "DEC-5")!.conclusion = "VIP 十天內可取消";
      expect(messages(check(edit((f) => (f.scenarios[2]!.steps[0]!.text = "VIP 會員下單已 １０ 天")), { aligned }))).toEqual([]);
    });

    test("a number in a stated Examples row comes from the row's sources", () => {
      const result = check(
        edit((f) => {
          f.scenarios[0]!.steps[0]!.text = "會員在下單後第 <天數> 天";
          f.scenarios[0]!.examples = [{ name: "需求明定", derived: false, header: ["天數"], rows: [{ cells: ["3"], sourceIds: ["DEC-1"] }] }];
        }),
      );
      expect(messages(result)).toEqual(["scenarios[0].examples[0].rows[0]: 3 is not given by DEC-1; cite the item that gives it, or write <…> for a value no item gives"]);
    });

    test("a number only an Evidence quote gives does not count: the quote may carry what the user replaced", () => {
      // FEAT-1 is quoted from "會員可於下單後 3 天內取消訂單。", the sentence of the replaced 3-day rule.
      const result = check(edit((f) => (f.scenarios[0]!.steps[1]!.text = "會員在下單後 3 天內取消訂單")));
      expect(messages(result)).toEqual(["scenarios[0].steps[1]: 3 is not given by FEAT-1; cite the item that gives it, or write <…> for a value no item gives"]);
    });

    test("digits inside an identifier, such as an endpoint path, are not numbers", () => {
      expect(messages(check(edit((f) => (f.scenarios[0]!.steps[1]!.text = "會員透過 POST /api/v1/orders 取消訂單"))))).toEqual([]);
    });

    test("a number in a name every step is written with counts as given, but not one a Decision in <context> gives", () => {
      const aligned = alignedFixture();
      aligned.brief.actors[0]!.description = "以 CPE 2.3 識別的購買者";
      expect(messages(check(edit((f) => (f.scenarios[0]!.steps[1]!.text = "會員取消 CPE 2.3 訂單")), { aligned }))).toEqual([]);
      // DEC-6 is in <context> because it replaced TERM-1, but its 7 days is a rule, not a name.
      expect(messages(check(edit((f) => (f.scenarios[0]!.steps[1]!.text = "會員在下單後 7 天內取消訂單"))))).toEqual([
        "scenarios[0].steps[1]: 7 is not given by FEAT-1; cite the item that gives it, or write <…> for a value no item gives",
      ]);
    });

    test("derived content and placeholders are not checked", () => {
      expect(messages(check(edit((f) => (f.scenarios[1]!.steps[0]!.text = "一般會員下單已 <天數> 天，金額 <超過 1000 元>"))))).toEqual([]);
    });

    test("on the last attempt the scenario is kept and marked unverified", () => {
      const result = check(edit((f) => (f.scenarios[2]!.steps[0]!.text = "VIP 會員下單已 14 天")), { isLast: true });
      expect(result.accepted.scenarios[2]).toMatchObject({ id: "SCN-3", unverified: [expect.stringMatching(/14 is not given by DEC-5/)] });
    });
  });

  describe("rule 5: a writer may turn a scenario it cannot write into an open one", () => {
    test("a specified or derived scenario becomes open with the writer's reason", () => {
      const result = check(edit((f) => ((f.scenarios[0]!.openReason = "沒有說明取消後的狀態"), (f.scenarios[0]!.steps = []))));
      expect(messages(result)).toEqual([]);
      expect(result.accepted.scenarios[0]).toMatchObject({ id: "SCN-1", kind: "open", openReason: "沒有說明取消後的狀態" });
    });

    test("a scenario already open or deferred takes no reason", () => {
      const result = check(edit((f) => (f.scenarios[3]!.openReason = "x")));
      expect(messages(result)).toEqual(["scenarios[3]: SCN-4 is already deferred; openReason is only for a specified or derived scenario"]);
    });
  });

  describe("steps", () => {
    test("a specified or derived scenario says what happens with a Then", () => {
      const result = check(edit((f) => f.scenarios[0]!.steps.pop()));
      expect(messages(result)).toEqual(["scenarios[0]: SCN-1 has no Then step"]);
    });

    test("an open or deferred scenario stops before Then: the program adds the Then that names what is open", () => {
      const result = check(edit((f) => f.scenarios[3]!.steps.push(step("Then", "系統拒絕取消", ["FEAT-1"]))));
      expect(messages(result)).toEqual(["scenarios[3]: SCN-4 is deferred, so it has no Then step: the program adds one naming OQ-1"]);
    });
  });

  describe("rule 6: language", () => {
    test("text in the wrong script is reported but kept", () => {
      const result = check(edit((f) => (f.scenarios[0]!.steps[1]!.text = "會員取消订单")), { isLast: true });
      expect(messages(result)).toEqual(["scenarios[0]: not written in Traditional Chinese (繁體中文): text"]);
      expect(result.languageWarnings).toEqual(["scenarios[0]"]);
      expect(result.accepted.scenarios[0]!.steps[1]!.text).toBe("會員取消订单");
    });

    test("names from the documents, placeholders and quoted values are left as written", () => {
      const aligned = alignedFixture();
      aligned.brief.actors[0]!.name = "订单系统";
      const result = check(edit((f) => (f.scenarios[0]!.steps[1]!.text = "订单系统收到「订单编号」與 <订单>")), { aligned });
      expect(messages(result)).toEqual([]);
    });
  });
});

describe("numbersIn", () => {
  test("reads Arabic and full-width digits, and Chinese numerals when asked", () => {
    expect(numbersIn("第 7 天、１０ 天、2.5 秒")).toEqual(["7", "10", "2.5"]);
    expect(numbersIn("七天、十天、十五天、二十天、兩天", { chinese: true })).toEqual(["7", "10", "15", "20", "2"]);
    expect(numbersIn("一般會員")).toEqual([]);
  });

  test("skips digits inside identifiers, but reads a number with a unit after it", () => {
    expect(numbersIn("POST /api/v1/inventory/collect、cpe_23、v0.7.17、x86_64、HTTP/2")).toEqual([]);
    expect(numbersIn("回應 2s、上限 5GB、第3天")).toEqual(["2", "5", "3"]);
  });
});
