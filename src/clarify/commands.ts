import type { UserInput } from "./agenda.ts";

export const COMMAND_HELP = [
  "<text>          answer in your own words",
  "/ok             accept the recommendation",
  "/1 … /4         choose an option",
  "/later          ask me again later (the second time defers it)",
  "/defer [why]    decide after this session; Write marks it @deferred",
  "/na [why]       not applicable",
  "/note [ID] text add or correct something, optionally about an item or Decision (e.g. /note DEC-2 …)",
  "/done           stop asking; unanswered items are left open",
].join("\n");

const ID = /^[A-Z]+-\d+$/;

/** Parses one line the user typed while `itemId` is shown. */
export function parseInput(raw: string, current: { itemId: string; options: string[] }): { input?: UserInput; error?: string } {
  const line = raw.trim();
  if (!line) return { error: "an answer cannot be empty; type /later to skip for now" };
  if (!line.startsWith("/")) return { input: { type: "response", itemId: current.itemId, kind: "text", text: line } };

  const [command = "", ...rest] = line.slice(1).split(/\s+/);
  const text = rest.join(" ");
  const response = (kind: "accept" | "later" | "defer" | "na", t = "") => ({ input: { type: "response" as const, itemId: current.itemId, kind, text: t } });

  if (/^\d+$/.test(command)) {
    const option = current.options[Number(command) - 1];
    return option ? { input: { type: "response", itemId: current.itemId, kind: "text", text: option } } : { error: `there is no option ${command}` };
  }
  switch (command) {
    case "ok":
      return response("accept");
    case "later":
      return response("later");
    case "defer":
      return response("defer", text);
    case "na":
      return response("na", text);
    case "done":
      return { input: { type: "done" } };
    case "note": {
      const [first = "", ...others] = rest;
      if (ID.test(first)) return others.length ? { input: { type: "note", target: first, text: others.join(" ") } } : { error: "a note needs text" };
      return text ? { input: { type: "note", text } } : { error: "a note needs text" };
    }
    default:
      return { error: `unknown command /${command}\n${COMMAND_HELP}` };
  }
}
