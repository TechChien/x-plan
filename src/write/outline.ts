import type { AlignedBrief } from "../clarify/aligned.ts";
import { languageErrors, type OutputLanguage } from "../shared/language.ts";
import { citationError, uncovered as uncoveredIds, type CoverageSets } from "./coverage.ts";
import type { OutlineFeature, OutlineRule, OutlineScenario, OutlineSubmission, PlannedFeature, PlannedScenario, WriteOutline } from "./schema.ts";

export interface OutlineCheckContext {
  aligned: AlignedBrief;
  sets: CoverageSets;
  /** No retry is left: accept what is usable. */
  isLast: boolean;
  language: OutputLanguage;
}

export interface OutlineIssue {
  /** e.g. `features[0].rules[1].scenarios[2]`, `notBehavioral[0]` or `coverage`. */
  path: string;
  errors: string[];
}

export interface OutlineRejected {
  path: string;
  item: unknown;
  errors: string[];
}

export interface OutlineCheckResult {
  /** Everything wrong with the submission, language included: the feedback for a retry. */
  issues: OutlineIssue[];
  /** The usable part: blocks, Rules and scenarios without errors other than language. */
  accepted: OutlineSubmission;
  /** Parts set aside; on the last attempt they go to `03-rejected.json`. */
  rejected: OutlineRejected[];
  /** What the accepted part leaves uncovered (ADR 0016). */
  uncovered: string[];
  /** Accepted parts still in the wrong language. */
  languageWarnings: string[];
}

/**
 * Validates the outline against the Aligned Brief (plan §1.5): one block per Feature, citations only of what may be
 * cited, open and deferred scenarios tied to their Agenda Items, and everything that must be covered covered.
 * An erroneous block, Rule or scenario is left out of `accepted` together with what it contains.
 */
