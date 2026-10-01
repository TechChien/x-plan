import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { recordFeedback, type FeedbackRequest } from "../src/feedback/feedback.ts";
import { readFeedback, standing } from "../src/feedback/store.ts";
import { LangfuseScores, readSyncState, syncFeedback, syncStatus, type Score, type ScoreSink } from "../src/feedback/sync.ts";
import { returnsBrief } from "./helpers/brief.ts";

const TRACE = "a".repeat(32);
const BIN1 = "1".repeat(16);
const RUN = "extract-20261001-1000-a1b2c3";

function run(traced = true): string {
  const dir = join(mkdtempSync(join(tmpdir(), "xplan-sync-")), RUN);
  mkdirSync(dir);
  writeFileSync(join(dir, "01-brief.json"), JSON.stringify(returnsBrief()));
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({
      stage: "extract",
      status: "succeeded",
      bins: [{ index: 1, segments: [{ path: "prd.md", lines: "1-100" }] }],
      provenance: { "BR-1": { text: "facts-bin1", evidence: ["facts-bin1", "facts-bin2"] } },
      ...(traced ? { telemetry: { traces: [{ traceId: TRACE, rootSpanId: "f".repeat(16), startedAt: "", spans: { "facts-bin1": BIN1 } }] } } : {}),
    }),
  );
  return dir;
}

const record = (dir: string, request: FeedbackRequest) => recordFeedback(dir, request, { author: "redchien", now: new Date("2026-10-01T12:00:00Z") });

/** Records calls; fails the n-th create when told to. */
class FakeSink implements ScoreSink {
  readonly created: Score[] = [];
  readonly deleted: string[] = [];
  failOnCreate = 0;

  async create(score: Score): Promise<void> {
    if (this.failOnCreate && this.created.length + 1 === this.failOnCreate) throw new Error("connection refused");
    this.created.push(score);
  }

  async delete(id: string): Promise<void> {
    this.deleted.push(id);
  }
}

describe("syncFeedback", () => {
  test("each kind becomes a score on the trace, on the item's span when known", async () => {
    const dir = run();
    record(dir, { type: "item", target: "BR-1", verdict: "wrong", note: "是 7 天" });
    record(dir, { type: "missing", text: "VIP 免運", at: "prd.md:57" });
    record(dir, { type: "score", score: 4, note: "不錯" });
    const sink = new FakeSink();
    const report = await syncFeedback(dir, sink);

    expect(report).toEqual({ created: ["FB-1", "FB-2", "FB-3"], deleted: [], untraced: [] });
    expect(sink.created).toEqual([
      {
        id: `xplan-${RUN}-FB-1`,
        traceId: TRACE,
        observationId: BIN1,
        name: "item-verdict",
        dataType: "CATEGORICAL",
        value: "wrong",
        comment: "BR-1: 是 7 天\nAlso from: facts-bin2",
        metadata: { feedbackId: "FB-1", runId: RUN, author: "redchien", target: "BR-1", section: "businessRules" },
      },
      expect.objectContaining({ name: "missing", value: "missing", observationId: BIN1, comment: "VIP 免運 (prd.md:57)" }),
      expect.objectContaining({ name: "run-score", dataType: "NUMERIC", value: 4, comment: "不錯" }),
    ]);
    expect(sink.created[2]).not.toHaveProperty("observationId");
  });

  test("a second sync sends only what is new, and removes what was superseded or retracted", async () => {
    const dir = run();
    record(dir, { type: "item", target: "BR-1", verdict: "wrong", note: "x" });
    record(dir, { type: "missing", text: "VIP 免運" });
    const sink = new FakeSink();
    await syncFeedback(dir, sink);

    record(dir, { type: "item", target: "BR-1", verdict: "ok" }); // FB-3 supersedes FB-1
    record(dir, { type: "retract", id: "FB-2" });
    const report = await syncFeedback(dir, sink);
    expect(report).toEqual({ created: ["FB-3"], deleted: ["FB-1", "FB-2"], untraced: [] });
    expect(sink.deleted).toEqual([`xplan-${RUN}-FB-1`, `xplan-${RUN}-FB-2`]);

    expect(await syncFeedback(dir, sink)).toEqual({ created: [], deleted: [], untraced: [] });
    const state = readSyncState(dir);
    expect(Object.fromEntries(standing(readFeedback(dir)).map((e) => [e.id, syncStatus(e, state)]))).toEqual({ "FB-3": "synced" });
  });

  test("a failure stops the sync, keeps what was done, and the next sync carries on", async () => {
    const dir = run();
    for (const text of ["a", "b", "c"]) record(dir, { type: "missing", text });
    const sink = new FakeSink();
    sink.failOnCreate = 2;
    expect(await syncFeedback(dir, sink)).toEqual({ created: ["FB-1"], deleted: [], untraced: [], error: "connection refused" });
    expect(Object.keys(readSyncState(dir))).toEqual(["FB-1"]);

    sink.failOnCreate = 0;
    expect((await syncFeedback(dir, sink)).created).toEqual(["FB-2", "FB-3"]);
  });

  test("Feedback on a Run that was not traced stays local", async () => {
    const dir = run(false);
    record(dir, { type: "score", score: 3 });
    const sink = new FakeSink();
    expect(await syncFeedback(dir, sink)).toEqual({ created: [], deleted: [], untraced: ["FB-1"] });
    expect(syncStatus(standing(readFeedback(dir))[0]!, readSyncState(dir))).toBe("no trace");
  });
});

describe("LangfuseScores", () => {
  const creds = { baseUrl: "http://lf.local", authorization: "Basic abc" };
  const score: Score = { id: "s1", traceId: TRACE, name: "run-score", dataType: "NUMERIC", value: 4, metadata: {} };

  test("posts scores and deletes them with the instance's auth; a score already gone is fine", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const responses = [new Response("{}", { status: 200 }), new Response("", { status: 404 })];
    const fake = (async (url: string, init: RequestInit) => (calls.push({ url, init }), responses.shift()!)) as unknown as typeof fetch;
    const sink = new LangfuseScores(creds, fake);
    await sink.create(score);
    await sink.delete("s 1");
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["POST", "http://lf.local/api/public/scores"],
      ["DELETE", "http://lf.local/api/public/scores/s%201"],
    ]);
    expect(calls[0]!.init.headers).toEqual({ Authorization: "Basic abc", "Content-Type": "application/json" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(score);
  });

  test("an error response becomes an error with its status", async () => {
    const fake = (async () => new Response("bad keys", { status: 401 })) as unknown as typeof fetch;
    await expect(new LangfuseScores(creds, fake).create(score)).rejects.toThrow("Langfuse POST /api/public/scores returned 401: bad keys");
  });
});
