import type { AlignedBrief } from "./aligned.ts";
import type { Answer, ClarifyState, Decision } from "./schema.ts";

const RESPONSE_LABEL: Record<Answer["kind"], string> = { text: "", accept: "✓ accepted: ", later: "⏭ later", defer: "⏸ deferred", na: "✗ not applicable" };

/** `02-transcript.md`: the whole conversation, round by round, as it happened. */
export function renderTranscript(state: ClarifyState): string {
  const out: string[] = ["# Clarify transcript", ""];
  for (const round of state.rounds) {
    out.push(round.final ? "## Closing round" : `## Round ${round.n}`, "");
    if (round.accepted.decisions.length) {
      out.push("**Decisions**", "");
      for (const d of round.accepted.decisions) out.push(`- ${decisionLine(d)}`);
      out.push("");
    }
    if (round.accepted.followUps.length) {
      out.push("**New questions**", "");
      for (const f of round.accepted.followUps) out.push(`- ${f.id} (${f.origin}${f.parentId ? ` of ${f.parentId}` : ""}): ${f.question}`);
      out.push("");
    }
    if (round.asked.length) out.push("**Asked**", "");
    for (const q of round.asked) {
      out.push(`**${q.id}** ${q.question}`);
      out.push(`> Recommended (${q.basis}): ${q.recommendation}`);
      if (q.options.length) out.push(`> Options: ${q.options.map((o, i) => `/${i + 1} ${o}`).join(" · ")}`);
      if (q.coveredBy) out.push(`> Possibly covered by ${q.coveredBy}`);
      const answer = state.answers.find((a) => a.round === round.n && a.itemId === q.id);
      out.push(answer ? `→ ${answerLine(answer)}` : "→ _(no answer)_", "");
    }
    for (const note of state.answers.filter((a) => a.round === round.n && a.itemId.startsWith("NOTE-"))) {
      out.push(`**${note.itemId}**${note.target ? ` about ${note.target}` : ""}: ${note.text}`, "");
    }
  }
  if (state.termination) out.push(`_Finished: ${state.termination}._`, "");
  return `${out.join("\n")}\n`;
}

/** `02-aligned.md`: what the user decided and what is still open. */
export function renderAlignedMarkdown(aligned: AlignedBrief): string {
  const out: string[] = ["# Aligned Brief", ""];
  if (aligned.termination) out.push(`Finished: ${aligned.termination}`, "");

  out.push("## Decisions", "");
  const active = aligned.decisions.filter((d) => d.status === "active");
  if (!active.length) out.push("_None._");
  for (const d of active) out.push(`- **${d.id}** [${d.effect}] ${d.conclusion}  \n  ← ${d.answerRef}: “${d.answerText}”${refs(d)}`);
  const revised = aligned.decisions.filter((d) => d.status === "revised");
  if (revised.length) {
    out.push("", "<details><summary>Revised decisions</summary>", "");
    for (const d of revised) out.push(`- ~~${d.id} ${d.conclusion}~~ → ${d.revisedBy}`);
    out.push("", "</details>");
  }

  const superseded = Object.entries(aligned.supersededBy);
  if (superseded.length) {
    out.push("", "## Superseded Brief items", "", "| Item | Replaced by |", "|---|---|");
    for (const [id, by] of superseded) out.push(`| ${id} | ${by.join(", ")} |`);
  }

  const open = aligned.agenda.filter((a) => a.status !== "decided");
  out.push("", "## Not decided", "");
  if (!open.length) out.push("_None._");
  for (const a of open) {
    const said = a.answers.filter((x) => x.text).map((x) => `“${x.text}”`);
    out.push(`- **${a.id}** (${a.status}) ${a.question}${said.length ? `  \n  User: ${said.join(" / ")}` : ""}`);
  }
  return `${out.join("\n")}\n`;
}

function decisionLine(d: Decision): string {
  return `${d.id} ← ${d.answerRef}, resolves ${d.resolves.join(", ")}: ${d.conclusion}${refs(d)}`;
}

function refs(d: Decision): string {
  const parts = [
    d.supersedes.length ? `supersedes ${d.supersedes.join(", ")}` : "",
    d.confirms.length ? `confirms ${d.confirms.join(", ")}` : "",
    d.revises.length ? `revises ${d.revises.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? ` (${parts.join("; ")})` : "";
}

function answerLine(a: Answer): string {
  if (a.kind === "text") return `“${a.text}”`;
  if (a.kind === "accept") return `${RESPONSE_LABEL.accept}${a.text}`;
  return `${RESPONSE_LABEL[a.kind]}${a.text ? `: ${a.text}` : ""}`;
}
