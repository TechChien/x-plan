import { PassThrough, Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import type { UserInput } from "../src/clarify/agenda.ts";
import { TtyAnswerer } from "../src/clarify/tty-answerer.ts";

describe("TtyAnswerer", () => {
  test("shows each side of a conflict, with the Answer a Decision came from, above the question", async () => {
    const output = new PassThrough();
    let shown = "";
    output.on("data", (chunk) => (shown += String(chunk)));
    const answerer = new TtyAnswerer(Readable.from(["以 DEC-1 為準\n"]), output);
    const recorded: UserInput[] = [];
    await answerer.ask(
      [
        {
          id: "FQ-3",
          kind: "FQ",
          origin: "conflict",
          relatedIds: ["DEC-2", "BR-2"],
          question: "以哪一個為準？",
          recommendation: "以 DEC-2 為準",
          basis: "brief",
          options: [],
          sides: [
            { id: "DEC-2", text: "下單後一律可以取消", answer: "R1/OQ-1: 都可以取消" },
            { id: "BR-2", text: "下單後 7 天內可取消" },
          ],
        },
      ],
      { round: 2, record: (input) => (recorded.push(input), undefined) },
    );
    answerer.close();
    expect(shown).toContain("FQ-3 · conflict ──\n  These cannot all hold:\n    DEC-2: 下單後一律可以取消\n      ← R1/OQ-1: 都可以取消\n    BR-2: 下單後 7 天內可取消\n以哪一個為準？");
    expect(recorded).toEqual([{ type: "response", itemId: "FQ-3", kind: "text", text: "以 DEC-1 為準" }]);
  });
});