export function checkOutline(submission: OutlineSubmission, ctx: OutlineCheckContext): OutlineCheckResult {
  const { aligned, sets } = ctx;
  const issues: OutlineIssue[] = [];
  const rejected: OutlineRejected[] = [];
  const languageWarnings: string[] = [];
  const report = (path: string, errors: string[]) => errors.length && issues.push({ path, errors });
  const reject = (path: string, item: unknown, errors: string[]) => {
    report(path, errors);
    rejected.push({ path, item, errors });
  };
  /** Reports wrong language at `path` and keeps it as a warning: the part is accepted all the same. */
  const language = (path: string, value: unknown) => {
    const errors = languageErrors(value, ctx.language);
    report(path, errors);
    if (errors.length) languageWarnings.push(path);
  };

  const activeNew = new Set(aligned.decisions.filter((d) => d.status === "active" && d.effect === "new").map((d) => d.id));
  const briefFeatures = new Set(aligned.brief.features.map((f) => f.id));
  const nfrTargets = new Map(aligned.brief.nonFunctional.map((n) => [n.id, Boolean(n.target?.trim())]));
  const seenFeatures = new Set<string>();

  const scenarioErrors = (s: OutlineScenario, ruleSource?: string): string[] => {
    const errors = s.sourceIds.map((id) => citationError(sets, id)).filter((e): e is string => Boolean(e));
    const effective = effectiveSources(s, ruleSource);
    const named = s.kind === "open" || s.kind === "deferred";
    if (!named && !effective.length) errors.push("cites nothing: a specified or derived scenario stands on at least one id");
    if (!named && s.agendaIds.length) errors.push("lists agendaIds, but only open and deferred scenarios name Agenda Items");
    if (named) {
      const want = s.kind === "open" ? "unresolved" : "deferred";
      for (const id of s.agendaIds) {
        const status = sets.agenda.get(id);
        if (!status) errors.push(`${id} is not an Agenda Item`);
        else if (status !== want) errors.push(`${id} is ${status}, not ${want}`);
      }
      if (s.kind === "deferred" && !s.agendaIds.length) errors.push("a deferred scenario names the deferred Agenda Item it leaves open");
      if (s.kind === "open" && !s.agendaIds.length && !s.openReason?.trim()) errors.push("an open scenario with no Agenda Item needs openReason: what is missing");
    }
    const decided = effective.some((id) => id.startsWith("DEC-") && sets.citable.has(id));
    for (const id of effective) {
      if (nfrTargets.get(id) === false && !decided) {
        errors.push(`${id} has no target: a Non-functional Requirement without a measurable target goes in 03-spec.md, not a scenario, unless a Decision gives one`);
      }
    }
    return errors;
  };

  const keepScenarios = (scenarios: OutlineScenario[], path: string, ruleSource?: string) =>
    scenarios.filter((s, i) => {
      const at = `${path}.scenarios[${i}]`;
      const errors = scenarioErrors(s, ruleSource);
      if (errors.length) return reject(at, s, errors), false;
      language(at, { title: s.title, ...(s.openReason ? { openReason: s.openReason } : {}) });
      return true;
    });

  const features: OutlineFeature[] = [];
  submission.features.forEach((f, fi) => {
    const path = `features[${fi}]`;
    const errors = featureErrors(f, { sets, briefFeatures, activeNew, seenFeatures });
    if (errors.length) return reject(path, f, errors);
    if (f.newFeature) language(path, { name: f.newFeature.name, description: f.newFeature.description });

    const ruleSources = new Set<string>();
    const rules: OutlineRule[] = [];
    f.rules.forEach((r, ri) => {
      const at = `${path}.rules[${ri}]`;
      const errors = ruleErrors(r, sets, ruleSources);
      if (errors.length) return reject(at, r, errors);
      language(at, { title: r.title });
      rules.push({ ...r, scenarios: keepScenarios(r.scenarios, at, r.sourceId) });
    });
    features.push({ ...f, rules, scenarios: keepScenarios(f.scenarios, path) });
  });

  const seenNotBehavioral = new Set<string>();
  const notBehavioral = submission.notBehavioral.filter((n, i) => {
    const at = `notBehavioral[${i}]`;
    const errors: string[] = [];
    const blocked = sets.notBehavioralBlocked.get(n.id);
    if (blocked) errors.push(`${n.id} redefines ${blocked.terms.join(", ")}, which ${blocked.mentionedIn.join(", ")} uses: cite it in the scenarios for those`);
    else if (!sets.notBehavioralAllowed.includes(n.id)) {
      errors.push(`${n.id} cannot be marked not behavioural: only an active Decision that is new, or that replaces only a Term, Actor, Entity or Dependency, can be`);
    }
    if (seenNotBehavioral.has(n.id)) errors.push(`${n.id} is marked twice`);
    if (!n.reason.trim()) errors.push("give the reason it describes no behaviour");
    seenNotBehavioral.add(n.id);
    if (errors.length) return reject(at, n, errors), false;
    language(at, { reason: n.reason });
    return true;
  });

  const accepted: OutlineSubmission = { features, notBehavioral };
  const uncovered = uncoveredIds(sets, coveredBy(accepted));
  report("coverage", uncovered.map(uncoveredMessage));
  return { issues, accepted, rejected, uncovered, languageWarnings };
}

function featureErrors(
  f: OutlineFeature,
  ctx: { sets: CoverageSets; briefFeatures: Set<string>; activeNew: Set<string>; seenFeatures: Set<string> },
): string[] {
  if (Boolean(f.featureId) === Boolean(f.newFeature)) return ["a block names either featureId or newFeature, not both or neither"];
  if (f.newFeature) {
    const errors = f.newFeature.sourceIds.map((id) => citationError(ctx.sets, id)).filter((e): e is string => Boolean(e));
    if (!f.newFeature.sourceIds.some((id) => ctx.activeNew.has(id))) errors.push("a new Feature must cite an active Decision whose effect is new");
    return errors;
  }
  const id = f.featureId!;
  if (!ctx.briefFeatures.has(id)) return [`${id} is not a Feature in <aligned>`];
  const reason = ctx.sets.forbidden.get(id);
  if (reason?.kind === "superseded") return [`${id} was replaced by ${reason.by.join(", ")}: it gets no .feature`];
  if (ctx.seenFeatures.has(id)) return [`${id} already has a block`];
  ctx.seenFeatures.add(id);
  return [];
}

