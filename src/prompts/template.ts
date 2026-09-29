import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/**
 * Bundled templates ship as `<package>/prompts`. From source this module is `src/prompts/template.ts`;
 * after bundling it is inlined into `dist/cli.js`, so both depths are tried.
 */
export const BUNDLED_PROMPTS_DIR = ["../../prompts/", "../prompts/"]
  .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
  .find((dir) => existsSync(join(dir, "extract")));

/**
 * Resolves template files from an optional override directory first, then the bundled prompts.
 * Records the content hash of every file it reads so a Run can report exactly which prompts it used.
 */
export class PromptLibrary {
  private readonly dirs: string[];
  private readonly used = new Map<string, string>();

  constructor(overrideDir?: string) {
    this.dirs = overrideDir ? [overrideDir, bundledDir()] : [bundledDir()];
  }

  read(name: string): string {
    for (const dir of this.dirs) {
      const path = join(dir, `${name}.md`);
      if (existsSync(path)) {
        const text = readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
        this.used.set(name, sha256(text).slice(0, 12));
        return text;
      }
    }
    throw new Error(`Prompt template not found: ${name}.md (searched ${this.dirs.join(", ")})`);
  }

  /** Loads a template, expands `{{> partial}}` includes, and substitutes `{{variables}}` in a single pass. */
  render(name: string, variables: Record<string, string>): string {
    const { body, declared } = parseTemplate(this.read(name), name);
    const expanded = expandIncludes(body, (partial) => parseTemplate(this.read(partial), partial).body, [name]);
    return substitute(expanded, declared, variables, name);
  }

  /** Hashes of every template read so far, keyed by template name. */
  hashes(): Record<string, string> {
    return Object.fromEntries([...this.used.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}

function bundledDir(): string {
  if (!BUNDLED_PROMPTS_DIR) throw new Error("Bundled prompts directory not found; is the package installed correctly?");
  return BUNDLED_PROMPTS_DIR;
}

export interface ParsedTemplate {
  body: string;
  declared: string[];
}

export function parseTemplate(text: string, name: string): ParsedTemplate {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { body: text, declared: [] };
  const meta = (parseYaml(match[1] ?? "") ?? {}) as { variables?: unknown };
  const declared = meta.variables ?? [];
  if (!Array.isArray(declared) || !declared.every((v) => typeof v === "string")) {
    throw new Error(`${name}: front-matter "variables" must be a list of names`);
  }
  return { body: text.slice(match[0].length), declared };
}

const INCLUDE = /\{\{>\s*([\w./-]+)\s*\}\}/g;
const VARIABLE = /\{\{\s*(\w+)\s*\}\}/g;

export function expandIncludes(body: string, load: (name: string) => string, stack: string[]): string {
  return body.replace(INCLUDE, (_, partial: string) => {
    if (stack.includes(partial)) throw new Error(`Circular include: ${[...stack, partial].join(" -> ")}`);
    return expandIncludes(load(partial).replace(/\n+$/, ""), load, [...stack, partial]);
  });
}

/**
 * Replaces `{{name}}` placeholders in one pass: injected values are never rescanned, so a Source Document
 * containing `{{x}}` stays literal. Throws on any mismatch between declared, used and provided variables.
 */
export function substitute(body: string, declared: string[], variables: Record<string, string>, name: string): string {
  const used = new Set([...body.matchAll(VARIABLE)].map((m) => m[1] as string));
  const provided = new Set(Object.keys(variables));
  const problems = [
    ...[...used].filter((v) => !declared.includes(v)).map((v) => `{{${v}}} is used but not declared in front-matter`),
    ...declared.filter((v) => !used.has(v)).map((v) => `${v} is declared but never used`),
    ...declared.filter((v) => !provided.has(v)).map((v) => `${v} has no value`),
    ...[...provided].filter((v) => !declared.includes(v)).map((v) => `${v} was provided but is not declared`),
  ];
  if (problems.length) throw new Error(`Template ${name}:\n  ${problems.join("\n  ")}`);
  return body.replace(VARIABLE, (_, v: string) => variables[v] as string);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
