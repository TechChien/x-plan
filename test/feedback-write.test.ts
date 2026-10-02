import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { recordFeedback, type FeedbackRequest } from "../src/feedback/feedback.ts";

const FIRST = "a".repeat(32);
const REWRITE = "b".repeat(32);
const SPANS = { first: { "write-outline": "0".repeat(16), "write-FEAT-1": "1".repeat(16), "write-FEAT-2": "2".repeat(16) }, rewrite: { "write-FEAT-2-only-20261001-120000": "3".repeat(16) } };

const scenario = (id: string, featureId: string, status: "written" | "unwritten") => ({
  id,
  featureId,
  title: `${id} 的標題`,
  kind: "specified",
  status,
  sourceIds: ["BR-2"],
  agendaIds: [],
  steps: status === "written" ? [{ keyword: "Then", text: "系統接受取消", sourceIds: ["BR-2"] }] : [],
  examples: [],
});

/** A Write Run: FEAT-1 written in the first process, FEAT-2 rewritten with --only in a second; SCN-6 unwritten. */
function writeRun(opts: { traced?: boolean } = {}): string {
  const dir = join(mkdtempSync(join(tmpdir(), "xplan-fb-write-")), "write-20261001-1100-c3d4e5");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "03-trace.json"),
    JSON.stringify({ features: [], scenarios: [scenario("SCN-1", "FEAT-1", "written"), scenario("SCN-5", "FEAT-2", "written"), scenario("SCN-6", "FEAT-2", "unwritten")], reviews: {} }),
  );
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({
      stage: "write",
      status: "succeeded",
      features: { "FEAT-1": { status: "written", batch: "initial", unwritten: [] }, "FEAT-2": { status: "written", batch: "only-20261001-120000", unwritten: ["SCN-6"] } },
      ...(opts.traced === false
        ? {}
        : {
            telemetry: {
              traces: [
                { traceId: FIRST, rootSpanId: "f".repeat(16), startedAt: "2026-10-01T11:00:00Z", spans: SPANS.first },
                { traceId: REWRITE, rootSpanId: "e".repeat(16), startedAt: "2026-10-01T12:00:00Z", spans: SPANS.rewrite },
              ],
            },
          }),
    }),
  );
  return dir;
}

const record = (dir: string, request: FeedbackRequest) => recordFeedback(dir, request, { author: "redchien", now: new Date("2026-10-02T09:00:00Z") });

describe("Feedback on a Write Run", () => {
  test("a verdict on a scenario keeps it as rendered and points at the writer that wrote it", () => {
    const { entry } = record(writeRun(), { type: "item", target: "SCN-1", verdict: "wrong", note: "應該是拒絕" });
    expect(entry).toMatchObject({
      type: "item",
      target: "SCN-1",
      section: "scenarios",
      verdict: "wrong",
      snapshot: scenario("SCN-1", "FEAT-1", "written"),
      trace: { traceId: FIRST, spanId: SPANS.first["write-FEAT-1"] },
    });
  });

  test("a scenario of a rewritten Feature points at the rewrite's writer, in the rewrite's trace", () => {
    const { entry } = record(writeRun(), { type: "item", target: "SCN-5", verdict: "ok" });
    expect(entry).toMatchObject({ trace: { traceId: REWRITE, spanId: SPANS.rewrite["write-FEAT-2-only-20261001-120000"] } });
  });

  test("scenarios take ok, wrong or partial; an unwritten or unknown one is refused", () => {
    const dir = writeRun();
    expect(() => record(dir, { type: "item", target: "SCN-1", verdict: "redundant", note: "x" })).toThrow("SCN-1 takes --ok, --wrong, --partial, not --redundant");
    expect(() => record(dir, { type: "item", target: "SCN-6", verdict: "ok" })).toThrow("SCN-6 was not written (@unwritten); rewrite it with x-plan write <run> --only FEAT-2, or record what is missing with --missing");
    expect(() => record(dir, { type: "item", target: "SCN-99", verdict: "ok" })).toThrow("No scenario SCN-99 in Write Run write-20261001-1100-c3d4e5");
    expect(() => record(dir, { type: "item", target: "BR-2", verdict: "ok" })).toThrow(/Feedback on a Write Run is about its scenarios \(SCN-n\)/);
  });

  test("a missing scenario can name its Feature, pointing at that Feature's writer", () => {
    const dir = writeRun();
    expect(record(dir, { type: "missing", text: "VIP 第 11 天取消被拒", at: "FEAT-2" }).entry).toMatchObject({
      type: "missing",
      at: "FEAT-2",
      trace: { traceId: REWRITE, spanId: SPANS.rewrite["write-FEAT-2-only-20261001-120000"] },
    });
    expect(record(dir, { type: "missing", text: "整體缺少取消通知" }).entry).toMatchObject({ trace: { traceId: REWRITE } });
    expect(() => record(dir, { type: "missing", text: "x", at: "prd.md:5" })).toThrow("For a Write Run, --at names the Feature the missing scenario belongs to, e.g. FEAT-2");
    expect(() => record(dir, { type: "missing", text: "x", at: "FEAT-9" })).toThrow("Write Run write-20261001-1100-c3d4e5 has no FEAT-9; its Features are FEAT-1, FEAT-2");
  });

  test("an untraced Write Run keeps Feedback local", () => {
    const { entry } = record(writeRun({ traced: false }), { type: "item", target: "SCN-1", verdict: "ok" });
    expect(entry).not.toHaveProperty("trace");
  });
});
