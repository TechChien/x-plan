import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { feedbackAction, formatFeedback, recordFeedback, resolveAuthor, type FeedbackRequest } from "../src/feedback/feedback.ts";
import { readFeedback, standing } from "../src/feedback/store.ts";
import { returnsBrief } from "./helpers/brief.ts";

const TRACE = "a".repeat(32);
const SPANS = { "facts-bin1": "1".repeat(16), "facts-bin2": "2".repeat(16), analysis: "3".repeat(16) };

/** An Extract Run over prd.md (bin 1, lines 1-180) and prd.md 131-300 plus faq.md (bin 2). */
function extractRun(opts: { traced?: boolean; status?: string } = {}): string {
  const dir = join(mkdtempSync(join(tmpdir(), "xplan-fb-")), "extract-20261001-1000-a1b2c3");
  mkdirSync(dir);
  writeFileSync(join(dir, "01-brief.json"), JSON.stringify(returnsBrief()));
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({
      stage: "extract",
      status: opts.status ?? "succeeded",
      bins: [
        { index: 1, segments: [{ path: "prd.md", lines: "1-180", part: "1/2" }] },
        { index: 2, segments: [{ path: "prd.md", lines: "131-300", part: "2/2" }, { path: "faq.md", lines: "1-40" }], context: ["prd.md"] },
      ],
      provenance: {
        "BR-1": { text: "facts-bin1", evidence: ["facts-bin1", "facts-bin2"], mergedBy: ["dedup"] },
        "OQ-3": { text: "analysis", evidence: ["analysis"] },
      },
      ...(opts.traced === false ? {} : { telemetry: { traces: [{ traceId: TRACE, rootSpanId: "f".repeat(16), startedAt: "2026-10-01T10:00:00Z", spans: SPANS }] } }),
    }),
  );
  return dir;
}

const by = (author = "redchien", at = "2026-10-01T12:00:00Z") => ({ author, now: new Date(at) });
const record = (dir: string, request: FeedbackRequest, author?: string) => recordFeedback(dir, request, by(author));

