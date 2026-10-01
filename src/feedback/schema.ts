/** What a person said about one item of a Run's output (CONTEXT.md: Feedback). */
export type Verdict = "ok" | "wrong" | "partial" | "redundant";

export const VERDICTS: Verdict[] = ["ok", "wrong", "partial", "redundant"];

/** Where an observability backend shows the Feedback: the trace, and the span that produced the item if known. */
export interface TraceRef {
  traceId: string;
  /** Absent: the Feedback is about the whole trace. */
  spanId?: string;
  /** Task labels besides the span's that also contributed, e.g. bins whose duplicates were folded into the item. */
  otherSources?: string[];
}

interface Base {
  /** `FB-n`, per Run. */
  id: string;
  createdAt: string;
  author: string;
}

/** A verdict on one Brief item. `snapshot` is the item as it read then: the Brief may be rewritten later. */
export interface ItemFeedback extends Base {
  type: "item";
  target: string;
  section: string;
  verdict: Verdict;
  note?: string;
  snapshot: unknown;
  trace?: TraceRef;
  /** The same author's earlier Feedback on the same item, which this one replaces. */
  supersedes?: string;
}

/** Something the Run should have produced and did not. */
export interface MissingFeedback extends Base {
  type: "missing";
  text: string;
  /** Where the Source Document says it, e.g. `prd.md:57`. */
  at?: string;
  trace?: TraceRef;
}

/** An overall score of the Run, 1 to 5. */
export interface ScoreFeedback extends Base {
  type: "score";
  score: number;
  note?: string;
  trace?: TraceRef;
  supersedes?: string;
}

/** Withdraws an earlier entry. */
export interface Retraction extends Base {
  type: "retract";
  retracts: string;
  note?: string;
}

export type FeedbackEntry = ItemFeedback | MissingFeedback | ScoreFeedback | Retraction;
/** An entry that says something about the Run, as opposed to a retraction. */
export type Assessment = Exclude<FeedbackEntry, Retraction>;

/** Fact sections take ok/wrong/partial; analysis items have their own ways of being wrong. */
const VERDICTS_BY_PREFIX: Record<string, Verdict[]> = {
  OQ: ["ok", "redundant", "wrong"],
  CTR: ["ok", "wrong"],
  ASM: ["ok", "wrong"],
};
const FACT_VERDICTS: Verdict[] = ["ok", "wrong", "partial"];

export function verdictsFor(itemId: string): Verdict[] {
  return VERDICTS_BY_PREFIX[itemId.replace(/-\d+$/, "")] ?? FACT_VERDICTS;
}

export const MIN_SCORE = 1;
export const MAX_SCORE = 5;
