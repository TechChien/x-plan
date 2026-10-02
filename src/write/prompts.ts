import { stringify } from "yaml";
import type { AlignedBrief } from "../clarify/aligned.ts";
import { FACT_SECTION_NAMES } from "../extract/schema.ts";
import type { PromptLibrary } from "../prompts/template.ts";
import { LANGUAGE_NAMES } from "../shared/language.ts";
import type { BuiltPrompt } from "../shared/run-files.ts";
import { citationError, contextIds, type CoverageSets } from "./coverage.ts";
import { factView, sourcesView } from "./items.ts";
import { reviewToYaml, type ReviewUnit } from "./review.ts";
import type { WriteOutline, WrittenFeature } from "./schema.ts";
import { vocabularyLocations, type VocabularyEntry } from "./vocabulary.ts";

const yaml = (value: unknown) => stringify(value, { lineWidth: 0 }).trimEnd();

/** An optional block: absent entirely when there is nothing to put in it, so the messages around it do not change. */
const optionalBlock = (tag: string, value: unknown[] | undefined) => (value?.length ? `\n<${tag}>\n${yaml(value)}\n</${tag}>\n` : "");

export function buildOutlinePrompt(lib: PromptLibrary, aligned: AlignedBrief, sets: CoverageSets): BuiltPrompt {
  return {
    systemPrompt: lib.render("write/outline.system", { outputLanguage: LANGUAGE_NAMES[aligned.outputLanguage] }),
    userMessage: lib.render("write/outline.user", { aligned: alignedToYaml(aligned, sets), coverage: coverageToYaml(sets) }),
  };
}

/**
 * The outline sees everything: each fact marked with what replaced or cancelled it, only confirmed Assumptions,
 * only active Decisions, and the questions still open.
 */
export function alignedToYaml(aligned: AlignedBrief, sets: CoverageSets): string {
  const view: Record<string, unknown[]> = {};
  for (const section of FACT_SECTION_NAMES) {
    const items = aligned.brief[section] as unknown as Record<string, unknown>[];
    if (!items.length) continue;
    view[section] = items.map((item) => {
      const reason = sets.forbidden.get(item.id as string);
      return {
        ...factView(item),
        ...(reason?.kind === "superseded" ? { replacedBy: reason.by } : {}),
        ...(reason?.kind === "cancelled-feature" ? { cancelledWith: reason.featureIds } : {}),
      };
    });
  }
  const confirmed = aligned.brief.assumptions.filter((a) => aligned.confirmedBy[a.id]);
  if (confirmed.length) view.assumptions = confirmed.map((a) => ({ ...factView(a as unknown as Record<string, unknown>), confirmedBy: aligned.confirmedBy[a.id] }));
  const active = aligned.decisions.filter((d) => d.status === "active");
  if (active.length) {
    view.decisions = active.map((d) => ({
      id: d.id,
      effect: d.effect,
      conclusion: d.conclusion,
      answer: d.answerText,
      ...(d.supersedes.length ? { supersedes: d.supersedes } : {}),
      ...(d.confirms.length ? { confirms: d.confirms } : {}),
      ...(d.relatedIds.length ? { relatedIds: d.relatedIds } : {}),
    }));
  }
  const open = aligned.agenda.filter((a) => a.status === "unresolved" || a.status === "deferred");
  if (open.length) view.openItems = open.map((a) => ({ id: a.id, status: a.status, question: a.question, ...(a.relatedIds.length ? { relatedIds: a.relatedIds } : {}) }));
  return yaml(view);
}

export function coverageToYaml(sets: CoverageSets): string {
  return yaml({
    mustCover: sets.mustCover,
    notBehavioralAllowed: sets.notBehavioralAllowed,
    ...(sets.notBehavioralBlocked.size
      ? { notBehavioralBlocked: Object.fromEntries([...sets.notBehavioralBlocked].map(([id, b]) => [id, `redefines ${b.terms.join(", ")}, which ${b.mentionedIn.join(", ")} uses`])) }
      : {}),
    cannotCite: Object.fromEntries([...sets.forbidden.keys()].map((id) => [id, citationError(sets, id)])),
  });
}

/**
 * A writer sees only what its Feature needs (ADR 0015): the shared `<context>` first, so every writer's message
 * starts the same and the prefix is cached, then its slice of the outline with the items it cites.
 */
export function buildWriterPrompt(
  lib: PromptLibrary,
  aligned: AlignedBrief,
  sets: CoverageSets,
  outline: WriteOutline,
  featureId: string,
  opts: { vocabulary?: VocabularyEntry[] } = {},
): BuiltPrompt {
  return {
    systemPrompt: lib.render("write/writer.system", { outputLanguage: LANGUAGE_NAMES[aligned.outputLanguage] }),
    userMessage: lib.render("write/writer.user", {
      context: contextToYaml(aligned, sets, outline),
      vocabulary: optionalBlock("vocabulary", opts.vocabulary?.map(({ canonical, definition, avoid }) => ({ canonical, definition, ...(avoid.length ? { avoid } : {}) }))),
      feature: featureToYaml(outline, featureId),
      sources: sourcesToYaml(aligned, sets, outline, featureId),
    }),
  };
}

