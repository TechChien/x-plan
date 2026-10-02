import { Type, type Static } from "typebox";
import { Confidence, Severity } from "../extract/schema.ts";
import type { OutputLanguage } from "../shared/language.ts";

const Str = (description: string) => Type.String({ description });
const Ids = (description: string) => Type.Array(Type.String(), { description });

const Basis = Type.Union([Type.Literal("brief"), Type.Literal("convention")], {
  description: "brief: the recommendation follows from items in <brief>; convention: common practice, the Brief says nothing about it",
});

/** What the user sees for one Agenda Item: the question, a recommended answer and choices. */
const QuestionText = {
  question: Str("The question as the user will read it"),
  recommendation: Str("Your recommended answer; the user can accept it with /ok"),
  basis: Basis,
  options: Type.Array(Type.String(), { maxItems: 4, description: "Distinct answers the user can choose from; empty when the question is open-ended" }),
};

export const DecisionOpSchema = Type.Object({
  answerRef: Str("The Answer this conclusion is drawn from, exactly as in <pending-answers>, e.g. R1/CTR-1"),
  resolves: Type.Array(Type.String(), { minItems: 1, description: "Agenda Item ids this Decision closes" }),
  conclusion: Str("What the user decided, as one self-contained statement"),
  // `default: []`: the model may leave it out (see `omittable`); past runs show it is then always empty.
  supersedes: Type.Array(Type.String(), { description: "Brief fact or ASM ids this Decision replaces", default: [] }),
  confirms: Ids("ASM ids this Decision confirms as stated"),
  revises: Type.Array(Type.String(), { description: "DEC ids this Decision corrects", default: [] }),
  relatedIds: Ids("Other Brief ids the conclusion concerns"),
});
export type DecisionOp = Static<typeof DecisionOpSchema>;

export const FollowUpSchema = Type.Object({
  origin: Type.Union([Type.Literal("follow-up"), Type.Literal("gherkin-gap")]),
  parentId: Type.Optional(Str("follow-up only: the Agenda Item whose Answer needs this follow-up")),
  ...QuestionText,
  relatedIds: Ids("Brief ids the question concerns; a gherkin-gap question must name the facts that lack detail"),
});
export type FollowUp = Static<typeof FollowUpSchema>;

export const PreparedSchema = Type.Object({
  id: Str("Agenda Item id from <prepare>"),
  ...QuestionText,
  coveredBy: Type.Optional(Str("A DEC id you believe already answers this item; the user still confirms it")),
});
export type Prepared = Static<typeof PreparedSchema>;

export const RoundSubmissionSchema = Type.Object(
  {
    decisions: Type.Array(DecisionOpSchema),
    followUps: Type.Array(FollowUpSchema),
    prepared: Type.Array(PreparedSchema),
  },
  { additionalProperties: false },
);
export type RoundSubmission = Static<typeof RoundSubmissionSchema>;

/** The closing round only interprets Answers: it has no way to ask anything. */
export const FinalSubmissionSchema = Type.Object({ decisions: Type.Array(DecisionOpSchema) }, { additionalProperties: false });
export type FinalSubmission = Static<typeof FinalSubmissionSchema>;

