import { readFile } from "node:fs/promises";
import { join } from "node:path";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

/** A Source Document converted to plain text. Line numbers in Evidence refer to `text`. */
export interface SourceText {
  /** Original path relative to the scanned directory (POSIX). */
  path: string;
  text: string;
  /** True when `text` was produced from a binary format (pdf/docx). */
  converted: boolean;
}

export async function convertFile(dir: string, path: string): Promise<SourceText> {
  const abs = join(dir, path);
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".md":
    case ".txt":
      return { path, text: normalizeNewlines(await readFile(abs, "utf8")), converted: false };
    case ".pdf": {
      const pdf = await getDocumentProxy(new Uint8Array(await readFile(abs)));
      const { text } = await extractText(pdf, { mergePages: true });
      return { path, text: normalizeNewlines(text), converted: true };
    }
    case ".docx": {
      const { value } = await mammoth.extractRawText({ path: abs });
      return { path, text: normalizeNewlines(value), converted: true };
    }
    default:
      throw new Error(`Unsupported file type: ${path}`);
  }
}

function normalizeNewlines(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}
