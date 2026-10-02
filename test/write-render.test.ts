import { describe, expect, test } from "vitest";
import type { AlignedBrief } from "../src/clarify/aligned.ts";
import { buildTrace, gherkinErrors, renderFeature, renderSpec } from "../src/write/render.ts";
import type { WriteOutline, WrittenFeature } from "../src/write/schema.ts";
import { alignedDec, alignedFixture, outlineFixture, step, writtenFixture } from "./helpers/write.ts";

function fixture() {
  const aligned = alignedFixture();
  const outline = outlineFixture(aligned);
  return { aligned, outline, written: writtenFixture(aligned, outline) };
}

function featureText(featureId: string, f: { aligned: AlignedBrief; outline: WriteOutline; written: Map<string, WrittenFeature> }) {
  return renderFeature(f.outline.features.find((x) => x.id === featureId)!, { ...f, written: f.written.get(featureId), language: "zh" });
}

describe("renderFeature", () => {
  test("a written Feature: tags, Background, scenarios without a Rule before the Rules, a Scenario Outline and a deferred scenario's closing Then", () => {
    expect(featureText("FEAT-1", fixture())).toBe(
      [
        "@FEAT-1",
        "Feature: 取消訂單",
        "  會員可以取消訂單",
        "",
        "  Background:",
        "    Given 會員已登入",
        "",
        "  @SCN-4 @deferred @OQ-1 @FEAT-1",
        "  Scenario: 已出貨的訂單取消",
        "    Given 訂單已出貨",
        "    When 會員取消訂單",
        "    Then <延後 OQ-1：已出貨的訂單如何處理？>",
        "",
        "  Rule: 一般會員 7 天內可取消",
        "",
        "    @SCN-1 @AC-2 @BR-2 @DEC-1",
        "    Scenario: 下單當天取消",
        "      Given 會員在下單當天",
        "      When 會員取消訂單",
        "      Then 系統接受取消",
        "",
        "    @SCN-2 @derived @DEC-1",
        "    Scenario Outline: 下單第 8 天取消被拒",
        "      Given 一般會員下單已 <天數> 天",
        "      When 會員取消訂單",
        "      Then 系統拒絕取消",
        "",
        "      @derived",
        "      Examples: 邊界",
        "        | 天數 |",
        "        | 8    |",
        "",
        "  Rule: VIP 10 天內可取消",
        "",
        "    @SCN-3 @DEC-5",
        "    Scenario: VIP 第 10 天取消",
        "      Given VIP 會員下單已 10 天",
        "      When 會員取消訂單",
        "      Then 系統接受取消",
        "",
      ].join("\n"),
    );
  });

  test("a Feature with no writer result keeps its outline as unwritten scenarios", () => {
    const text = featureText("FEAT-2", fixture());
    expect(text).toContain("    @SCN-5 @unwritten @AC-1 @DEC-6 @BR-3\n    Scenario: 到貨第 2 天申請退貨\n");
    expect(text).toContain("  @SCN-6 @open @unwritten @OQ-4 @FEAT-2\n  Scenario: 退貨頁面的內容\n");
    expect(text).toContain("  @SCN-7 @unwritten @nfr @NFR-1\n  Scenario: 退貨申請的回應時間\n");
    expect(gherkinErrors(text)).toEqual([]);
  });

  test("an open scenario closes with a Then naming what is open, in the output language", () => {
    const f = fixture();
    f.written.set("FEAT-2", {
      featureId: "FEAT-2",
      description: "會員可以申請退貨",
      background: [],
      scenarios: [{ id: "SCN-6", kind: "open", steps: [step("Given", "會員有一筆退貨", ["FEAT-2"])], examples: [] }],
    });
    expect(featureText("FEAT-2", f)).toContain("    Given 會員有一筆退貨\n    Then <待決 OQ-4：退貨頁面要顯示什麼？>\n");
    const en = renderFeature(f.outline.features[1]!, { ...f, written: f.written.get("FEAT-2"), language: "en" });
    expect(en).toContain("    Then <open OQ-4: 退貨頁面要顯示什麼？>\n");
  });

  test("a scenario the writer could not write names the writer's reason", () => {
    const f = fixture();
    const s = f.written.get("FEAT-1")!.scenarios[0]!;
    Object.assign(s, { kind: "open", openReason: "沒有說明取消後的狀態", steps: [step("Given", "會員在下單當天", ["AC-2"])] });
    expect(featureText("FEAT-1", f)).toContain("    @SCN-1 @open @AC-2 @BR-2 @DEC-1\n    Scenario: 下單當天取消\n      Given 會員在下單當天\n      Then <待決：沒有說明取消後的狀態>\n");
  });

  test("an unverified scenario is tagged so", () => {
    const f = fixture();
    f.written.get("FEAT-1")!.scenarios[2]!.unverified = ["14 is not given by DEC-5"];
    expect(featureText("FEAT-1", f)).toContain("    @SCN-3 @unverified @DEC-5\n");
  });

  test("a Feature Clarify added carries its Decision and says where it came from", () => {
    const f = fixture();
    f.outline.features.push({ id: "FEAT-N1", isNew: true, name: "管理者強制退貨", description: "管理者可以強制退貨", sourceIds: ["DEC-4"], rules: [], scenarioIds: [] });
    expect(featureText("FEAT-N1", f)).toBe(["@FEAT-N1 @DEC-4", "Feature: 管理者強制退貨", "  管理者可以強制退貨", "  此功能來自 Clarify 的決定，需求文件中沒有對應段落。", ""].join("\n"));
  });

  test("text that Gherkin would read as syntax is made safe", () => {
    const f = fixture();
    const w = f.written.get("FEAT-1")!;
    w.description = "第一行\nScenario: 看起來像關鍵字\n@看起來像標籤\n| 看起來像表格 |";
    w.background = [{ ...step("Given", "會員\n已登入", ["ACT-1"]), dataTable: [["欄|位", "值\\"], ["a", "b"]] }];
    const text = featureText("FEAT-1", f);
    expect(gherkinErrors(text)).toEqual([]);
    expect(text).toContain("      | 欄\\|位 | 值\\\\ |\n");
    expect(text).toContain("    Given 會員 已登入\n");
  });

  test("every rendering in this file parses as Gherkin", () => {
    const f = fixture();
    for (const feature of f.outline.features) expect(gherkinErrors(featureText(feature.id, f))).toEqual([]);
  });
});

