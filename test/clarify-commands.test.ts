import { describe, expect, test } from "vitest";
import { parseInput } from "../src/clarify/commands.ts";

const options = ["下單日", "到貨日"];

describe("parseInput", () => {
  test.each([
    ["賣家負擔", { type: "response", itemId: "OQ-2", kind: "text", text: "賣家負擔" }],
    ["  /ok ", { type: "response", itemId: "OQ-2", kind: "accept", text: "" }],
    ["/later", { type: "response", itemId: "OQ-2", kind: "later", text: "" }],
    ["/defer", { type: "response", itemId: "OQ-2", kind: "defer", text: "" }],
    ["/defer 要問法務", { type: "response", itemId: "OQ-2", kind: "defer", text: "要問法務" }],
    ["/na", { type: "response", itemId: "OQ-2", kind: "na", text: "" }],
    ["/2", { type: "response", itemId: "OQ-2", kind: "text", text: "到貨日" }],
    ["/done", { type: "done" }],
    ["/note DEC-2 VIP 是 10 天", { type: "note", target: "DEC-2", text: "VIP 是 10 天" }],
    ["/note 退款要三天內完成", { type: "note", text: "退款要三天內完成" }],
  ])("%j", (line, expected) => {
    expect(parseInput(line, { itemId: "OQ-2", options })).toEqual({ input: expected });
  });

  test.each([
    ["", /empty/],
    ["/3", /no option 3/],
    ["/skip", /unknown command \/skip/],
    ["/note", /note needs text/],
  ])("%j is an error", (line, expected) => {
    expect(parseInput(line, { itemId: "OQ-2", options }).error).toMatch(expected);
  });
});