/** Consistency Check's submission (ADR 0012): Decisions or facts that cannot all hold, each put to the user as a question. */
export const ConsistencySubmissionSchema = Type.Object(
  {
    conflicts: Type.Array(
      Type.Object(
        {
          ids: Type.Array(Type.String(), { minItems: 2, description: "The Decisions and Brief facts that cannot all hold; at least one is from <new>" }),
          conflict: Str("What cannot hold together, as one sentence naming the ids"),
          ...QuestionText,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ConsistencySubmission = Static<typeof ConsistencySubmissionSchema>;
export type ConflictOp = ConsistencySubmission["conflicts"][number];

export type AgendaKind = "OQ" | "CTR" | "ASM" | "FQ" | "NOTE";
export type AgendaOrigin = "brief" | "follow-up" | "gherkin-gap" | "user" | "conflict";
export type AgendaStatus = "pending" | "asked" | "answered" | "followed-up" | "decided" | "deferred" | "dismissed" | "unresolved";

export const TERMINAL_STATUSES: readonly AgendaStatus[] = ["decided", "deferred", "dismissed", "unresolved"];
export const isTerminal = (status: AgendaStatus) => TERMINAL_STATUSES.includes(status);
/** Has an Answer that still has to be interpreted into a Decision. */
export const awaitsInterpretation = (status: AgendaStatus) => status === "answered" || status === "followed-up";

export type QuestionView = Omit<Prepared, "id">;

export interface AgendaItem {
  id: string;
  kind: AgendaKind;
  origin: AgendaOrigin;
  status: AgendaStatus;
  /** The item as first stated: the Brief's question, conflict or assumption, a follow-up's question, or the user's note. */
  text: string;
  severity?: Static<typeof Severity>;
  confidence?: Static<typeof Confidence>;
  relatedIds: string[];
  /** Follow-up questions: the item whose Answer they follow up. */
  parentId?: string;
  /** 0 for Brief items, gaps and notes; parent depth + 1 for follow-ups. */
  depth: number;
  children: string[];
  laterCount: number;
  askedIn: number[];
  /** The latest question text prepared for the user. */
  view?: QuestionView;
  /** NOTE items: the Agenda Item or Decision the note refers to. */
  target?: string;
  resolvedBy?: string[];
}

/** What the user did with one Agenda Item. Only `text` and `accept` carry content a Decision can be drawn from. */
export type ResponseKind = "text" | "accept" | "later" | "defer" | "na";
export const hasContent = (kind: ResponseKind) => kind === "text" || kind === "accept";

export interface Answer {
  /** `R<round>/<item id>` */
  ref: string;
  itemId: string;
  round: number;
  kind: ResponseKind;
  /** The user's words verbatim; for `accept`, the recommendation as it was shown. */
  text: string;
  /** Notes only: the Agenda Item or Decision the note refers to. */
  target?: string;
  via: string;
  at: string;
}

export interface Decision extends DecisionOp {
  id: string;
  round: number;
  status: "active" | "revised";
  revisedBy?: string;
}

/** A Follow-up Question as accepted, with the id the program gave it. */
export interface AcceptedFollowUp extends FollowUp {
  id: string;
}

/** The part of one submission that passed the check; `applyRound` applies exactly this. */
export interface AcceptedRound {
  decisions: Decision[];
  followUps: AcceptedFollowUp[];
  prepared: Prepared[];
  /**
   * Answered items Grounding Review found no Decision could be drawn from and that cannot be asked again: they
   * become unresolved (ADR 0011). Absent in rounds recorded before Grounding Review.
   */
  leftOpen?: string[];
}

/**
 * A conflict Consistency Check found after a round's Decisions were written, as the program numbered it. `pending`
 * conflicts are asked; `unresolved` ones could not be (closing round, or a chain of conflicts too deep).
 */
export interface AcceptedConflict extends ConflictOp {
  id: string;
  /** 1 for a conflict among ordinary Decisions; one more than the deepest conflict a Decision involved settled. */
  depth: number;
  status: "pending" | "unresolved";
}

/** Why Grounding Review stopped a Decision. */
export type ReviewVerdict = "embellished" | "partial" | "off-topic" | "overreach";

/** Grounding Review's finding on one submitted Decision, kept for the record and the eval. */
export interface ReviewRecord {
  /** The interpreter's submit attempt the Decision came from. */
  attempt: number;
  /** `decisions[i]` in that submission. */
  path: string;
  answerRef: string;
  resolves: string[];
  conclusion: string;
  /** Empty: the Decision is grounded. */
  verdicts: ReviewVerdict[];
  /** Claims with no source. */
  unsupported: string[];
  /** Parts of the questions no Answer settles. */
  unanswered: string[];
  /** Brief items it supersedes although the user corrected only part of them. Absent in older records. */
  partlyCorrected?: string[];
}

export interface RoundRecord {
  n: number;
  final: boolean;
  /** Items the program assigned for preparation. */
  prepare: string[];
  accepted: AcceptedRound;
  /** The questions shown to the user, as shown: later rounds never rewrite them. */
  asked: (QuestionView & { id: string })[];
  ordering: { prepare: string; batch: string };
  /** Grounding Review of every Decision submitted in this round, every attempt. Absent before Grounding Review. */
  reviews?: ReviewRecord[];
  /** Conflicts Consistency Check found among this round's Decisions. Absent before Consistency Check. */
  conflicts?: AcceptedConflict[];
}

export interface ClarifyRejected {
  round: number;
  kind: "decision" | "followUp" | "prepared";
  item: unknown;
  errors: string[];
}

export type Termination = "converged" | "done" | "cap";

export interface ClarifyState {
  version: 1;
  briefSha256: string;
  /** The Extract Run whose Brief this session clarifies (ADR 0010). */
  source?: { stage: "extract"; runId: string; sha256: string };
  outputLanguage: OutputLanguage;
  /** Agenda Items in creation order. */
  agenda: AgendaItem[];
  /** Append-only. */
  answers: Answer[];
  decisions: Decision[];
  rounds: RoundRecord[];
  rejected: ClarifyRejected[];
  /** "answer": the last round's batch is waiting for the user; "interpret": the next round runs; "closed": finished. */
  phase: "interpret" | "answer" | "closed";
  doneRequested: boolean;
  termination?: Termination;
}

/** Defaults; batch size and round cap can be overridden per Run. */
export const CLARIFY_LIMITS = {
  batchSize: 5,
  maxRounds: 8,
  maxGapsPerRound: 2,
  /** A follow-up of a follow-up is the deepest allowed. */
  maxFollowUpDepth: 2,
  /** The second /later on the same item defers it. */
  maxLater: 2,
} as const;
