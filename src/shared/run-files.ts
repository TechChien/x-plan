import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface BuiltPrompt {
  systemPrompt: string;
  userMessage: string;
}

/** Saves what was actually sent to the model as `prompts/<label>.system.md` and `.user.md`. */
export function savePrompt(runDir: string, label: string, prompt: BuiltPrompt): void {
  writeText(join(runDir, "prompts", `${label}.system.md`), prompt.systemPrompt);
  writeText(join(runDir, "prompts", `${label}.user.md`), prompt.userMessage);
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}
