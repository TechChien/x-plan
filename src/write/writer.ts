import type { AlignedBrief } from "../clarify/aligned.ts";
import { FACT_SECTION_NAMES } from "../extract/schema.ts";
import { languageErrors, type OutputLanguage } from "../shared/language.ts";
import { citationError, contextIds, type CoverageSets } from "./coverage.ts";
import type { AcceptedScenario, FeatureSubmission, PlannedScenario, Step, WriteOutline, WrittenFeature, WrittenScenario } from "./schema.ts";

export interface FeatureCheckContext {
  aligned: AlignedBrief;
  sets: CoverageSets;
  outline: WriteOutline;
  featureId: string;
  /** No retry is left: accept what is usable. */
  isLast: boolean;
  language: OutputLanguage;
}

export interface FeatureIssue {
  /** e.g. `scenarios[1].examples[0].rows[2]`, `background[0]`, `description` or `scenarios`. */
  path: string;
  errors: string[];
}

export interface FeatureRejected {
  path: string;
  item: unknown;
  errors: string[];
}

export interface FeatureCheckResult {
  /** Everything wrong with the submission: the feedback for a retry. */
  issues: FeatureIssue[];
  accepted: WrittenFeature;
  /** Scenarios set aside because they cite what they may not or would not render. */
  rejected: FeatureRejected[];
  /** Outline scenarios with no accepted scenario, whether never written or set aside; rendered `@unwritten`. */
  missing: string[];
  /** Accepted parts still in the wrong language. */
  languageWarnings: string[];
}

/**
 * Validates one writer's submission (plan §1.7). Scenarios that cite outside what they were given or whose Examples
 * would not render are set aside; numbers without a source, a misplaced Then or openReason are flagged but kept, so
 * on the last attempt they render `@unverified`.
 */
export function checkFeature(submission: FeatureSubmission, ctx: FeatureCheckContext): FeatureCheckResult {
  const { aligned, sets, featureId } = ctx;
  const issues: FeatureIssue[] = [];
  const rejected: FeatureRejected[] = [];
  const languageWarnings: string[] = [];
  const report = (path: string, errors: string[]) => errors.length && issues.push({ path, errors });

  const planned = ctx.outline.scenarios.filter((s) => s.featureId === featureId);
  const plannedById = new Map(planned.map((s) => [s.id, s]));
  const feature = ctx.outline.features.find((f) => f.id === featureId);
  const shared = [...contextIds(aligned, sets), ...(sets.citable.has(featureId) ? [featureId] : []), ...(feature?.sourceIds ?? [])];
  const texts = itemTexts(aligned);
  const names = verbatimNames(aligned);

  const citeErrors = (ids: string[], allowed: Set<string>, where: string) =>
    ids.filter((id) => !allowed.has(id)).map((id) => citationError(sets, id) ?? `${id} is not in <sources> for ${where} or in <context>`);
  const numberErrors = (text: string, sourceIds: string[]) => {
    const given = new Set(sourceIds.flatMap((id) => numbersIn(texts.get(id) ?? "", { chinese: true })));
    return [...new Set(numbersIn(withoutPlaceholders(text)))]
      .filter((n) => !given.has(n))
      .map((n) => `${n} is not given by ${sourceIds.join(", ") || "any cited item"}; cite the item that gives it, or write <…> for a value no item gives`);
  };
  const language = (path: string, value: unknown) => {
    const errors = languageErrors(value, ctx.language);
    report(path, errors);
    if (errors.length) languageWarnings.push(path);
  };

  // Description and Background.
  language("description", { description: submission.description });
  const backgroundAllowed = new Set([...planned.flatMap((s) => s.effectiveSourceIds), ...shared]);
  let background: Step[] = [];
  const backgroundUnverified: string[] = [];
  const backgroundFatal = submission.background.some((st, i) => {
    const errors = citeErrors(st.sourceIds, backgroundAllowed, `any scenario of ${featureId}`);
    report(`background[${i}]`, errors);
    return errors.length > 0;
  });
  if (backgroundFatal) rejected.push({ path: "background", item: submission.background, errors: ["the Background cites what it may not"] });
  else {
    background = submission.background;
    submission.background.forEach((st, i) => {
      const errors = numberErrors(st.text, st.sourceIds);
      report(`background[${i}]`, errors);
      backgroundUnverified.push(...errors);
    });
    if (background.length) language("background", { text: background.map((st) => verbatimStripped(st.text, names)) });
  }

  // Scenarios.
  const seen = new Set<string>();
  const accepted: AcceptedScenario[] = [];
  submission.scenarios.forEach((s, i) => {
    const path = `scenarios[${i}]`;
    const plan = plannedById.get(s.id);
    if (!plan) return void (report(path, [`${s.id} is not a scenario of ${featureId}`]), rejected.push({ path, item: s, errors: [`not in the outline`] }));
    if (seen.has(s.id)) return void (report(path, [`${s.id} is written twice`]), rejected.push({ path, item: s, errors: ["written twice"] }));
    seen.add(s.id);

    const result = checkScenario(s, plan, path, {
      allowed: new Set([...plan.effectiveSourceIds, ...shared]),
      citeErrors,
      numberErrors,
    });
    for (const issue of result.issues) report(issue.path, issue.errors);
    if (result.fatal.length) return void rejected.push({ path, item: s, errors: result.fatal });

    const { openReason, ...rest } = s;
    const downgraded = Boolean(openReason?.trim()) && (plan.kind === "specified" || plan.kind === "derived");
    accepted.push({
      ...rest,
      ...(downgraded ? { openReason } : {}),
      kind: downgraded ? "open" : plan.kind,
      ...(result.soft.length ? { unverified: result.soft } : {}),
    });
    language(path, {
      text: s.steps.map((st) => verbatimStripped(st.text, names)),
      name: s.examples.map((e) => e.name),
      cells: s.examples.flatMap((e) => e.rows.flatMap((r) => r.cells.map((c) => verbatimStripped(c, names)))),
    });
  });
  const notSubmitted = planned.filter((p) => !seen.has(p.id)).map((p) => p.id);
  report("scenarios", notSubmitted.map((id) => `${id} is missing`));

  const order = new Map(planned.map((p, i) => [p.id, i]));
  accepted.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const missing = planned.filter((p) => !accepted.some((a) => a.id === p.id)).map((p) => p.id);
  return {
    issues,
    accepted: {
      featureId,
      description: submission.description,
      background,
      scenarios: accepted,
      ...(backgroundUnverified.length ? { backgroundUnverified } : {}),
    },
    rejected,
    missing,
    languageWarnings,
  };
}