describe("recordFeedback", () => {
  test("a verdict on an item keeps a snapshot of it and points at the span whose text it kept", () => {
    const dir = extractRun();
    const { entry } = record(dir, { type: "item", target: "BR-1", verdict: "wrong", note: "是 7 天" });
    expect(entry).toEqual({
      id: "FB-1",
      createdAt: "2026-10-01T12:00:00.000Z",
      author: "redchien",
      type: "item",
      target: "BR-1",
      section: "businessRules",
      verdict: "wrong",
      note: "是 7 天",
      snapshot: returnsBrief().businessRules[0],
      trace: { traceId: TRACE, spanId: SPANS["facts-bin1"], otherSources: ["facts-bin2"] },
    });
    expect(readFeedback(dir)).toEqual([entry]);
  });

  test("verdicts depend on the kind of item, and only ok goes without a note", () => {
    const dir = extractRun();
    expect(() => record(dir, { type: "item", target: "BR-1", verdict: "redundant", note: "x" })).toThrow("BR-1 takes --ok, --wrong, --partial, not --redundant");
    expect(() => record(dir, { type: "item", target: "CTR-1", verdict: "partial", note: "x" })).toThrow("CTR-1 takes --ok, --wrong, not --partial");
    expect(() => record(dir, { type: "item", target: "OQ-3", verdict: "redundant" })).toThrow("--redundant needs a note");
    expect(record(dir, { type: "item", target: "OQ-3", verdict: "redundant", note: "faq 有寫" }).entry).toMatchObject({ trace: { spanId: SPANS.analysis } });
    expect(record(dir, { type: "item", target: "ASM-1", verdict: "ok" }).entry).not.toHaveProperty("note");
    expect(() => record(dir, { type: "item", target: "ACT-9", verdict: "ok" })).toThrow("No item ACT-9 in the Brief of Run extract-20261001-1000-a1b2c3");
  });

  test("the same author's second verdict on an item supersedes the first; another author's stands beside it", () => {
    const dir = extractRun();
    record(dir, { type: "item", target: "BR-1", verdict: "wrong", note: "x" });
    record(dir, { type: "item", target: "BR-1", verdict: "ok" }, "qa");
    const again = record(dir, { type: "item", target: "BR-1", verdict: "partial", note: "y" });
    expect(again.replaces).toBe("FB-1");
    expect(again.entry).toMatchObject({ id: "FB-3", supersedes: "FB-1" });
    expect(standing(readFeedback(dir)).map((e) => e.id)).toEqual(["FB-2", "FB-3"]);
  });

  test("missing facts never supersede each other", () => {
    const dir = extractRun();
    record(dir, { type: "missing", text: "VIP 免運" });
    record(dir, { type: "missing", text: "運費 60 元" });
    expect(standing(readFeedback(dir))).toHaveLength(2);
  });

  test("--at finds the bins that read the line, overlap included, context excluded", () => {
    const dir = extractRun();
    expect(record(dir, { type: "missing", text: "a", at: "prd.md:57" }).entry).toMatchObject({ at: "prd.md:57", trace: { spanId: SPANS["facts-bin1"] } });
    expect(record(dir, { type: "missing", text: "b", at: "prd.md:150" }).entry).toMatchObject({ trace: { spanId: SPANS["facts-bin1"], otherSources: ["facts-bin2"] } });
    expect(record(dir, { type: "missing", text: "c", at: "faq.md:3" }).entry).toMatchObject({ trace: { spanId: SPANS["facts-bin2"] } });
    expect(record(dir, { type: "missing", text: "d" }).entry).toMatchObject({ trace: { traceId: TRACE } });
    expect(record(dir, { type: "missing", text: "d" }).entry).not.toHaveProperty("trace.spanId");
    expect(() => record(dir, { type: "missing", text: "e", at: "spec.md:3" })).toThrow("read no spec.md; its documents are prd.md, faq.md");
    expect(() => record(dir, { type: "missing", text: "e", at: "faq.md:99" })).toThrow("faq.md has no line 99 in Run extract-20261001-1000-a1b2c3; it read lines 1-40");
    expect(() => record(dir, { type: "missing", text: "e", at: "faq.md" })).toThrow("--at must be file:line");
  });

  test("a score is 1 to 5 and a second one by the same author replaces the first", () => {
    const dir = extractRun();
    expect(() => record(dir, { type: "score", score: 6 })).toThrow("from 1 to 5");
    expect(() => record(dir, { type: "score", score: 2.5 })).toThrow("from 1 to 5");
    record(dir, { type: "score", score: 3 });
    expect(record(dir, { type: "score", score: 4, note: "還不錯" })).toMatchObject({ replaces: "FB-1", entry: { score: 4, note: "還不錯", trace: { traceId: TRACE } } });
  });

  test("a retraction withdraws a standing entry, once", () => {
    const dir = extractRun();
    record(dir, { type: "missing", text: "VIP 免運" });
    expect(record(dir, { type: "retract", id: "FB-1", note: "其實有" }).entry).toMatchObject({ id: "FB-2", type: "retract", retracts: "FB-1" });
    expect(standing(readFeedback(dir))).toEqual([]);
    expect(() => record(dir, { type: "retract", id: "FB-1" })).toThrow("FB-1 was already superseded or retracted");
    expect(() => record(dir, { type: "retract", id: "FB-2" })).toThrow("No Feedback FB-2");
  });

  test("a Run that was not traced still takes Feedback, without a trace", () => {
    const dir = extractRun({ traced: false });
    expect(record(dir, { type: "item", target: "BR-1", verdict: "ok" }).entry).not.toHaveProperty("trace");
  });

  test("a failed Run takes Feedback with a warning", () => {
    expect(record(extractRun({ status: "failed" }), { type: "score", score: 1 }).warnings).toEqual([
      "Run extract-20261001-1000-a1b2c3 has status failed; the Feedback is recorded against its output as it is",
    ]);
  });

  test("a Clarify Run takes a score and missing facts, not item verdicts or --at", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "xplan-fb-")), "clarify-20261001-1100-d4e5f6");
    mkdirSync(dir);
    const traces = [
      { traceId: "b".repeat(32), rootSpanId: "c".repeat(16), startedAt: "", spans: {} },
      { traceId: "d".repeat(32), rootSpanId: "e".repeat(16), startedAt: "", spans: {} },
    ];
    writeFileSync(join(dir, "run.json"), JSON.stringify({ stage: "clarify", status: "succeeded", telemetry: { traces } }));
    expect(record(dir, { type: "score", score: 5 }).entry).toMatchObject({ trace: { traceId: "d".repeat(32) } });
    expect(record(dir, { type: "missing", text: "沒問運費" }).entry.type).toBe("missing");
    expect(() => record(dir, { type: "item", target: "DEC-1", verdict: "ok" })).toThrow("not supported yet; use --score or --missing");
    expect(() => record(dir, { type: "missing", text: "x", at: "prd.md:3" })).toThrow("--at applies only to Extract Runs");
  });

  test("the list shows what stands", () => {
    const dir = extractRun();
    record(dir, { type: "item", target: "BR-1", verdict: "wrong", note: "是 7 天" });
    record(dir, { type: "missing", text: "VIP 免運", at: "prd.md:57" });
    record(dir, { type: "score", score: 4 });
    record(dir, { type: "retract", id: "FB-2" });
    expect(formatFeedback(readFeedback(dir), () => "pending")).toEqual([
      "FB-1  BR-1 wrong: 是 7 天  — redchien, 2026-10-01  [pending]",
      "FB-3  score 4  — redchien, 2026-10-01  [pending]",
    ]);
    expect(readFileSync(join(dir, "feedback.jsonl"), "utf8").trim().split("\n")).toHaveLength(4);
  });
});