/** The names steps are written with; a redefined one appears as the Decision that redefined it. */
export function contextToYaml(aligned: AlignedBrief, sets: CoverageSets, outline: WriteOutline): string {
  const decisions = new Map(aligned.decisions.map((d) => [d.id, d]));
  const names = sourcesView(aligned, contextIds(aligned, sets)).map((v) => {
    const d = decisions.get(v.id as string);
    return d ? { ...v, replaces: d.supersedes } : v;
  });
  return yaml({ names, features: outline.features.map((f) => ({ id: f.id, name: f.name })) });
}

export function featureToYaml(outline: WriteOutline, featureId: string): string {
  const feature = outline.features.find((f) => f.id === featureId);
  if (!feature) throw new Error(`${featureId} is not in the outline`);
  const ruleOf = new Map(feature.rules.flatMap((r) => r.scenarioIds.map((id) => [id, r.title] as const)));
  return yaml({
    id: feature.id,
    name: feature.name,
    description: feature.description,
    ...(feature.isNew ? { addedBy: feature.sourceIds } : {}),
    ...(feature.rules.length ? { rules: feature.rules.map((r) => ({ title: r.title, sourceId: r.sourceId })) } : {}),
    scenarios: outline.scenarios
      .filter((s) => s.featureId === featureId)
      .map((s) => ({
        id: s.id,
        title: s.title,
        kind: s.kind,
        ...(ruleOf.has(s.id) ? { rule: ruleOf.get(s.id) } : {}),
        sourceIds: s.effectiveSourceIds,
        ...(s.agendaIds.length ? { agendaIds: s.agendaIds } : {}),
        ...(s.openReason ? { openReason: s.openReason } : {}),
      })),
  });
}

/** What the Feature's scenarios stand on and leave open, minus what `<context>` already shows. */
export function sourcesToYaml(aligned: AlignedBrief, sets: CoverageSets, outline: WriteOutline, featureId: string): string {
  const scenarios = outline.scenarios.filter((s) => s.featureId === featureId);
  const feature = outline.features.find((f) => f.id === featureId);
  const shown = contextIds(aligned, sets);
  const ids = new Set([...(feature?.sourceIds ?? []), ...scenarios.flatMap((s) => s.effectiveSourceIds)].filter((id) => !shown.has(id)));
  const agendaIds = new Set(scenarios.flatMap((s) => s.agendaIds));
  const open = aligned.agenda.filter((a) => agendaIds.has(a.id)).map((a) => ({ id: a.id, status: a.status, question: a.question }));
  return yaml([...sourcesView(aligned, ids), ...open]);
}

export function buildReviewPrompt(lib: PromptLibrary, aligned: AlignedBrief, units: ReviewUnit[]): BuiltPrompt {
  return {
    systemPrompt: lib.render("write/review.system", {}),
    userMessage: lib.render("write/review.user", { review: reviewToYaml(aligned, units).trimEnd() }),
  };
}

export function buildVocabularyPrompt(
  lib: PromptLibrary,
  aligned: AlignedBrief,
  outline: WriteOutline,
  written: Map<string, WrittenFeature>,
  opts: { existing?: VocabularyEntry[]; featureIds?: Set<string> } = {},
): BuiltPrompt {
  const decisions = new Map(aligned.decisions.map((d) => [d.id, d]));
  const { brief } = aligned;
  const named = [...brief.glossary, ...brief.actors, ...brief.domainEntities, ...brief.dependencies] as unknown as Record<string, unknown>[];
  const names = named.map((item) => {
    const by = aligned.supersededBy[item.id as string];
    return { ...factView(item), ...(by ? { redefinedBy: by.map((id) => ({ id, conclusion: decisions.get(id)?.conclusion ?? "" })) } : {}) };
  });
  const active = aligned.decisions.filter((d) => d.status === "active").map((d) => ({ id: d.id, conclusion: d.conclusion, answer: d.answerText }));
  return {
    systemPrompt: lib.render("write/vocabulary.system", { outputLanguage: LANGUAGE_NAMES[aligned.outputLanguage] }),
    userMessage: lib.render("write/vocabulary.user", {
      names: names.length ? yaml(names) : "[]",
      decisions: active.length ? yaml(active) : "[]",
      existing: optionalBlock("existing", opts.existing),
      text: yaml(Object.fromEntries(vocabularyLocations(outline, written, opts.featureIds))),
    }),
  };
}