interface ScenarioCheck {
  issues: FeatureIssue[];
  /** Errors that set the scenario aside. */
  fatal: string[];
  /** Errors it is kept with on the last attempt. */
  soft: string[];
}

function checkScenario(
  s: WrittenScenario,
  plan: PlannedScenario,
  path: string,
  fns: {
    allowed: Set<string>;
    citeErrors: (ids: string[], allowed: Set<string>, where: string) => string[];
    numberErrors: (text: string, sourceIds: string[]) => string[];
  },
): ScenarioCheck {
  const out: ScenarioCheck = { issues: [], fatal: [], soft: [] };
  const add = (at: string, errors: string[], kind: "fatal" | "soft") => {
    if (!errors.length) return;
    out.issues.push({ path: at, errors });
    out[kind].push(...errors);
  };
  const derived = plan.kind === "derived";

  // Rule 2, then rule 4 for steps.
  s.steps.forEach((st, j) => add(`${path}.steps[${j}]`, fns.citeErrors(st.sourceIds, fns.allowed, s.id), "fatal"));
  s.examples.forEach((e, j) => e.rows.forEach((r, k) => add(`${path}.examples[${j}].rows[${k}]`, fns.citeErrors(r.sourceIds, fns.allowed, s.id), "fatal")));
  if (!derived) s.steps.forEach((st, j) => add(`${path}.steps[${j}]`, fns.numberErrors([st.text, ...(st.dataTable?.flat() ?? [])].join("\n"), st.sourceIds), "soft"));

  // Rule 3: Examples render only if every column is used and every row is full.
  const stepText = s.steps.map((st) => [st.text, ...(st.dataTable?.flat() ?? [])].join("\n")).join("\n");
  s.examples.forEach((e, j) => {
    const at = `${path}.examples[${j}]`;
    const errors: string[] = [];
    for (const col of e.header) if (!stepText.includes(`<${col}>`)) errors.push(`column ${col} is not used as <${col}> in any step`);
    if (new Set(e.header).size !== e.header.length) errors.push("a column name is repeated");
    e.rows.forEach((r, k) => r.cells.length !== e.header.length && errors.push(`row ${k} has ${r.cells.length} cells for ${e.header.length} columns`));
    if (derived && !e.derived) errors.push(`${s.id} is derived, so every Examples block is derived`);
    add(at, errors, "fatal");
    if (!derived && !e.derived) e.rows.forEach((r, k) => add(`${at}.rows[${k}]`, fns.numberErrors(r.cells.join("\n"), r.sourceIds), "soft"));
  });

  // Rule 5 and the Then step.
  const scenarioErrors: string[] = [];
  const named = plan.kind === "open" || plan.kind === "deferred";
  if (s.openReason !== undefined && named) scenarioErrors.push(`${s.id} is already ${plan.kind}; openReason is only for a specified or derived scenario`);
  const open = named || Boolean(s.openReason?.trim());
  const hasThen = s.steps.some((st) => st.keyword === "Then");
  if (!open && !hasThen) scenarioErrors.push(`${s.id} has no Then step`);
  if (open && hasThen) {
    const kind = named ? plan.kind : "open";
    scenarioErrors.push(`${s.id} is ${kind}, so it has no Then step: the program adds one naming ${plan.agendaIds.join(", ") || "what is missing"}`);
  }
  add(path, scenarioErrors, "soft");
  return out;
}