describe("feedbackAction", () => {
  test("one verdict on an item", () => {
    expect(feedbackAction("ACT-3", { wrong: "外部系統" })).toEqual({ action: "record", request: { type: "item", target: "ACT-3", verdict: "wrong", note: "外部系統" } });
    expect(feedbackAction("ACT-3", { ok: true, note: "對" })).toEqual({ action: "record", request: { type: "item", target: "ACT-3", verdict: "ok", note: "對" } });
    expect(() => feedbackAction("ACT-3", {})).toThrow("Give ACT-3 one verdict");
    expect(() => feedbackAction("ACT-3", { ok: true, wrong: "x" })).toThrow("Give ACT-3 one verdict");
    expect(() => feedbackAction(undefined, { wrong: "x" })).toThrow("--wrong needs the item");
    expect(() => feedbackAction("ACT-3", { wrong: "x", note: "y" })).toThrow("--note goes with --ok, --score or --retract");
  });

  test("the other actions, one at a time", () => {
    expect(feedbackAction(undefined, { missing: "VIP 免運", at: "prd.md:57" })).toEqual({ action: "record", request: { type: "missing", text: "VIP 免運", at: "prd.md:57" } });
    expect(feedbackAction(undefined, { score: 4, note: "ok" })).toEqual({ action: "record", request: { type: "score", score: 4, note: "ok" } });
    expect(feedbackAction(undefined, { retract: "FB-3" })).toEqual({ action: "record", request: { type: "retract", id: "FB-3" } });
    expect(feedbackAction(undefined, { list: true })).toEqual({ action: "list" });
    expect(feedbackAction(undefined, { sync: true })).toEqual({ action: "sync" });
    expect(() => feedbackAction(undefined, {})).toThrow("Nothing to do");
    expect(() => feedbackAction("ACT-3", { ok: true, score: 3 })).toThrow("not <item> --verdict and --score");
    expect(() => feedbackAction(undefined, { score: 3, at: "a.md:1" })).toThrow("--at goes with --missing");
  });
});

describe("resolveAuthor", () => {
  test("XPLAN_AUTHOR first, then git, then the OS user", () => {
    expect(resolveAuthor({ XPLAN_AUTHOR: " pm-amy " })).toBe("pm-amy");
    expect(resolveAuthor({}, tmpdir()).length).toBeGreaterThan(0);
  });
});
