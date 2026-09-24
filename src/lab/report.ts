import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextLedgerEntry, EvaluationResult, ExecutionMode, TraceEvent, WorkflowSummary } from "./types.ts";

export interface ModeResult { summary: WorkflowSummary; evaluation: EvaluationResult; dir: string; blind_label?: string; }
export interface ExperimentSummary {
  experiment_id: string; task_id: string; objective: string; runtime: string; created_at: string;
  governance_note: string;
  modes: Partial<Record<ExecutionMode, ModeResult>>;
  comparison?: Record<string, number | string | null>;
}

function jsonl<T>(file: string): T[] { return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; }
const fmt = (n: number | undefined | null) => (n === undefined || n === null || Number.isNaN(n) ? "—" : Math.round(n).toLocaleString("en-US"));
const pct = (x: number | string | null | undefined) => (typeof x === "number" ? `${(x * 100).toFixed(1)}%` : "—");
const usd = (n: number | undefined | null) => (n === undefined || n === null ? "—" : `$${n.toFixed(4)}`);
const bar = (v: number, max: number, width = 30) => "█".repeat(Math.max(0, Math.round((v / Math.max(1, max)) * width))) || "▏";

/** Derived context-efficiency metrics. Computed only from ledgers/traces; negative savings are reported as-is. */
export function compare(g: ModeResult | undefined, c: ModeResult | undefined, gTrace: TraceEvent[], gLedger: ContextLedgerEntry[]): Record<string, number | string | null> {
  if (!g || !c) return {};
  const gs = g.summary, cs = c.summary;
  const saved = cs.total_model_tokens - gs.total_model_tokens;
  const compEvents = gTrace.filter((e) => e.type === "context.compacted");
  const pre = compEvents.reduce((a, e) => a + Number(e.data.pre_tokens ?? 0), 0), post = compEvents.reduce((a, e) => a + Number(e.data.post_tokens ?? 0), 0);
  const agentRows = gLedger.filter((r) => r.model !== "none");
  const handoff = agentRows.length ? agentRows.reduce((a, r) => a + r.compiled_context_tokens / Math.max(1, r.available_context_tokens), 0) / agentRows.length : null;
  const div = (a: number, b: number) => (b ? 1 - a / b : null);
  return {
    context_reduction_peak: div(gs.peak_active_context, cs.peak_active_context),
    context_reduction_avg: div(gs.avg_active_context, cs.avg_active_context),
    lifecycle_token_reduction: div(gs.total_model_tokens, cs.total_model_tokens),
    cost_reduction: div(gs.estimated_cost_usd, cs.estimated_cost_usd),
    duration_reduction: div(gs.elapsed_ms, cs.elapsed_ms),
    tokens_saved: saved,
    hsc_overhead_tokens: gs.hsc_overhead_tokens,
    hsc_overhead_vs_saved: saved > 0 ? gs.hsc_overhead_tokens / saved : null,
    retrieval_overhead_tokens: gs.retrieval_overhead_tokens,
    retrieval_calls: gs.retrievals,
    compaction_ratio: post ? pre / post : null,
    handoff_efficiency: handoff,
    context_utilization_proxy: handoff, // compiled/available: the share of what could have been injected that actually was
    quality_delta_criteria: g.evaluation.criteria_passed - c.evaluation.criteria_passed,
    quality_delta_blind: g.evaluation.blind_review && c.evaluation.blind_review ? g.evaluation.blind_review.score - c.evaluation.blind_review.score : null,
  };
}

