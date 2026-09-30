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
  /** Set for a Reference Document: supporting material, extracted only where the requirement documents need it. */
  reference?: true;
}

export interface Bin {
  index: number;
  /** What this bin's agent extracts from and may cite. */
  segments: Segment[];
  /**
   * Requirement documents extracted in another bin, shown again only so the agent can judge which reference
   * content is relevant. Never extracted from or cited in this bin.
   */
  context?: Segment[];
  /** Includes the context. */
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

/**
 * `reference` holds the paths of Reference Documents. Every bin holding reference segments also sees the
 * requirement documents: "auto" puts them in the first bin, and every other such bin shows them as `context`.
 * When the requirement documents take more than half the budget they are not repeated; references are then
 * packed like any other document, and the caller should warn.
 */
export function packBins(sources: SourceText[], budget: number, packing: Packing = "auto", reference: ReadonlySet<string> = new Set()): Bin[] {
  const split = (s: SourceText, b: number) => splitSource(s, b).map((seg) => (reference.has(s.path) ? { ...seg, reference: true as const } : seg));
  const requirements = sources.filter((s) => !reference.has(s.path)).flatMap((s) => split(s, budget));
  const contextTokens = requirements.reduce((sum, s) => sum + s.tokens, 0);
  const references = sources.filter((s) => reference.has(s.path));
  if (!references.length || !requirements.length || contextTokens > budget / 2) {
    return packSegments(sources.flatMap((s) => split(s, budget)), budget, packing);
  }

  const refBins = packSegments(references.flatMap((s) => split(s, budget - contextTokens)), budget - contextTokens, packing);
  const withContext = (bin: Bin): Bin => ({ ...bin, context: requirements, tokens: bin.tokens + contextTokens });
  if (packing === "per-file") return renumber([...packSegments(requirements, budget, packing), ...refBins.map(withContext)]);
  const [first, ...rest] = refBins as [Bin, ...Bin[]];
  const owner = { ...first, segments: [...requirements, ...first.segments].sort(bySource), tokens: first.tokens + contextTokens };
  return renumber([owner, ...rest.map(withContext)]);
}

function packSegments(segments: Segment[], budget: number, packing: Packing): Bin[] {
  if (packing === "per-file") return segments.map((seg, i) => ({ index: i + 1, segments: [seg], tokens: seg.tokens }));
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
  for (const bin of bins) bin.segments.sort(bySource);
  return bins;
}

/** Requirement documents first, then by path and position. */
function bySource(a: Segment, b: Segment): number {
  return Number(Boolean(a.reference)) - Number(Boolean(b.reference)) || a.path.localeCompare(b.path) || a.lineStart - b.lineStart;
}

function renumber(bins: Bin[]): Bin[] {
  return bins.map((bin, i) => ({ ...bin, index: i + 1 }));
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
