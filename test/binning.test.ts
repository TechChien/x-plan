import { describe, expect, test } from "vitest";
import { computeBudget, estimateTokens, packBins, splitSource, WINDOW_OVERLAP_LINES } from "../src/source/binning.ts";

const doc = (path: string, lines: number, prefix = "line") => ({
  path,
  converted: false,
  text: Array.from({ length: lines }, (_, i) => `${prefix} ${i + 1} ${"x".repeat(27)}`).join("\n"),
});

describe("estimateTokens", () => {
  test("counts CJK characters one each and other characters one per three", () => {
    expect(estimateTokens("會員")).toBe(2);
    expect(estimateTokens("abcdef")).toBe(2);
  });
});

describe("computeBudget", () => {
  test("subtracts system prompt and output reserve, then keeps a 10% margin", () => {
    expect(computeBudget({ contextWindow: 131072, maxOutputTokens: 16384, systemPromptTokens: 6000 })).toBe(97819);
  });
});

describe("packBins", () => {
  test("everything in one bin when it fits", () => {
    const bins = packBins([doc("a.md", 10), doc("b.md", 10)], 10_000);
    expect(bins).toHaveLength(1);
    expect(bins[0]!.segments.map((s) => s.path)).toEqual(["a.md", "b.md"]);
  });

  test("first-fit decreasing never splits a file that fits and never exceeds the budget", () => {
    const sources = [doc("big.md", 90), doc("mid.md", 70), doc("small.md", 15), doc("tiny.md", 5)];
    const budget = splitSource(doc("x.md", 100), Infinity)[0]!.tokens;
    const bins = packBins(sources, budget);
    for (const bin of bins) expect(bin.tokens).toBeLessThanOrEqual(budget);
    const paths = bins.flatMap((b) => b.segments.map((s) => s.path)).sort();
    expect(paths).toEqual(["big.md", "mid.md", "small.md", "tiny.md"]);
    expect(bins.flatMap((b) => b.segments).every((s) => !s.part)).toBe(true);
  });
});

describe("packBins per-file", () => {
  test("gives every file its own bin even when they would fit together", () => {
    const bins = packBins([doc("a.md", 3), doc("b.md", 3)], 10_000, "per-file");
    expect(bins.map((b) => [b.index, b.segments.map((s) => s.path)])).toEqual([
      [1, ["a.md"]],
      [2, ["b.md"]],
    ]);
  });
});

describe("packBins with Reference Documents", () => {
  const perLine = splitSource(doc("one.md", 1), Infinity)[0]!.tokens;
  const sources = [doc("req.md", 5), doc("ref-a.md", 60), doc("ref-b.md", 60), doc("ref-c.md", 10)];
  const reference = new Set(["ref-a.md", "ref-b.md", "ref-c.md"]);

  test("auto: the first bin owns the requirement documents; every other bin shows them as context", () => {
    const budget = perLine * 80;
    const bins = packBins(sources, budget, "auto", reference);
    expect(bins.length).toBeGreaterThan(1);
    expect(bins[0]!.segments.map((s) => s.path)[0]).toBe("req.md");
    expect(bins[0]!.context).toBeUndefined();
    for (const bin of bins.slice(1)) {
      expect(bin.context!.map((s) => s.path)).toEqual(["req.md"]);
      expect(bin.segments.every((s) => s.reference)).toBe(true);
    }
    for (const bin of bins) expect(bin.tokens).toBeLessThanOrEqual(budget);
    expect(bins.flatMap((b) => b.segments.map((s) => s.path)).sort()).toEqual(["ref-a.md", "ref-b.md", "ref-c.md", "req.md"]);
  });

  test("per-file: requirement files keep their own bins; reference bins carry the requirements as context", () => {
    const bins = packBins(sources, 10_000, "per-file", reference);
    expect(bins.map((b) => [b.index, b.segments[0]!.path, b.context?.map((s) => s.path)])).toEqual([
      [1, "req.md", undefined],
      [2, "ref-a.md", ["req.md"]],
      [3, "ref-b.md", ["req.md"]],
      [4, "ref-c.md", ["req.md"]],
    ]);
  });

  test("requirement documents too large to repeat: references are packed without context", () => {
    const bins = packBins([doc("req.md", 60), doc("ref.md", 60)], perLine * 100, "auto", new Set(["ref.md"]));
    expect(bins.every((b) => !b.context)).toBe(true);
    expect(bins.flatMap((b) => b.segments).find((s) => s.path === "ref.md")!.reference).toBe(true);
  });

  test("without references the result is the plain packing", () => {
    expect(packBins(sources, perLine * 80, "auto", new Set())).toEqual(packBins(sources, perLine * 80));
  });
});

describe("splitSource", () => {
  test("splits an oversized file at Markdown headings, keeping original line numbers", () => {
    const text = ["# A", ...Array(40).fill("aaa aaa aaa aaa"), "# B", ...Array(40).fill("bbb bbb bbb bbb")].join("\n");
    const oneSection = splitSource({ path: "s.md", converted: false, text: ["# A", ...Array(40).fill("aaa aaa aaa aaa")].join("\n") }, Infinity)[0]!.tokens;
    const parts = splitSource({ path: "s.md", converted: false, text }, oneSection + 5);
    expect(parts.map((p) => [p.lineStart, p.lineEnd, p.part])).toEqual([
      [1, 41, { index: 1, total: 2 }],
      [42, 82, { index: 2, total: 2 }],
    ]);
  });

  test("falls back to overlapping line windows when there are no headings", () => {
    const source = doc("plain.txt", 400);
    const perLine = splitSource(doc("one.txt", 1), Infinity)[0]!.tokens;
    const parts = splitSource(source, perLine * 150);
    expect(parts.length).toBeGreaterThan(2);
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i]!.lineStart).toBe(parts[i - 1]!.lineEnd - WINDOW_OVERLAP_LINES + 1);
    }
    expect(parts.at(-1)!.lineEnd).toBe(400);
  });
});
