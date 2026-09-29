import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import fg from "fast-glob";
import ignore from "ignore";

export const SUPPORTED_EXTENSIONS = [".md", ".txt", ".pdf", ".docx"] as const;

export interface ScanOptions {
  include?: string[];
  exclude?: string[];
}

export interface ScanResult {
  /** Paths relative to the scanned directory, POSIX separators, sorted. */
  files: string[];
  /** Files skipped because their extension is unsupported. */
  skipped: string[];
}

export async function scanDirectory(dir: string, options: ScanOptions = {}): Promise<ScanResult> {
  const all = await fg(options.include?.length ? options.include : ["**/*"], {
    cwd: dir,
    dot: false,
    onlyFiles: true,
    ignore: ["**/node_modules/**", ...(options.exclude ?? [])],
  });

  const ig = ignore();
  const gitignorePath = join(dir, ".gitignore");
  if (existsSync(gitignorePath)) ig.add(readFileSync(gitignorePath, "utf8"));

  const files: string[] = [];
  const skipped: string[] = [];
  for (const file of all.sort()) {
    if (ig.ignores(file)) continue;
    const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
    if ((SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) files.push(file);
    else skipped.push(file);
  }
  return { files, skipped };
}

export function toPosix(base: string, path: string): string {
  return relative(base, path).split("\\").join("/");
}
