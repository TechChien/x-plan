import { AstBuilder, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin";
import { IdGenerator } from "@cucumber/messages";
import type { AlignedBrief } from "../clarify/aligned.ts";
import type { OutputLanguage } from "../shared/language.ts";
import type { AcceptedScenario, Examples, PlannedFeature, PlannedScenario, ScenarioKind, Step, WriteOutline, WrittenFeature } from "./schema.ts";

/** Words that are part of the Gherkin content, so they follow the output language. */
const LABELS: Record<OutputLanguage, { open: string; deferred: string; sep: string; newFeature: string }> = {
  en: { open: "open", deferred: "deferred", sep: ": ", newFeature: "Added by a Clarify decision; the requirement documents have no section for it." },
  zh: { open: "待決", deferred: "延後", sep: "：", newFeature: "此功能來自 Clarify 的決定，需求文件中沒有對應段落。" },
  cn: { open: "待决", deferred: "延后", sep: "：", newFeature: "此功能来自 Clarify 的决定，需求文件中没有对应段落。" },
};

export interface FeatureRenderContext {
  aligned: AlignedBrief;
  outline: WriteOutline;
  /** Absent when the Feature's writer failed: every scenario renders `@unwritten`. */
  written?: WrittenFeature;
  language: OutputLanguage;
}

/** One `.feature` file (plan §1.9): English keywords, content in the output language, tags in a fixed order. */
export function renderFeature(feature: PlannedFeature, ctx: FeatureRenderContext): string {
  const labels = LABELS[ctx.language];
  const byId = new Map(ctx.outline.scenarios.map((s) => [s.id, s]));
  const writtenById = new Map((ctx.written?.scenarios ?? []).map((s) => [s.id, s]));
  const questions = new Map(ctx.aligned.agenda.map((a) => [a.id, a.question]));
  const out: string[] = [];

  out.push(tags([feature.id, ...feature.sourceIds]), `Feature: ${oneLine(feature.name)}`);
  const description = ctx.written?.description ?? feature.description;
  for (const line of description.split(/\r?\n/)) if (line.trim()) out.push(`  ${safeDescriptionLine(line.trim())}`);
  if (feature.isNew) out.push(`  ${labels.newFeature}`);

  if (ctx.written?.background.length) {
    out.push("", "  Background:");
    for (const step of ctx.written.background) pushStep(out, step, "    ");
  }

  const scenario = (id: string, indent: string) => {
    const plan = byId.get(id)!;
    out.push("");
    pushScenario(out, plan, writtenById.get(id), indent, { labels, questions });
  };
  // Scenarios without a Rule come first: Gherkin puts every scenario after a Rule into that Rule.
  for (const id of feature.scenarioIds) scenario(id, "  ");
  for (const rule of feature.rules) {
    out.push("", `  Rule: ${oneLine(rule.title)}`);
    for (const id of rule.scenarioIds) scenario(id, "    ");
  }
  return `${out.join("\n")}\n`;
}

function pushScenario(
  out: string[],
  plan: PlannedScenario,
  written: AcceptedScenario | undefined,
  indent: string,
  ctx: { labels: (typeof LABELS)[OutputLanguage]; questions: Map<string, string> },
): void {
  const kind: ScenarioKind = written?.kind ?? plan.kind;
  const kindTags = [
    kind === "derived" && "derived",
    kind === "open" && "open",
    kind === "deferred" && "deferred",
    written?.unverified?.length && "unverified",
    !written && "unwritten",
    plan.effectiveSourceIds.some((id) => id.startsWith("NFR-")) && "nfr",
  ].filter((t): t is string => Boolean(t));
  out.push(`${indent}${tags([plan.id, ...kindTags, ...plan.agendaIds, ...plan.effectiveSourceIds])}`);
  const outline = Boolean(written?.examples.length);
  out.push(`${indent}${outline ? "Scenario Outline" : "Scenario"}: ${oneLine(plan.title)}`);
  if (!written) return;

  const inner = `${indent}  `;
  for (const step of written.steps) pushStep(out, step, inner);
  if (kind === "open" || kind === "deferred") {
    const label = kind === "open" ? ctx.labels.open : ctx.labels.deferred;
    const lines = plan.agendaIds.length
      ? plan.agendaIds.map((id) => `<${label} ${id}${ctx.labels.sep}${oneLine(ctx.questions.get(id) ?? "")}>`)
      : [`<${label}${ctx.labels.sep}${oneLine(written.openReason ?? plan.openReason ?? "")}>`];
    lines.forEach((text, i) => out.push(`${inner}${i === 0 ? "Then" : "And"} ${text}`));
  }
  for (const e of written.examples) pushExamples(out, e, inner);
}

function pushStep(out: string[], step: Step, indent: string): void {
  out.push(`${indent}${step.keyword} ${oneLine(step.text)}`);
  if (step.dataTable?.length) out.push(...table(step.dataTable, `${indent}  `));
}

function pushExamples(out: string[], e: Examples, indent: string): void {
  out.push("");
  if (e.derived) out.push(`${indent}@derived`);
  out.push(`${indent}Examples: ${oneLine(e.name)}`, ...table([e.header, ...e.rows.map((r) => r.cells)], `${indent}  `));
}

function table(rows: string[][], indent: string): string[] {
  const cells = rows.map((r) => r.map(escapeCell));
  const widths = cells[0]!.map((_, i) => Math.max(...cells.map((r) => displayWidth(r[i] ?? ""))));
  return cells.map((r) => `${indent}| ${r.map((c, i) => c + " ".repeat(widths[i]! - displayWidth(c))).join(" | ")} |`);
}

function escapeCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "\\n");
}

