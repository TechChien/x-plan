import { describe, expect, test } from "vitest";
import { close, recordAnswers } from "../src/clarify/agenda.ts";
import { buildAligned } from "../src/clarify/aligned.ts";
import { applyRound } from "../src/clarify/apply.ts";
import { renderAlignedMarkdown, renderTranscript } from "../src/clarify/render.ts";
import type { ClarifyState } from "../src/clarify/schema.ts";
import { returnsBrief } from "./helpers/brief.ts";
import { accepted, afterRoundOne, ask, dec, meta } from "./helpers/clarify.ts";

/** Round 2 decides CTR-1 (two Decisions), OQ-2 and OQ-3 (confirming ASM-2); round 3 revises the VIP Decision; then /done. */
function finished(): ClarifyState {
  let state = applyRound(afterRoundOne(), {
    n: 2,
    final: false,
    prepare: [],
    accepted: accepted({
      decisions: [
        dec("DEC-1", "R1/CTR-1", ["CTR-1"], { conclusion: "一般會員 7 天", supersedes: ["BR-1"] }),
        dec("DEC-2", "R1/CTR-1", ["CTR-1"], { conclusion: "VIP 14 天" }),
        dec("DEC-3", "R1/OQ-2", ["OQ-2"], { conclusion: "賣家負擔運費", confirms: ["ASM-2"] }),
        dec("DEC-4", "R1/OQ-3", ["OQ-3"], { conclusion: "鑑賞期即 7 天", relatedIds: ["FEAT-2"] }),
      ],
    }),
    ordering: "t",
  });
  state = recordAnswers(ask(state, ["OQ-1"]), [{ type: "response", itemId: "OQ-1", kind: "defer", text: "問法務" }, { type: "note", text: "VIP 是 10 天", target: "DEC-2" }], meta);
  state = applyRound(state, { n: 4, final: true, prepare: [], accepted: accepted({ decisions: [dec("DEC-5", "R3/NOTE-1", ["NOTE-1"], { conclusion: "VIP 10 天", revises: ["DEC-2"] })] }), ordering: "t" });
  return close(state, "done");
}

describe("buildAligned", () => {
  const aligned = buildAligned(returnsBrief(), finished());

  test("carries the Brief unchanged", () => {
    expect(aligned.brief).toEqual(returnsBrief());
    expect(aligned).toMatchObject({ outputLanguage: "zh", termination: "done" });
  });

  test("maps superseded and confirmed Brief items to the active Decisions that did it", () => {
    expect(aligned.supersededBy).toEqual({ "BR-1": ["DEC-1"] });
    expect(aligned.confirmedBy).toEqual({ "ASM-2": ["DEC-3"] });
  });

  test("derives each Decision's effect and quotes the Answer it stands on", () => {
    expect(aligned.decisions.map((d) => [d.id, d.status, d.effect, d.answerText])).toEqual([
      ["DEC-1", "active", "replace", "以 7 天為準，3 天是舊版；VIP 是 14 天"],
      ["DEC-2", "revised", "reconcile", "以 7 天為準，3 天是舊版；VIP 是 14 天"],
      ["DEC-3", "active", "confirm", "建議 OQ-2"],
      ["DEC-4", "active", "new", "鑑賞期就是 7 天那個"],
      ["DEC-5", "active", "new", "VIP 是 10 天"],
    ]);
  });

  test("lists every Agenda Item with its final status and the user's words", () => {
    const byId = Object.fromEntries(aligned.agenda.map((a) => [a.id, a]));
    expect(byId["OQ-1"]).toMatchObject({ status: "deferred", answers: [{ ref: "R1/OQ-1", kind: "later", text: "" }, { ref: "R3/OQ-1", kind: "defer", text: "問法務" }] });
    expect(byId["OQ-4"]).toMatchObject({ status: "unresolved", answers: [] });
    expect(byId["CTR-1"]).toMatchObject({ status: "decided", resolvedBy: ["DEC-1", "DEC-2"] });
    expect(byId["NOTE-1"]).toMatchObject({ kind: "NOTE", status: "decided", target: "DEC-2" });
  });
});

describe("render", () => {
  test("the transcript shows each round's decisions, questions and answers in order", () => {
    const md = renderTranscript(finished());
    const order = ["## Round 1", "**CTR-1**", "以 7 天為準", "## Round 2", "DEC-1", "## Round 3", "⏸ deferred: 問法務", "NOTE-1", "## Closing round", "DEC-5"];
    const positions = order.map((s) => md.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("the aligned Markdown lists active Decisions, superseded facts and open items", () => {
    const md = renderAlignedMarkdown(buildAligned(returnsBrief(), finished()));
    expect(md).toContain("BR-1");
    expect(md).toMatch(/DEC-5.*VIP 10 天/);
    expect(md).not.toMatch(/DEC-2.*VIP 14 天.*\n.*active/);
    expect(md).toMatch(/OQ-1.*deferred/);
    expect(md).toMatch(/OQ-4.*unresolved/);
  });
});
