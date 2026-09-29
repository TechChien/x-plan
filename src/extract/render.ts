import type { AnalysisLog } from "./apply-analysis.ts";
import type { Evidence, RejectedItem, RequirementBrief } from "./schema.ts";

const TITLES: Record<string, string> = {
  actors: "角色 Actors",
  features: "功能 Features",
  businessRules: "業務規則 Business Rules",
  acceptanceCriteria: "驗收條件 Acceptance Criteria",
  nonFunctional: "非功能需求 Non-functional Requirements",
  domainEntities: "領域實體 Domain Entities",
  glossary: "名詞 Glossary",
  dependencies: "外部依賴 Dependencies",
  constraints: "限制 Constraints",
  outOfScope: "不在範圍內 Out of Scope",
  openQuestions: "待釐清問題 Open Questions",
  contradictions: "矛盾 Contradictions",
  assumptions: "推論 Assumptions",
};

/** The main text of an item, by section. */
const HEADLINE: Record<string, (item: any) => string> = {
  actors: (i) => `${i.name}：${i.description}`,
  features: (i) => `${i.name}：${i.description}`,
  businessRules: (i) => i.rule,
  acceptanceCriteria: (i) => `[${i.kind} → ${i.featureId}] ${i.given ? `Given ${i.given} / When ${i.when ?? "?"} / Then ${i.then ?? "?"}` : i.text}`,
  nonFunctional: (i) => `[${i.category}] ${i.requirement}${i.target ? `（${i.metric ?? ""} ${i.target}）` : ""}`,
  domainEntities: (i) => `${i.name}：${i.description}${i.attributes?.length ? `（屬性：${i.attributes.join("、")}）` : ""}`,
  glossary: (i) => `${i.term}：${i.definition}${i.aliases?.length ? `（又稱：${i.aliases.join("、")}）` : ""}`,
  dependencies: (i) => `[${i.type}] ${i.name}：${i.description}`,
  constraints: (i) => `[${i.type}] ${i.constraint}`,
  outOfScope: (i) => i.item,
  openQuestions: (i) => `[${i.severity}] ${i.question}\n  - 原因：${i.reason}`,
  contradictions: (i) => i.conflict,
  assumptions: (i) => `[信心 ${i.confidence}] ${i.assumption}\n  - 理由：${i.rationale}`,
};

export function renderBriefMarkdown(brief: RequirementBrief, rejected: RejectedItem[], log: AnalysisLog): string {
  const out: string[] = ["# Requirement Brief", ""];
  const counts = Object.keys(TITLES).map((k) => `${TITLES[k]} ${(brief as any)[k].length}`);
  out.push(counts.join(" · "), "");

  for (const section of Object.keys(TITLES)) {
    const items = (brief as any)[section] as any[];
    out.push(`## ${TITLES[section]}`, "");
    if (!items.length) {
      out.push("_（原文未提及）_", "");
      continue;
    }
    for (const item of items) {
      out.push(`- **${item.id}** ${HEADLINE[section]!(item)}`);
      const refs = [item.actorIds, item.featureIds, item.dependsOn, item.relatedIds].flat().filter(Boolean);
      if (refs.length) out.push(`  - 關聯：${refs.join(", ")}`);
      for (const ev of (item.evidence ?? []) as Evidence[]) out.push(`  - 出處：\`${ev.file}\` L${ev.lineStart}–${ev.lineEnd}「${ev.quote}」`);
    }
    out.push("");
  }

  if (log.merged.length || log.resolved.length) {
    out.push("## 分析紀錄", "");
    for (const m of log.merged) out.push(`- 合併 ${m.dropIds.join(", ")} → **${m.keepId}**：${m.reason}`);
    for (const r of log.resolved) out.push(`- 已解答並移除 ${r.questionId}「${r.question.question}」（由 ${r.answeredByIds.join(", ")}）：${r.reason}`);
    out.push("");
  }

  out.push(`## 被排除的條目 Rejected Items（${rejected.length}）`, "");
  if (!rejected.length) out.push("_無_");
  for (const r of rejected) {
    out.push(`- [${r.stage}${r.bin ? ` bin${r.bin}` : ""}] ${r.section}：\`${JSON.stringify(r.item).slice(0, 160)}\``);
    for (const e of r.errors) out.push(`  - ${e}`);
  }
  out.push("");

  out.push("## 來源對照 Traceability", "");
  for (const t of brief.traceability) out.push(`- \`${t.file}\`：${t.itemIds.join(", ")}`);
  return `${out.join("\n")}\n`;
}
