import type { UserInput } from "./agenda.ts";
import { parseInput } from "./commands.ts";
import type { AgendaItem, QuestionView } from "./schema.ts";

/** One question of the batch as the user sees it. */
export interface AskedQuestion extends QuestionView {
  id: string;
  kind: AgendaItem["kind"];
  origin: AgendaItem["origin"];
  parentId?: string;
  relatedIds: string[];
  /** Conflicts only: each side as it stands, with the Answer a Decision was drawn from. */
  sides?: { id: string; text: string; answer?: string }[];
}

export interface AnswerSession {
  round: number;
  /**
   * Records one input right away (so an interrupted session loses nothing) and returns why it was refused,
   * or undefined when it was recorded. After a `done` input, stop asking.
   */
  record(input: UserInput): string | undefined;
}

/**
 * Where Answers come from (ADR 0006): the terminal, a script in tests and evals, later perhaps a file the user
 * fills in. `ask` returns once every question has a response or the user entered /done.
 */
export interface Answerer {
  readonly via: string;
  ask(questions: AskedQuestion[], session: AnswerSession): Promise<void>;
  /** Releases the input when the session ends. */
  close?(): void;
}

/**
 * Answers every question with the lines a script returns, parsed exactly like terminal input. Lines before the
 * last are extra inputs such as notes or /done.
 */
export class ScriptAnswerer implements Answerer {
  readonly via: string;

  constructor(
    private readonly script: (question: AskedQuestion, round: number) => string | string[],
    via = "scripted",
  ) {
    this.via = via;
  }

  async ask(questions: AskedQuestion[], session: AnswerSession): Promise<void> {
    for (const q of questions) {
      const reply = this.script(q, session.round);
      for (const line of Array.isArray(reply) ? reply : [reply]) {
        const { input, error } = parseInput(line, { itemId: q.id, options: q.options });
        if (!input) throw new Error(`Scripted reply ${JSON.stringify(line)} to ${q.id} is invalid: ${error}`);
        const refused = session.record(input);
        if (refused) throw new Error(`Scripted reply ${JSON.stringify(line)} to ${q.id} was refused: ${refused}`);
        if (input.type === "done") return;
      }
    }
  }
}
