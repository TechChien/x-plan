import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import { FeatureSubmissionSchema, OutlineSubmissionSchema } from "../src/write/schema.ts";

describe("submit_outline", () => {
  const outline = {
    features: [
      {
        featureId: "FEAT-2",
        rules: [{ sourceId: "BR-3", title: "到貨 7 天內可退貨", scenarios: [{ title: "到貨第 2 天申請退貨", kind: "specified", sourceIds: ["AC-1"], agendaIds: [] }] }],
        scenarios: [{ title: "退貨頁面", kind: "open", sourceIds: ["FEAT-2"], agendaIds: ["OQ-4"] }],
      },
      {
        newFeature: { name: "管理者強制退貨", description: "管理者可以對任何訂單強制退貨", sourceIds: ["DEC-9"] },
        rules: [],
        scenarios: [{ title: "管理者強制退貨", kind: "specified", sourceIds: ["DEC-9"], agendaIds: [] }],
      },
    ],
    notBehavioral: [{ id: "DEC-4", reason: "名詞定義" }],
  };

  test("accepts the shape in the plan", () => {
    expect(Value.Check(OutlineSubmissionSchema, outline)).toBe(true);
  });

  test("has no field beyond the plan's", () => {
    expect(Value.Check(OutlineSubmissionSchema, { ...outline, steps: [] })).toBe(false);
  });

  test("a scenario's kind is one of the four", () => {
    const bad = structuredClone(outline);
    bad.features[0]!.scenarios[0]!.kind = "guess";
    expect(Value.Check(OutlineSubmissionSchema, bad)).toBe(false);
  });
});

describe("submit_feature", () => {
  const feature = {
    description: "會員可以申請退貨",
    background: [],
    scenarios: [
      {
        id: "SCN-1",
        steps: [
          { keyword: "Given", text: "會員等級為 <等級>", sourceIds: ["ACT-1"] },
          { keyword: "When", text: "會員申請退貨", sourceIds: ["FEAT-2"] },
          { keyword: "Then", text: "系統<結果>退貨申請", sourceIds: ["BR-3"], dataTable: [["a", "b"]] },
        ],
        examples: [{ name: "需求明定", derived: false, header: ["等級", "結果"], rows: [{ cells: ["一般", "接受"], sourceIds: ["BR-3"] }] }],
      },
      { id: "SCN-2", openReason: "outline 沒給失敗時的行為", steps: [], examples: [] },
    ],
  };

  test("accepts the shape in the plan", () => {
    expect(Value.Check(FeatureSubmissionSchema, feature)).toBe(true);
  });

  test("a step keyword is Given, When, Then, And or But", () => {
    const bad = structuredClone(feature);
    bad.scenarios[0]!.steps[0]!.keyword = "Then if";
    expect(Value.Check(FeatureSubmissionSchema, bad)).toBe(false);
  });
});
