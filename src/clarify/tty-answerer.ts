import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AnswerSession, Answerer, AskedQuestion } from "./answerer.ts";
import { COMMAND_HELP, parseInput } from "./commands.ts";

const KIND_LABEL: Record<AskedQuestion["kind"], string> = {
  OQ: "open question",
  CTR: "contradiction",
  ASM: "assumption",
  FQ: "follow-up",
  NOTE: "note",
};

const CLOSED = "Input closed before all questions were answered; rerun the same command to continue";

/** Asks the batch in the terminal, one question at a time. Every input is recorded the moment it is entered. */
export class TtyAnswerer implements Answerer {
  readonly via = "tty";
  private rl?: Interface;
  private lines?: AsyncIterator<string>;
  private helpShown = false;

  constructor(
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
  ) {}

  async ask(questions: AskedQuestion[], session: AnswerSession): Promise<void> {
    const say = (text = "") => this.output.write(`${text}\n`);
    say(`\n=== Round ${session.round}: ${questions.length} question(s) ===`);
    if (!this.helpShown) {
      say(COMMAND_HELP);
      say("/help           show these commands again");
      this.helpShown = true;
    }
    for (const [i, q] of questions.entries()) {
      say();
      say(`── [${i + 1}/${questions.length}] ${q.id} · ${q.origin === "gherkin-gap" ? "gap" : KIND_LABEL[q.kind]}${q.parentId ? ` of ${q.parentId}` : ""} ──`);
      say(q.question);
      say(`  Recommended${q.basis === "convention" ? " (common practice)" : ""}: ${q.recommendation}`);
      if (q.options.length) say(`  ${q.options.map((o, n) => `/${n + 1} ${o}`).join("   ")}`);
      if (q.coveredBy) say(`  Possibly already decided by ${q.coveredBy}; /ok to confirm`);

      for (;;) {
        const line = await this.readLine();
        if (line.trim() === "/help") {
          say(COMMAND_HELP);
          continue;
        }
        const { input, error } = parseInput(line, { itemId: q.id, options: q.options });
        if (!input) {
          say(`  ! ${error}`);
          continue;
        }
        const refused = session.record(input);
        if (refused) {
          say(`  ! ${refused}`);
          continue;
        }
        if (input.type === "done") return;
        if (input.type === "note") {
          say("  (noted; now answer the question above)");
          continue;
        }
        break;
      }
    }
  }

  close(): void {
    this.rl?.close();
  }

  /** Lines are buffered by the iterator, so input typed (or piped) ahead of the prompt is not lost. */
  private async readLine(): Promise<string> {
    if (!this.rl) {
      this.rl = createInterface({ input: this.input, terminal: false });
      this.lines = this.rl[Symbol.asyncIterator]();
    }
    this.output.write("> ");
    const next = await this.lines!.next();
    if (next.done) throw new Error(CLOSED);
    return next.value;
  }
}