export function renderReport(exp: ExperimentSummary): string {
  const g = exp.modes.governed, c = exp.modes.control;
  const gL = g ? jsonl<ContextLedgerEntry>(join(g.dir, "ledger.jsonl")) : [], cL = c ? jsonl<ContextLedgerEntry>(join(c.dir, "ledger.jsonl")) : [];
  const gT = g ? jsonl<TraceEvent>(join(g.dir, "trace.jsonl")) : [];
  const cmp = exp.comparison ?? {};
  const L: string[] = [];
  L.push(`# Experiment ${exp.experiment_id}`, "", `**Objective:** ${exp.objective}`, "", `Runtime: \`${exp.runtime}\` · Created: ${exp.created_at}`, "", `> ${exp.governance_note}`, "");

  const row = (label: string, gv: string, cv: string) => `| ${label} | ${gv} | ${cv} |`;
  L.push("## Headline comparison", "", "| Metric | Geppetto (governed) | Long agent (control) |", "|---|---|---|");
  const S = (f: (s: WorkflowSummary) => number | undefined, ff = fmt) => [g ? ff(f(g.summary)) : "—", c ? ff(f(c.summary)) : "—"] as const;
  const E = (f: (e: EvaluationResult) => string) => [g ? f(g.evaluation) : "—", c ? f(c.evaluation) : "—"] as const;
  L.push(row("Lifecycle model tokens (input+cache+output)", ...S((s) => s.total_model_tokens)));
  L.push(row("Lifecycle input tokens (uncached)", ...S((s) => s.lifecycle_input_tokens)));
  L.push(row("Lifecycle cache-read tokens", ...S((s) => s.lifecycle_cache_read_tokens)));
  L.push(row("Lifecycle cache-write tokens", ...S((s) => s.lifecycle_cache_write_tokens)));
  L.push(row("Lifecycle output tokens", ...S((s) => s.lifecycle_output_tokens)));
  L.push(row("Peak active context", ...S((s) => s.peak_active_context)));
  L.push(row("Average active context", ...S((s) => s.avg_active_context)));
  L.push(row("Cumulative context injected (compiled+retrieved)", ...S((s) => s.cumulative_context_injected)));
  L.push(row("Cumulative context avoided", ...S((s) => s.cumulative_context_avoided)));
  L.push(row("Cost", ...S((s) => s.estimated_cost_usd, (n) => usd(n))));
  L.push(row("Duration", ...S((s) => s.elapsed_ms, (n) => `${((n ?? 0) / 1000).toFixed(0)}s`)));
  L.push(row("Agent calls", ...S((s) => s.agent_calls)));
  L.push(row("Graph nodes / turns", ...S((s) => s.graph_nodes)));
  L.push(row("Retries", ...S((s) => s.retries)));
  L.push(row("Review loops", ...S((s) => s.loops)));
  L.push(row("Replans", ...S((s) => s.replans)));
  L.push(row("Context retrievals", g ? fmt(g.summary.retrievals) : "—", "N/A"));
  L.push(row("Context compactions", g ? fmt(g.summary.compactions) : "—", "N/A"));
  L.push(row("HSC overhead tokens", g ? fmt(g.summary.hsc_overhead_tokens) : "—", "N/A"));
  L.push(row("Acceptance criteria passed", ...E((e) => `${e.criteria_passed}/${e.criteria_total}`)));
  L.push(row("Tests passed / failed", ...E((e) => e.tests_passed === undefined ? "—" : `${e.tests_passed} / ${e.tests_failed ?? 0}`)));
  L.push(row("Blind review score (0-10)", ...E((e) => e.blind_review ? `${e.blind_review.score} (${e.blind_review.findings.length} findings, as "${e.blind_review.label}")` : "—")));
  L.push(row("Review findings raised", ...E((e) => String(e.review_findings))));
  L.push(row("Status", ...S((s) => 0, () => "")).replace("|  |  |", `| ${g?.summary.status ?? "—"} | ${c?.summary.status ?? "—"} |`));
  L.push("");

  L.push("## Derived context-efficiency metrics", "", "| Metric | Value | Definition |", "|---|---|---|");
  L.push(`| Context reduction (peak) | ${pct(cmp.context_reduction_peak)} | 1 − governed peak / control peak |`);
  L.push(`| Context reduction (avg) | ${pct(cmp.context_reduction_avg)} | 1 − governed avg / control avg |`);
  L.push(`| Lifecycle token reduction | ${pct(cmp.lifecycle_token_reduction)} | 1 − governed lifecycle / control lifecycle |`);
  L.push(`| Cost reduction | ${pct(cmp.cost_reduction)} | 1 − governed cost / control cost |`);
  L.push(`| Duration reduction | ${pct(cmp.duration_reduction)} | 1 − governed elapsed / control elapsed |`);
  L.push(`| Tokens saved | ${fmt(cmp.tokens_saved as number)} | control − governed lifecycle tokens (negative = Geppetto cost more) |`);
  L.push(`| HSC overhead / tokens saved | ${typeof cmp.hsc_overhead_vs_saved === "number" ? cmp.hsc_overhead_vs_saved.toFixed(3) : "n/a (no savings)"} | tokens spent maintaining state ÷ tokens saved |`);
  L.push(`| Retrieval overhead | ${fmt(cmp.retrieval_overhead_tokens as number)} tokens over ${cmp.retrieval_calls ?? 0} calls | context pulled back because it was omitted from L0 |`);
  L.push(`| Compaction ratio | ${typeof cmp.compaction_ratio === "number" ? cmp.compaction_ratio.toFixed(2) + "×" : "—"} | Σ pre-compaction / Σ post-compaction |`);
  L.push(`| Handoff efficiency | ${pct(cmp.handoff_efficiency)} | avg compiled / available per agent node (lower = more context left out) |`);
  L.push(`| Quality Δ (criteria) | ${cmp.quality_delta_criteria ?? "—"} | governed − control criteria passed |`);
  L.push(`| Quality Δ (blind score) | ${cmp.quality_delta_blind ?? "—"} | governed − control blind score |`);
  L.push("");

  const maxCtx = Math.max(1, ...gL.map((r) => r.active_context_tokens), ...cL.map((r) => r.active_context_tokens));
  const bars = (rows: ContextLedgerEntry[]) => rows.map((r) => `${r.node_id.padEnd(22).slice(0, 22)} ${bar(r.active_context_tokens, maxCtx)} ${fmt(r.active_context_tokens).padStart(9)}  (compiled ${fmt(r.compiled_context_tokens)}, avail ${fmt(r.available_context_tokens)}, out ${fmt(r.output_tokens)}, ${r.model})`).join("\n");
  L.push("## Active context by task (tokens the model attended to per invocation)", "");
  if (g) L.push("### Geppetto (governed)", "```", bars(gL) || "(none)", "```", "");
  if (c) L.push("### Long agent (control)", "```", bars(cL) || "(none)", "```", "");

  const cumul = (rows: ContextLedgerEntry[]) => { let t = 0; return rows.map((r) => { t += r.input_tokens + r.cache_read_tokens + r.cache_write_tokens + r.output_tokens; return `| ${r.node_id} | ${fmt(r.active_context_tokens)} | ${fmt(t)} |`; }).join("\n"); };
  L.push("## Cumulative lifecycle tokens over time", "");
  if (g) L.push("### Geppetto", "", "| Step | Active context | Cumulative tokens |", "|---|---|---|", cumul(gL), "");
  if (c) L.push("### Long agent", "", "| Step | Active context | Cumulative tokens |", "|---|---|---|", cumul(cL), "");

  const dist = (rows: ContextLedgerEntry[]) => { const m = new Map<string, number>(); for (const r of rows) m.set(`${r.agent_id} @ ${r.model}`, (m.get(`${r.agent_id} @ ${r.model}`) ?? 0) + 1); return [...m].map(([k, v]) => `- ${k}: ${v} call(s)`).join("\n"); };
  L.push("## Agent / model distribution", "");
  if (g) L.push("### Geppetto", dist(gL), "");
  if (c) L.push("### Long agent", dist(cL), "");

  const routed = gT.filter((e) => e.type === "model.routed");
  if (routed.length) { L.push("## Routing decisions (governed)", "", "| Node | Requirements | Selected | Reasons |", "|---|---|---|---|"); for (const e of routed) L.push(`| ${e.node_id} | ${JSON.stringify(e.data.requirements)} | ${e.data.selected} (${e.data.effort}) | ${(e.data.reasons as string[]).join("; ")} |`); L.push(""); }
  const comp = gT.filter((e) => e.type === "context.compacted");
  if (comp.length) { L.push("## Compaction events (governed)", "", "| Node | Trigger | Pre | Post | Ratio | L2 ref |", "|---|---|---|---|---|---|"); for (const e of comp) L.push(`| ${e.node_id} | ${e.data.trigger} | ${fmt(e.data.pre_tokens as number)} | ${fmt(e.data.post_tokens as number)} | ${e.data.ratio}× | ${e.data.history_ref} |`); L.push(""); }
  const retr = gT.filter((e) => e.type === "context.retrieved");
  if (retr.length) { L.push("## Retrieval events (governed)", "", "| Node | Query | Tokens | Sources |", "|---|---|---|---|"); for (const e of retr) L.push(`| ${e.node_id} | ${String(e.data.query).slice(0, 60)} | ${fmt(e.data.tokens as number)} | ${(e.data.sources as string[]).join(", ")} |`); L.push(""); }
  const replans = gT.filter((e) => ["graph.replanned", "node.retried", "loop.exhausted", "state.conflict", "state.rejected"].includes(e.type));
  if (replans.length) { L.push("## Loops, retries, replans, rejections (governed)", ""); for (const e of replans) L.push(`- \`${e.type}\` ${e.node_id ?? ""}: ${JSON.stringify(e.data).slice(0, 220)}`); L.push(""); }
  const packets = gT.filter((e) => e.type === "context.compiled");
  if (packets.length) { L.push("## Compiled context packets (governed)", ""); for (const e of packets) L.push(`- **${e.node_id}**: ${fmt(e.data.tokens as number)} tokens injected of ${fmt(e.data.available_tokens as number)} available (${e.data.discarded_items} items left out) — ${(e.data.sections as Array<{ name: string; tokens: number }>).map((s) => `${s.name}:${s.tokens}`).join(", ")}`); L.push(""); }

  L.push("## Quality", "");
  for (const [name, m] of [["Geppetto", g], ["Long agent", c]] as const) {
    if (!m) continue;
    L.push(`### ${name}`, "", ...m.evaluation.criteria.map((x) => `- [${x.passed ? "x" : " "}] ${x.criterion}${x.detail ? ` (${x.detail})` : ""}`));
    if (m.evaluation.errors.length) L.push("", "Errors:", ...m.evaluation.errors.map((e) => `- ${e.slice(0, 300)}`));
    if (m.evaluation.blind_review) L.push("", `Blind review (${m.evaluation.blind_review.model}, saw only "Artifact ${m.evaluation.blind_review.label}"): score ${m.evaluation.blind_review.score}`, ...m.evaluation.blind_review.findings.map((f) => `- ${f}`));
    L.push("");
  }
  const est = [...gL, ...cL].some((r) => r.tokens_estimated);
  L.push("## Measurement notes", "", `- Token counts: ${est ? "some rows are heuristic estimates (chars/4) — see \`tokens_estimated\` in the ledgers" : "provider-reported for every model invocation"}. Compiled/available packet sizes are always chars/4 estimates.`,
    "- Active context = input + cache_read + cache_write of the largest API round-trip inside an invocation. Lifecycle tokens sum every round-trip, so cached prefixes are counted each time they are re-read (that is what the provider bills and what the model attends to).",
    "- The control's per-turn \"available\" and \"compiled\" context are equal by construction: a monolithic session injects everything it has.",
    "- Blind review labels (A/B) were assigned randomly per experiment; the evaluator never saw the mode.", "");
  return L.join("\n");
}
