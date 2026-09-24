import type { Selection } from "./select.ts";
import { estimateTokens } from "./tokens.ts";

export interface RenderMeta { fingerprint: string; handoff: string }

/**
 * Context RENDERING: turn a selection into portable Markdown working context any agent can read.
 * No timestamps — identical selections render byte-identical output. Every item carries its source path.
 */
export function renderContext(sel: Selection, meta: RenderMeta): string {
  const out: string[] = [];
  const src = (p: string) => `\`.geppetto/${p}\``;

  out.push("## Accepted project state", "",
    "Canonical: what this project currently accepts as true. Follow it; if the task requires contradicting it, say so and propose a change in your handoff.", "");
  const canon = [...sel.essential.map((s) => ({ s, why: "always included" })), ...sel.relevant.map((r) => ({ s: r.item, why: r.reasons.join("; ") }))];
  if (!canon.length) out.push("_No accepted project state yet. Edit `.geppetto/context/*.md` or approve candidates with `geppetto reconcile`._", "");
  for (const { s, why } of canon) {
    out.push(`### ${s.fileTitle} › ${s.heading}`, `<sub>source ${src(`context/${s.id}`)} · ${why}</sub>`, "", s.body, "");
  }

  if (sel.history.length) {
    out.push("## Historical evidence (not accepted truth; may be stale)", "",
      "What happened in earlier runs. Useful as evidence — verify before relying on it.", "");
    for (const { item: r } of sel.history) {
      out.push(`### ${r.id} · ${r.date || "undated"} · ${r.outcome || "unknown outcome"} — ${r.task}`, `<sub>source ${src(`runs/${r.file}`)}</sub>`, "");
      if (r.summary) out.push(clip(r.summary, 400), "");
      for (const d of r.discoveries.slice(0, 4)) out.push(`- Discovered: ${d}`);
      for (const f of r.failed.slice(0, 3)) out.push(`- Failed approach: ${f}`);
      if (r.discoveries.length || r.failed.length) out.push("");
    }
  }

  if (sel.pending.length) {
    out.push("## Pending proposals (NOT accepted — do not rely on these)", "");
    for (const { item: c } of sel.pending) out.push(`- ${c.id} [${c.status}] ${c.op} → \`${c.target}\`: ${c.title} — ${src(`candidates/${c.file}`)}`);
    out.push("");
  }

  const { mentioned, matching, changed } = sel.repo;
  if (mentioned.length || matching.length || changed.length) {
    out.push("## Repository signals", "");
    if (mentioned.length) out.push(`- Named in the task: ${mentioned.map(code).join(", ")}`);
    if (matching.length) out.push(`- Paths matching task terms: ${matching.map(code).join(", ")}`);
    if (changed.length) out.push(`- Uncommitted changes: ${changed.map(code).join(", ")}`);
    out.push("");
  }

  if (sel.omitted.length || sel.unmatched > 0) {
    out.push("## Not included", "");
    const shown = sel.omitted.slice(0, 6).map((o) => `${src(o.ref.startsWith("runs/") || o.ref.startsWith("candidates/") ? o.ref : `context/${o.ref}`)} (score ${o.score})`);
    if (sel.omitted.length) out.push(`- Relevant but over budget (read if needed): ${shown.join(", ")}${sel.omitted.length > 6 ? `, and ${sel.omitted.length - 6} more` : ""}`);
    if (sel.unmatched > 0) out.push(`- ${sel.unmatched} other canonical section(s) did not match this task; browse \`.geppetto/context/\` if needed.`);
    out.push("");
  }

  out.push("## When you finish", "",
    `Record the outcome for the next agent: fill in \`${meta.handoff}\`, then run \`geppetto capture ${meta.handoff}\`.`,
    "Put proposed changes to project knowledge under \"Proposed changes\". They stay candidates until a human approves them with `geppetto reconcile`.", "");

  const body = out.join("\n");
  const tokens = estimateTokens(body) + 60;
  const head = [`# Working context: ${sel.task}`, "",
    `> Compiled by Geppetto from accepted project state for one task. Disposable — regenerate with \`geppetto task\`. Canonical fingerprint \`${meta.fingerprint}\` · ~${tokens} / ${sel.budget.limit} tokens (estimated, chars/4).`, ""];
  if (sel.budget.essentialOverflow > 0) {
    head.push(`> **Budget warning:** always-included sections alone exceed the budget by ~${sel.budget.essentialOverflow} tokens. They were kept (never silently dropped); shorten \`.geppetto/context/\` files marked \`include: always\` or raise \`--budget\`.`, "");
  }
  head.push("## Task", "", sel.task, "");
  return head.join("\n") + "\n" + body;
}

const code = (s: string) => `\`${s}\``;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + " …" : s);

/**
 * Selection budgets with estimates; this guarantees the rendered result. While the output exceeds the budget,
 * drop the lowest-priority optional item (pending → history → relevant canonical) into "omitted".
 * Always-included sections are never dropped; if they alone overflow, the output says so.
 */
export function fitToBudget(sel: Selection, meta: RenderMeta): { sel: Selection; md: string } {
  let md = renderContext(sel, meta);
  while (estimateTokens(md) > sel.budget.limit) {
    const pools: Array<[Array<{ item: unknown; score: number }>, (x: any) => string]> = [
      [sel.pending, (c) => `candidates/${c.file}`], [sel.history, (r) => `runs/${r.file}`], [sel.relevant, (s) => s.id]];
    const pool = pools.find(([p]) => p.length);
    if (!pool) break;
    const x = pool[0].pop()!;
    sel.omitted.unshift({ ref: pool[1](x.item), score: x.score, tokens: 0 });
    md = renderContext(sel, meta);
  }
  return { sel, md };
}