/** Columns a string takes in a monospace font: CJK and full-width characters take two. */
function displayWidth(text: string): number {
  let width = 0;
  for (const c of text) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1;
  return width;
}

function tags(ids: string[]): string {
  return [...new Set(ids)].map((id) => `@${id}`).join(" ");
}

function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ").trim();
}

/** A description line Gherkin would read as a tag, comment, table, doc string or keyword gets a neutral lead. */
function safeDescriptionLine(line: string): string {
  return /^(@|#|\||"""|```|(Feature|Rule|Background|Scenario Outline|Scenario Template|Scenario|Example|Examples|Scenarios):)/.test(line) ? `· ${line}` : line;
}

/** Parser errors in `text`; empty when it is valid Gherkin. A non-empty result for a rendering is a bug in rendering. */
export function gherkinErrors(text: string): string[] {
  const parser = new Parser(new AstBuilder(IdGenerator.incrementing()), new GherkinClassicTokenMatcher());
  try {
    parser.parse(text);
    return [];
  } catch (e) {
    return (e as Error).message.split("\n").filter((l) => l.trim() && !/^Parser errors:?$/.test(l.trim()));
  }
}

export interface TracedScenario {
  id: string;
  featureId: string;
  title: string;
  kind: ScenarioKind;
  status: "written" | "unwritten";
  sourceIds: string[];
  agendaIds: string[];
  openReason?: string;
  unverified?: string[];
  steps: Step[];
  examples: Examples[];
}

/** `03-trace.json`: what every scenario, step and Examples row stands on. */
export interface WriteTrace {
  features: { id: string; written: boolean; background: Step[]; backgroundUnverified?: string[] }[];
  scenarios: TracedScenario[];
}

export function buildTrace(outline: WriteOutline, written: Map<string, WrittenFeature>): WriteTrace {
  const accepted = new Map([...written.values()].flatMap((f) => f.scenarios.map((s) => [s.id, s] as const)));
  return {
    features: outline.features.map((f) => {
      const w = written.get(f.id);
      return { id: f.id, written: Boolean(w), background: structuredClone(w?.background ?? []), ...(w?.backgroundUnverified ? { backgroundUnverified: [...w.backgroundUnverified] } : {}) };
    }),
    scenarios: outline.scenarios.map((p) => {
      const s = accepted.get(p.id);
      const openReason = s?.openReason ?? p.openReason;
      return {
        id: p.id,
        featureId: p.featureId,
        title: p.title,
        kind: s?.kind ?? p.kind,
        status: s ? "written" : "unwritten",
        sourceIds: [...p.effectiveSourceIds],
        agendaIds: [...p.agendaIds],
        ...(openReason ? { openReason } : {}),
        ...(s?.unverified ? { unverified: [...s.unverified] } : {}),
        steps: structuredClone(s?.steps ?? []),
        examples: structuredClone(s?.examples ?? []),
      };
    }),
  };
}

/**
 * Groups of written scenarios, across Features, with the same Given and the same Then: the same requirement written
 * twice. Steps before the first When (or Then) count as Given, steps from the first Then on as Then; wording is
 * compared ignoring case, quotes and backticks. A shared Then under different Givens, as a derived edge has, is not one.
 */
export function duplicateScenarios(trace: WriteTrace): string[][] {
  const norm = (t: string) => t.toLowerCase().replace(/[`"'“”]/g, "").replace(/\s+/g, " ").trim();
  const groups = new Map<string, string[]>();
  for (const s of trace.scenarios) {
    if (s.status !== "written") continue;
    const given: string[] = [];
    const then: string[] = [];
    let part: "given" | "when" | "then" = "given";
    for (const st of s.steps) {
      if (st.keyword === "When") part = "when";
      else if (st.keyword === "Then") part = "then";
      if (part === "given") given.push(norm(st.text));
      else if (part === "then") then.push(norm(st.text));
    }
    if (!then.length) continue;
    const examples = s.examples.map((e) => [e.header, e.rows.map((r) => r.cells)]);
    const key = JSON.stringify([[...new Set(given)].sort(), [...new Set(then)].sort(), examples]);
    groups.set(key, [...(groups.get(key) ?? []), s.id]);
  }
  return [...groups.values()].filter((ids) => ids.length > 1);
}

export interface SpecRenderContext {
  aligned: AlignedBrief;
  outline: WriteOutline;
  written: Map<string, WrittenFeature>;
}

/** `03-spec.md`: what the `.feature` files cannot hold, and every place the reader should look at first. */
export function renderSpec(ctx: SpecRenderContext): string {
  const { aligned, outline, written } = ctx;
  const { brief } = aligned;
  const trace = buildTrace(outline, written);
  const decisions = new Map(aligned.decisions.map((d) => [d.id, d]));
  const replaced = (id: string) => {
    const by = aligned.supersededBy[id];
    return by ? ` — replaced by ${by.map((d) => `${d}: ${decisions.get(d)?.conclusion ?? ""}`).join("; ")}` : "";
  };
  const out: string[] = ["# Write spec", ""];
  const section = (title: string, lines: string[]) => out.push(`## ${title}`, "", ...(lines.length ? lines : ["_None._"]), "");

  const tableLines = outline.features.map((f) => {
    const own = trace.scenarios.filter((s) => s.featureId === f.id);
    const count = (pred: (s: TracedScenario) => boolean) => own.filter(pred).length;
    return `| [${f.id}.feature](features/${f.id}.feature) | ${f.name} | ${own.length} | ${count((s) => s.kind === "open")} | ${count((s) => s.kind === "deferred")} | ${count((s) => s.kind === "derived")} | ${count((s) => Boolean(s.unverified?.length))} | ${count((s) => s.status === "unwritten")} |`;
  });
  section("Features", tableLines.length ? ["| File | Feature | Scenarios | @open | @deferred | @derived | @unverified | @unwritten |", "|---|---|---|---|---|---|---|---|", ...tableLines] : []);

  section("Actors", brief.actors.map((a) => `- **${a.id}** ${a.name}${a.description && a.description !== a.name ? `: ${a.description}` : ""}${replaced(a.id)}`));
  section(
    "Domain entities",
    brief.domainEntities.map((e) => {
      const rel = e.relationships.map((r) => `${r.kind} ${r.targetId}`).join(", ");
      return `- **${e.id}** ${e.name}: ${e.description}${e.attributes.length ? ` — attributes: ${e.attributes.join(", ")}` : ""}${rel ? ` — ${rel}` : ""}${replaced(e.id)}`;
    }),
  );
  section("Non-functional requirements", brief.nonFunctional.map((n) => `- **${n.id}** (${n.category}) ${n.requirement}${n.target ? ` — target: ${n.target}` : ""}${replaced(n.id)}`));
  section("Constraints", brief.constraints.map((c) => `- **${c.id}** (${c.type}) ${c.constraint}${replaced(c.id)}`));
  section("Dependencies", brief.dependencies.map((d) => `- **${d.id}** ${d.name} (${d.type}): ${d.description}${replaced(d.id)}`));
  section("Out of scope", brief.outOfScope.map((o) => `- **${o.id}** ${o.item}${replaced(o.id)}`));

  section(
    "Cancelled Features",
    brief.features
      .filter((f) => aligned.supersededBy[f.id])
      .map((f) => {
        const by = aligned.supersededBy[f.id]!.map((id) => decisions.get(id)).filter((d) => d !== undefined);
        return `- **${f.id}** ${f.name} — ${by.map((d) => `${d.id}: ${d.conclusion} (“${d.answerText}”)`).join("; ")}`;
      }),
  );
  section(
    "Features added in Clarify",
    outline.features.filter((f) => f.isNew).map((f) => `- **${f.id}** ${f.name} — ${f.sourceIds.map((id) => `${id}: ${decisions.get(id)?.conclusion ?? ""}`).join("; ")}`),
  );

  section("Not written as scenarios", outline.notBehavioral.map((n) => `- **${n.id}** ${describe(aligned, n.id)} — ${n.reason}`));
  section("Uncovered", outline.uncovered.map((id) => `- **${id}** ${describe(aligned, id)}`));

  const questions = new Map(aligned.agenda.map((a) => [a.id, a.question]));
  const inScenario = new Set(outline.scenarios.flatMap((s) => s.agendaIds));
  section("Open items", [
    ...trace.scenarios
      .filter((s) => s.kind === "open" || s.kind === "deferred")
      .flatMap((s) => (s.agendaIds.length ? s.agendaIds.map((id) => `- ${s.id} @${s.kind} ${id}: ${questions.get(id) ?? ""}`) : [`- ${s.id} @${s.kind}: ${s.openReason ?? ""}`])),
    ...aligned.agenda.filter((a) => (a.status === "unresolved" || a.status === "deferred") && !inScenario.has(a.id)).map((a) => `- ${a.id} (${a.status}, in no scenario): ${a.question}`),
  ]);

  section("Unverified", [
    ...trace.features.filter((f) => f.backgroundUnverified?.length).map((f) => `- ${f.id} Background: ${f.backgroundUnverified!.join("; ")}`),
    ...trace.scenarios.filter((s) => s.unverified?.length).map((s) => `- ${s.id} ${s.title}: ${s.unverified!.join("; ")}`),
  ]);
  section(
    "Duplicate scenarios",
    duplicateScenarios(trace).map((ids) => `- ${ids.join(", ")}: same Given and Then — ${trace.scenarios.find((s) => s.id === ids[0])!.title}`),
  );
  section("Unwritten", [
    ...trace.features.filter((f) => !f.written).map((f) => `- ${f.id}: no writer result`),
    ...trace.scenarios.filter((s) => s.status === "unwritten" && written.has(s.featureId)).map((s) => `- ${s.id} ${s.title}`),
  ]);
  return `${out.join("\n").trimEnd()}\n`;
}

/** An item's wording in one line, for lists. */
function describe(aligned: AlignedBrief, id: string): string {
  const d = aligned.decisions.find((x) => x.id === id);
  if (d) return d.conclusion;
  const { brief } = aligned;
  const item =
    brief.features.find((x) => x.id === id)?.name ??
    brief.businessRules.find((x) => x.id === id)?.rule ??
    brief.acceptanceCriteria.find((x) => x.id === id)?.text;
  return item ?? "";
}