function ruleErrors(r: OutlineRule, sets: CoverageSets, seen: Set<string>): string[] {
  const cited = citationError(sets, r.sourceId);
  if (cited) return [cited];
  if (!/^(BR|DEC)-/.test(r.sourceId)) return [`${r.sourceId} is not a Business Rule or an active Decision`];
  if (seen.has(r.sourceId)) return [`${r.sourceId} already has a Rule in this Feature`];
  seen.add(r.sourceId);
  return [];
}

function effectiveSources(s: OutlineScenario, ruleSource?: string): string[] {
  return ruleSource && !s.sourceIds.includes(ruleSource) ? [...s.sourceIds, ruleSource] : [...s.sourceIds];
}

/**
 * Ids the outline covers. A Feature is covered by its own block having a scenario, not by being cited elsewhere; an
 * Acceptance Criterion only by a specified scenario, since it is what the documents state (ADR 0016).
 */
function coveredBy(outline: OutlineSubmission): string[] {
  const covered: string[] = outline.notBehavioral.map((n) => n.id);
  for (const f of outline.features) {
    const scenarios = [...f.rules.flatMap((r) => r.scenarios.map((s) => ({ s, rule: r.sourceId }))), ...f.scenarios.map((s) => ({ s, rule: undefined }))];
    if (f.featureId && scenarios.length) covered.push(f.featureId);
    for (const { s, rule } of scenarios) {
      for (const id of effectiveSources(s, rule)) {
        if (id.startsWith("FEAT-") || (id.startsWith("AC-") && s.kind !== "specified")) continue;
        covered.push(id);
      }
    }
  }
  return covered;
}

function uncoveredMessage(id: string): string {
  if (id.startsWith("FEAT-")) return `${id} has no block with a scenario`;
  if (id.startsWith("AC-")) return `${id} is cited by no specified scenario: an Acceptance Criterion is what the documents state, so only a specified scenario covers it`;
  return `${id} is cited by no scenario and not marked not behavioural`;
}

/** Numbers the accepted outline: SCN ids in reading order, FEAT-N ids for new Features. */
export function applyOutline(accepted: OutlineSubmission, aligned: AlignedBrief, uncovered: string[]): WriteOutline {
  const briefFeatures = new Map(aligned.brief.features.map((f) => [f.id, f]));
  const scenarios: PlannedScenario[] = [];
  let nextScn = 1;
  let nextNew = 1;
  const plan = (s: OutlineScenario, featureId: string, ruleIndex?: number, ruleSource?: string): string => {
    const id = `SCN-${nextScn++}`;
    scenarios.push({ ...structuredClone(s), id, featureId, ...(ruleIndex !== undefined ? { ruleIndex } : {}), effectiveSourceIds: effectiveSources(s, ruleSource) });
    return id;
  };

  const features: PlannedFeature[] = accepted.features.map((f) => {
    const brief = f.featureId ? briefFeatures.get(f.featureId) : undefined;
    const id = brief ? brief.id : `FEAT-N${nextNew++}`;
    const rules = f.rules.map((r, ri) => ({ sourceId: r.sourceId, title: r.title, scenarioIds: r.scenarios.map((s) => plan(s, id, ri, r.sourceId)) }));
    return {
      id,
      isNew: !brief,
      name: brief?.name ?? f.newFeature!.name,
      description: brief?.description ?? f.newFeature!.description,
      sourceIds: brief ? [] : [...f.newFeature!.sourceIds],
      rules,
      scenarioIds: f.scenarios.map((s) => plan(s, id)),
    };
  });

  return { features, scenarios, notBehavioral: structuredClone(accepted.notBehavioral), uncovered: [...uncovered] };
}
