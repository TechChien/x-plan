import type { SourceText } from "../source/convert.ts";
import type { Evidence } from "./schema.ts";

/** NFKC (unifies full-width/half-width), collapses whitespace runs to one space. */
export function normalize(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

interface IndexedFile {
  lineCount: number;
  /** Normalized non-blank lines joined by single spaces. */
  text: string;
  /** Offset in `text` where each line (1-based index - 1) starts. */
  lineOffsets: number[];
  /** Offset in `text` just past each line's content. */
  lineEnds: number[];
}

export class SourceIndex {
  private readonly files = new Map<string, IndexedFile>();

  constructor(sources: SourceText[]) {
    for (const s of sources) {
      const lines = s.text.split("\n").map(normalize);
      // A blank line adds no space of its own: a quote normalizes "\n\n" to one space, so the text must too.
      const lineOffsets: number[] = [];
      const lineEnds: number[] = [];
      let text = "";
      for (const line of lines) {
        if (line && text) text += " ";
        lineOffsets.push(text.length);
        text += line;
        lineEnds.push(text.length);
      }
      this.files.set(s.path, { lineCount: lines.length, text, lineOffsets, lineEnds });
    }
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  /**
   * Checks that `quote` appears within [lineStart, lineEnd]. When it does not, but occurs exactly once
   * elsewhere in the file, returns the Evidence with corrected line numbers.
   */
  verify(ev: Evidence): { ok: true; evidence: Evidence; relocated: boolean } | { ok: false; error: string } {
    const file = this.files.get(ev.file);
    if (!file) return { ok: false, error: `file "${ev.file}" is not one of the provided documents` };
    const quote = normalize(ev.quote);
    if (!quote) return { ok: false, error: "quote is empty" };

    if (ev.lineStart <= ev.lineEnd && ev.lineStart >= 1 && ev.lineEnd <= file.lineCount) {
      const from = file.lineOffsets[ev.lineStart - 1] as number;
      const to = file.lineEnds[ev.lineEnd - 1] as number;
      if (file.text.slice(from, to).includes(quote)) return { ok: true, evidence: ev, relocated: false };
    }

    const hits = occurrences(file.text, quote);
    if (hits.length === 1) {
      const start = hits[0] as number;
      const lineStart = lineAt(file.lineOffsets, start);
      const lineEnd = lineAt(file.lineOffsets, start + quote.length - 1);
      return { ok: true, evidence: { ...ev, lineStart, lineEnd }, relocated: true };
    }
    if (hits.length === 0) return { ok: false, error: `quote not found in ${ev.file}: "${truncate(ev.quote)}"` };
    return {
      ok: false,
      error: `quote not found in ${ev.file} L${ev.lineStart}-L${ev.lineEnd}; it appears ${hits.length} times elsewhere, cite the correct lines: "${truncate(ev.quote)}"`,
    };
  }
}

function occurrences(text: string, needle: string): number[] {
  const hits: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) hits.push(i);
  return hits;
}

/** 1-based line containing character `offset`. */
function lineAt(lineOffsets: number[], offset: number): number {
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((lineOffsets[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