describe("gherkinErrors", () => {
  test("reports what the parser rejects", () => {
    expect(gherkinErrors("Feature: x\n  Scenario: y\n    Given a\n      | a | b |\n      | 1 |\n")).toEqual([expect.stringMatching(/inconsistent cell count/)]);
  });
});

describe("buildTrace", () => {
  test("records every scenario with what it stands on, step by step and row by row", () => {
    const f = fixture();
    const trace = buildTrace(f.outline, f.written);
    expect(trace.scenarios.map((s) => [s.id, s.status])).toEqual([
      ["SCN-1", "written"],
      ["SCN-2", "written"],
      ["SCN-3", "written"],
      ["SCN-4", "written"],
      ["SCN-5", "unwritten"],
      ["SCN-6", "unwritten"],
      ["SCN-7", "unwritten"],
    ]);
    expect(trace.scenarios[1]).toMatchObject({
      featureId: "FEAT-1",
      kind: "derived",
      sourceIds: ["DEC-1"],
      steps: [{ keyword: "Given", text: "一般會員下單已 <天數> 天", sourceIds: ["DEC-1"] }, expect.anything(), expect.anything()],
      examples: [{ name: "邊界", derived: true, rows: [{ cells: ["8"], sourceIds: ["DEC-1"] }] }],
    });
    expect(trace.features).toEqual([
      { id: "FEAT-1", written: true, background: [{ keyword: "Given", text: "會員已登入", sourceIds: ["ACT-1"] }] },
      { id: "FEAT-2", written: false, background: [] },
    ]);
  });
});

describe("renderSpec", () => {
  function spec(mutate?: (f: ReturnType<typeof fixture>) => void) {
    const f = fixture();
    mutate?.(f);
    return renderSpec(f);
  }

  test("lists each .feature with its scenario counts", () => {
    expect(spec()).toContain("| [FEAT-1.feature](features/FEAT-1.feature) | 取消訂單 | 4 | 0 | 1 | 1 | 0 | 0 |");
    expect(spec()).toContain("| [FEAT-2.feature](features/FEAT-2.feature) | 申請退貨 | 3 | 1 | 0 | 0 | 0 | 3 |");
  });

  test("lists the Brief's non-behavioural facts, a replaced one under its Decision", () => {
    const md = spec();
    expect(md).toMatch(/## Actors[\s\S]*- \*\*ACT-1\*\* 會員/);
    expect(md).toMatch(/## Non-functional requirements[\s\S]*- \*\*NFR-1\*\* \(performance\) 退貨申請 2 秒內回應 — target: 2s/);
  });

  test("lists cancelled and added Features with the user's words", () => {
    const md = spec((f) => {
      f.aligned.decisions.push(alignedDec("DEC-7", { conclusion: "本版不做退貨", supersedes: ["FEAT-2"], effect: "replace", answerText: "退貨下一版再說" }));
      f.aligned.supersededBy["FEAT-2"] = ["DEC-7"];
      f.outline.features.push({ id: "FEAT-N1", isNew: true, name: "管理者強制退貨", description: "d", sourceIds: ["DEC-4"], rules: [], scenarioIds: [] });
    });
    expect(md).toMatch(/## Cancelled Features[\s\S]*- \*\*FEAT-2\*\* 申請退貨 — DEC-7: 本版不做退貨 \(“退貨下一版再說”\)/);
    expect(md).toMatch(/## Features added in Clarify[\s\S]*- \*\*FEAT-N1\*\* 管理者強制退貨 — DEC-4: 鑑賞期即 7 天退貨期/);
  });

  test("lists what is not written as a scenario, what is uncovered and what is still open", () => {
    const md = spec((f) => {
      f.outline.uncovered = ["DEC-5"];
      f.aligned.agenda.push({ id: "OQ-9", kind: "OQ", origin: "brief", status: "unresolved", question: "要支援多語系嗎？", relatedIds: [], answers: [] });
    });
    expect(md).toMatch(/## Not written as scenarios[\s\S]*- \*\*DEC-4\*\* 鑑賞期即 7 天退貨期 — 只是名詞定義/);
    expect(md).toMatch(/## Uncovered[\s\S]*- \*\*DEC-5\*\* VIP 10 天內可取消/);
    expect(md).toMatch(/## Open items[\s\S]*- SCN-4 @deferred OQ-1: 已出貨的訂單如何處理？/);
    expect(md).toMatch(/## Open items[\s\S]*- SCN-6 @open OQ-4: 退貨頁面要顯示什麼？/);
    expect(md).toMatch(/## Open items[\s\S]*- OQ-9 \(unresolved, in no scenario\): 要支援多語系嗎？/);
  });

  test("lists unverified scenarios with the reasons, and unwritten ones", () => {
    const md = spec((f) => (f.written.get("FEAT-1")!.scenarios[2]!.unverified = ["14 is not given by DEC-5"]));
    expect(md).toMatch(/## Unverified[\s\S]*- SCN-3 VIP 第 10 天取消: 14 is not given by DEC-5/);
    expect(md).toMatch(/## Unwritten[\s\S]*- FEAT-2: no writer result/);
  });
});
