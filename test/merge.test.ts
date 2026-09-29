import { describe, expect, test } from "vitest";
import { mergeFacts } from "../src/extract/merge.ts";
import { actor, ev, feature } from "./helpers/facts.ts";

describe("mergeFacts", () => {
  test("renumbers ids across bins and rewrites each bin's references", () => {
    const { facts, idMaps } = mergeFacts([
      { actors: [actor("ACT-1", "會員", [ev("a.md", 1, "會員")])], features: [feature("FEAT-1", "取消", [ev("a.md", 2, "取消")], ["ACT-1"])] },
      { actors: [actor("ACT-1", "客服", [ev("b.md", 1, "客服")])], features: [feature("FEAT-1", "退貨", [ev("b.md", 2, "退貨")], ["ACT-1"])] },
    ]);
    expect(facts.actors.map((a) => [a.id, a.name])).toEqual([
      ["ACT-1", "會員"],
      ["ACT-2", "客服"],
    ]);
    expect(facts.features.map((f) => [f.id, f.actorIds])).toEqual([
      ["FEAT-1", ["ACT-1"]],
      ["FEAT-2", ["ACT-2"]],
    ]);
    expect(idMaps[1]!.get("FEAT-1")).toBe("FEAT-2");
  });

  test("folds exact-name duplicates, keeping the first text and uniting evidence", () => {
    const { facts, deduped } = mergeFacts([
      { actors: [actor("ACT-1", "會員", [ev("a.md", 1, "會員")])] },
      { actors: [actor("ACT-1", " 會員 ", [ev("b.md", 3, "會員")])], features: [feature("FEAT-1", "退貨", [ev("b.md", 2, "退貨")], ["ACT-1"])] },
    ]);
    expect(facts.actors).toHaveLength(1);
    expect(facts.actors[0]!.evidence.map((e) => e.file)).toEqual(["a.md", "b.md"]);
    expect(deduped.get("ACT-2")).toBe("ACT-1");
    expect(facts.features[0]!.actorIds).toEqual(["ACT-1"]);
  });
});