/**
 * Keys left out when reading an item's numbers: ids, whose digits are not values a step could state, and Evidence,
 * whose quotes may carry what the user replaced (see `sourcesView`). The writer never sees quotes either.
 */
const ID_KEYS = new Set(["id", "featureId", "featureIds", "actorIds", "dependsOn", "relatedIds", "targetId", "file", "evidence"]);

/** What each citable item says, for finding the numbers it gives: every fact field, a Decision's conclusion and Answer. */
function itemTexts(aligned: AlignedBrief): Map<string, string> {
  const texts = new Map<string, string>();
  const walk = (value: unknown, out: string[]) => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => walk(v, out));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) if (!ID_KEYS.has(k)) walk(v, out);
  };
  for (const item of [...FACT_SECTION_NAMES.flatMap((s) => aligned.brief[s] as { id: string }[]), ...aligned.brief.assumptions]) {
    const out: string[] = [];
    walk(item, out);
    texts.set(item.id, out.join("\n"));
  }
  for (const d of aligned.decisions) texts.set(d.id, `${d.conclusion}\n${d.answerText}`);
  return texts;
}

/** Names copied from the documents, longest first so a longer name is removed before a name inside it. */
function verbatimNames(aligned: AlignedBrief): string[] {
  const { brief } = aligned;
  const names = [...brief.glossary.flatMap((t) => [t.term, ...t.aliases]), ...[...brief.actors, ...brief.domainEntities, ...brief.dependencies].map((it) => it.name)];
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
}

const PLACEHOLDER = /<[^<>]*>/g;
const QUOTED = /「[^」]*」|『[^』]*』|"[^"]*"|“[^”]*”/g;

function withoutPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER, " ");
}

/** The text without what keeps its original wording: placeholders, quoted values and names from the documents. */
function verbatimStripped(text: string, names: string[]): string {
  let out = withoutPlaceholders(text).replace(QUOTED, " ");
  for (const n of names) out = out.split(n).join(" ");
  return out;
}

const CHINESE_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/**
 * The numbers in `text`, as Arabic numerals. Full-width digits always count; Chinese numerals up to 99 only with
 * `chinese`, which is for source text: in a step, 一 in 一般 is not a number.
 */
export function numbersIn(text: string, opts: { chinese?: boolean } = {}): string[] {
  const normalized = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const pattern = opts.chinese ? /\d+(?:\.\d+)?|[零〇一二兩两三四五六七八九十]+/g : /\d+(?:\.\d+)?/g;
  const out: string[] = [];
  for (const [match] of normalized.matchAll(pattern)) {
    const value = /^\d/.test(match) ? match : chineseNumber(match);
    if (value !== undefined) out.push(value);
  }
  return out;
}

function chineseNumber(s: string): string | undefined {
  const digit = (c: string | undefined) => (c === undefined || c === "" ? undefined : CHINESE_DIGITS[c]);
  const parts = s.split("十");
  if (parts.length === 1) return s.length === 1 ? String(CHINESE_DIGITS[s]) : undefined;
  if (parts.length !== 2 || parts[0]!.length > 1 || parts[1]!.length > 1) return undefined;
  const tens = parts[0] === "" ? 1 : digit(parts[0]);
  const ones = parts[1] === "" ? 0 : digit(parts[1]);
  return tens === undefined || ones === undefined ? undefined : String(tens * 10 + ones);
}
