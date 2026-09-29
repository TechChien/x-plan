import type { SourceText } from "./convert.ts";

/** A contiguous line range of one Source Document. Line numbers are 1-based and refer to the original file. */
export interface Segment {
  path: string;
  lineStart: number;
  lineEnd: number;
  lines: string[];
  tokens: number;
  /** Set when a file had to be split: this segment's position among the file's parts. */
  part?: { index: number; total: number };
}

export interface Bin {
  index: number;
  segments: Segment[];
  tokens: number;
}

const CJK = /[　-鿿가-힯豈-﫿＀-￯]/g;

/** Conservative estimate: one token per CJK character, one per three other characters. */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 3);
}

export interface BudgetInput {
  contextWindow: number;
  maxOutputTokens: number;
  systemPromptTokens: number;
  /** Fraction kept as safety margin. */
  margin?: number;
}

export function computeBudget({ contextWindow, maxOutputTokens, systemPromptTokens, margin = 0.1 }: BudgetInput): number {
  const budget = Math.floor((contextWindow - systemPromptTokens - maxOutputTokens) * (1 - margin));
  if (budget <= 0) throw new Error(`No room for documents: contextWindow ${contextWindow} is too small.`);
  return budget;
}

export const WINDOW_OVERLAP_LINES = 50;

/** Cost of the `L123: ` prefix and newline added when a line is shown to the model. */
const LINE_OVERHEAD_TOKENS = 3;

function lineCost(line: string): number {
  return estimateTokens(line) + LINE_OVERHEAD_TOKENS;
}

/**
 * "auto" packs segments first-fit decreasing. "per-file" gives every file its own bin(s); evals use it to force
 * the multi-batch situation deterministically.
 */
export type Packing = "auto" | "per-file";

export function packBins(sources: SourceText[], budget: number, packing: Packing = "auto"): Bin[] {
  if (packing === "per-file") {
    return sources
      .flatMap((s) => splitSource(s, budget))
      .map((seg, i) => ({ index: i + 1, segments: [seg], tokens: seg.tokens }));
  }
  const segments = sources.flatMap((s) => splitSource(s, budget));
  const sorted = [...segments].sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path));
  const bins: Bin[] = [];
  for (const seg of sorted) {
    const bin = bins.find((b) => b.tokens + seg.tokens <= budget);
    if (bin) {
      bin.segments.push(seg);
      bin.tokens += seg.tokens;
    } else {
      bins.push({ index: bins.length + 1, segments: [seg], tokens: seg.tokens });
    }
  }
  for (const bin of bins) {
    bin.segments.sort((a, b) => a.path.localeCompare(b.path) || a.lineStart - b.lineStart);
  }
  return bins;
}

/** Keeps a file whole when it fits; otherwise splits at Markdown headings, falling back to overlapping line windows. */
export function splitSource(source: SourceText, budget: number): Segment[] {
  const lines = source.text.split("\n");
  const whole = makeSegment(source.path, lines, 1, lines.length);
  if (whole.tokens <= budget) return [whole];

  const chunks: Segment[] = [];
  let current: Segment | undefined;
  for (const section of headingSections(source.path, lines)) {
    if (section.tokens > budget) {
      if (current) chunks.push(current);
      current = undefined;
      chunks.push(...windowSplit(source.path, lines, section.lineStart, section.lineEnd, budget));
      continue;
    }
    if (current && current.tokens + section.tokens <= budget) {
      current = makeSegment(source.path, lines, current.lineStart, section.lineEnd);
    } else {
      if (current) chunks.push(current);
      current = section;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((c, i) => ({ ...c, part: { index: i + 1, total: chunks.length } }));
}

function headingSections(path: string, lines: string[]): Segment[] {
  const starts = [1];
  lines.forEach((line, i) => {
    if (i > 0 && /^#{1,6}\s/.test(line)) starts.push(i + 1);
  });
  return starts.map((start, i) => makeSegment(path, lines, start, (starts[i + 1] ?? lines.length + 1) - 1));
}

function windowSplit(path: string, lines: string[], from: number, to: number, budget: number): Segment[] {
  const windows: Segment[] = [];
  let start = from;
  while (start <= to) {
    let end = start;
    let tokens = lineCost(lines[start - 1] ?? "");
    while (end < to && tokens + lineCost(lines[end] ?? "") <= budget) {
      tokens += lineCost(lines[end] ?? "");
      end++;
    }
    windows.push(makeSegment(path, lines, start, end));
    if (end >= to) break;
    start = Math.max(start + 1, end - WINDOW_OVERLAP_LINES + 1);
  }
  return windows;
}

function makeSegment(path: string, lines: string[], lineStart: number, lineEnd: number): Segment {
  const slice = lines.slice(lineStart - 1, lineEnd);
  return { path, lineStart, lineEnd, lines: slice, tokens: slice.reduce((sum, line) => sum + lineCost(line), 0) };
}
