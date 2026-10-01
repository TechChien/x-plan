import { normalize } from "../../extract/evidence.ts";
import { ScriptAnswerer, type AnswerSession, type Answerer, type AskedQuestion } from "../../clarify/answerer.ts";
import type { ClarifyCase } from "./cases.ts";

/** How the simulated user answered one question: which label (if any) the reply came from. */
export interface AnswerLogEntry {
  round: number;
  questionId: string;
  origin: AskedQuestion["origin"];
  parentId?: string;
  question: string;
  recommendation: string;
  /** "target": a label's own item; "followUp": a follow-up of a label; "gap" and "conflict": those labels; "unmatched": noise. */
  role: "target" | "followUp" | "gap" | "conflict" | "unmatched";
  label?: string;
}

const has = (text: string, keyword: string) => normalize(text).toLowerCase().includes(normalize(keyword).toLowerCase());

/**
 * Plays the user from a case's labels (plan §5): Brief items by id, follow-ups through the label of the item they
 * follow up, gaps by their relatedIds (each gap label once), and everything else with `unmatchedReply`.
 */
export class LabelAnswerer implements Answerer {
  readonly via = "eval";
  readonly log: AnswerLogEntry[] = [];
  /** Agenda Item id → label id, for items asked on behalf of a label (targets and their follow-ups). */
  private readonly owner = new Map<string, string>();
  /** Gap labels already used: each answers one gap question, so a broad relatedIds match cannot hand the same reply to every related gap. */
  private readonly usedGaps = new Set<string>();
  private readonly usedConflicts = new Set<string>();
  /** Labels whose follow-up reply was given: it answers one follow-up, not every later one that shares a keyword. */
  private readonly usedFollowUps = new Set<string>();
  private readonly script: ScriptAnswerer;

  constructor(private readonly labels: ClarifyCase) {
    for (const a of labels.answers) this.owner.set(a.target, a.id);
    this.script = new ScriptAnswerer((q, round) => this.reply(q, round), this.via);
  }

  ask(questions: AskedQuestion[], session: AnswerSession): Promise<void> {
    return this.script.ask(questions, session);
  }

  private reply(q: AskedQuestion, round: number): string | string[] {
    const entry: AnswerLogEntry = { round, questionId: q.id, origin: q.origin, question: q.question, recommendation: q.recommendation, role: "unmatched" };
    if (q.parentId) entry.parentId = q.parentId;
    this.log.push(entry);
    const unmatched = this.labels.unmatchedReply ?? "/na";

    const own = this.labels.answers.find((a) => a.target === q.id);
    if (own) {
      Object.assign(entry, { role: "target", label: own.id });
      return own.reply;
    }
    const parentLabel = q.parentId ? this.owner.get(q.parentId) : undefined;
    if (q.origin === "follow-up" && parentLabel) {
      const label = this.labels.answers.find((a) => a.id === parentLabel)!;
      this.owner.set(q.id, label.id);
      Object.assign(entry, { role: "followUp", label: label.id });
      const fit = !this.usedFollowUps.has(label.id) && label.followUpReply && label.followUpReply.any.some((k) => has(q.question, k));
      if (!fit) return unmatched;
      this.usedFollowUps.add(label.id);
      return label.followUpReply!.reply;
    }
    if (q.origin === "conflict") {
      const conflict = (this.labels.conflicts ?? []).find((c) => !this.usedConflicts.has(c.id) && c.any.some((k) => has(q.question, k)));
      if (conflict) {
        this.usedConflicts.add(conflict.id);
        Object.assign(entry, { role: "conflict", label: conflict.id });
        return conflict.reply;
      }
    }
    if (q.origin === "gherkin-gap") {
      const gap = (this.labels.gaps ?? []).find((g) => !this.usedGaps.has(g.id) && g.relatedIds.every((id) => q.relatedIds.includes(id)));
      if (gap) {
        this.usedGaps.add(gap.id);
        Object.assign(entry, { role: "gap", label: gap.id });
        return gap.reply ?? unmatched;
      }
    }
    return unmatched;
  }
}
