import type { HSCEntry, HandoffPacket, GraphNode, Budget } from "./types.ts";
import type { HSCManager } from "./hsc.ts";
import type { HistoricalStore, HistoryRecord } from "./history.ts";
import type { Tracer } from "./trace.ts";
import { estimateTokens } from "../tokens.ts";

export interface ContextItem { name: string; text: string; tags: string[]; provenance: string[]; priority: number; }
export interface CompactionResult { summary: string; pre_tokens: number; post_tokens: number; history_ref: string; classification: Record<string, number>; }
export interface RehydrationResult { text: string; tokens: number; sources: string[]; }

// Lines worth keeping when compacting raw agent/tool output. Deterministic on purpose.
const SIGNAL = /\b(error|fail|failed|failing|pass|passed|passing|ok\b|✓|✗|created|modified|wrote|written|added|removed|deleted|decision|decided|assum|todo|verdict|finding|blocker|warning|exit code|tests? \d+|\d+ (passing|failing|tests?))/i;
const PATH = /(^|\s)(src|tests?|docs|lib|app)\/[\w./-]+/;

/**
 * Context Governor: decides what information is cognitively available to an agent.
 * Orchestrator decides what happens next; the governor decides what is visible when it happens.
 */
export class ContextGovernor {
  readonly hsc: HSCManager;
  readonly history: HistoricalStore;
  readonly tracer: Tracer;
  compactionsRemovedTokens = 0;
  retrievals = 0;
  compactions = 0;
  constructor(hsc: HSCManager, history: HistoricalStore, tracer: Tracer) {
    this.hsc = hsc; this.history = history; this.tracer = tracer;
  }

  /** Admission: score relevance to the node, drop quarantined/stale sources, fit a token budget. */
  admit(items: ContextItem[], node: GraphNode, budgetTokens: number): { admitted: ContextItem[]; discarded: ContextItem[] } {
    const want = new Set([...node.required_capabilities, node.node_type, ...node.dependencies]);
    const scored = items.map((it) => ({ it, score: it.priority + it.tags.filter((t) => want.has(t)).length }));
    scored.sort((a, b) => b.score - a.score);
    let used = 0; const admitted: ContextItem[] = []; const discarded: ContextItem[] = [];
    for (const { it } of scored) {
      const t = estimateTokens(it.text);
      if (used + t <= budgetTokens) { admitted.push(it); used += t; } else discarded.push(it);
    }
    return { admitted, discarded };
  }

  /**
   * Compaction classifies rather than summarizes blindly: keeps signal lines (results, errors, decisions, paths),
   * stores the raw source in L2 untouched, and reports pre/post sizes. Compaction alters injection, not history.
   */
  compact(raw: string, opts: { node_id: string; agent_id?: string; trigger: string; type?: HistoryRecord["type"]; maxLines?: number; tags?: string[] }): CompactionResult {
    const rec = this.history.append({ type: opts.type ?? "agent_output", node_id: opts.node_id, agent_id: opts.agent_id, tags: opts.tags ?? [opts.node_id], content: raw });
    const lines = raw.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
    const classification: Record<string, number> = { signal: 0, path: 0, structural: 0, dropped: 0 };
    const kept: string[] = [];
    const max = opts.maxLines ?? 40;
    for (const l of lines) {
      const isHeader = /^#{1,3} |^[A-Z][A-Za-z ]{2,30}:$/.test(l);
      if (SIGNAL.test(l)) classification.signal++;
      else if (PATH.test(l)) classification.path++;
      else if (isHeader) classification.structural++;
      else { classification.dropped++; continue; }
      if (kept.length < max) kept.push(l.length > 240 ? l.slice(0, 237) + "..." : l);
    }
    // Always keep the first and last non-empty lines so intent and conclusion survive.
    if (lines.length && !kept.includes(lines[0])) kept.unshift(lines[0].slice(0, 240));
    const last = lines[lines.length - 1];
    if (lines.length > 1 && last && !kept.includes(last)) kept.push(last.slice(0, 240));
    const summary = kept.join("\n") + `\n[compacted: ${lines.length} lines → ${kept.length}; raw in L2 ${rec.id}]`;
    const pre = estimateTokens(raw), post = estimateTokens(summary);
    this.compactions++;
    this.compactionsRemovedTokens += Math.max(0, pre - post);
    this.tracer.emit("context.compacted", { trigger: opts.trigger, pre_tokens: pre, post_tokens: post, ratio: post ? +(pre / post).toFixed(2) : 0, history_ref: rec.id, classification }, { node_id: opts.node_id, agent_id: opts.agent_id });
    return { summary, pre_tokens: pre, post_tokens: post, history_ref: rec.id, classification };
  }

  /** JIT rehydration: smallest useful slice from HSC + L2 for a query, with provenance, recorded as a retrieval. */
  rehydrate(query: string, node: GraphNode, opts: { limit?: number; max_tokens?: number } = {}): RehydrationResult {
    const maxTokens = opts.max_tokens ?? 2000;
    const parts: string[] = []; const sources: string[] = []; let used = 0;
    const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2);
    const hscHits = this.hsc.slice().filter((e) => terms.some((t) => e.content.toLowerCase().includes(t)));
    for (const e of hscHits) {
      const line = this.hsc.renderEntry(e); const t = estimateTokens(line);
      if (used + t > maxTokens) break; parts.push(line); sources.push(e.id); used += t;
    }
    for (const r of this.history.search(query, { limit: opts.limit ?? 2 })) {
      const text = `[L2 ${r.id} ${r.type} node=${r.node_id ?? "-"}]\n${r.content.slice(0, (maxTokens - used) * 4)}`;
      const t = estimateTokens(text);
      if (used + t > maxTokens) continue; parts.push(text); sources.push(r.id); used += t;
    }
    this.retrievals++;
    this.tracer.emit("context.retrieved", { query, tokens: used, sources, hsc_hits: hscHits.length }, { node_id: node.node_id });
    return { text: parts.join("\n\n"), tokens: used, sources };
  }

  /** Decay + conflict pass; run at node boundaries. */
  govern(nodeIndex: number): { stale: HSCEntry[]; conflicts: number; resolved: number; escalated: number } {
    this.hsc.nodeIndex = nodeIndex;
    const stale = this.hsc.decay();
    if (stale.length) this.tracer.emit("context.decayed", { count: stale.length, ids: stale.map((e) => e.id) });
    const conflicts = this.hsc.detectConflicts();
    let resolved = 0, escalated = 0;
    for (const [a, b] of conflicts) {
      const win = this.hsc.resolve(a, b);
      if (win) resolved++; else escalated++;
      this.tracer.emit("state.conflict", { a: a.id, b: b.id, key: a.key, resolution: win ? `won:${win.id}` : "escalated:contested" });
    }
    return { stale, conflicts: conflicts.length, resolved, escalated };
  }

  /** Structured handoff: only what the receiving node needs. */
  handoff(from: GraphNode | undefined, to: GraphNode, budget: Budget): HandoffPacket {
    const pick = (kinds: HSCEntry["kind"][]) => this.hsc.slice({ kinds }).map((e) => e.content);
    return {
      objective: to.objective,
      current_status: from ? `${from.node_id} ${from.status}${from.outputs?.verdict ? ` (${from.outputs.verdict})` : ""}` : "start",
      accepted_decisions: this.hsc.slice({ kinds: ["decision"], statuses: ["accepted"] }).map((e) => e.content),
      relevant_constraints: pick(["constraint"]),
      required_inputs: to.required_context.map((r) => r.kind === "files" ? `files:${r.paths.join(",")}` : r.kind === "node_output" ? `output:${r.node_id}` : r.kind),
      previous_outputs: from?.outputs ? [from.outputs.summary] : [],
      active_hypotheses: pick(["hypothesis", "assumption"]),
      unresolved_questions: pick(["question"]),
      evidence_refs: from?.outputs ? [from.outputs.history_ref] : [],
      artifact_refs: pick(["artifact"]),
      allowed_tools: to.allowed_tools,
      authority: to.allowed_tools.includes("Bash") ? "write+shell" : to.allowed_tools.some((t) => /Edit|Write/.test(t)) ? "write" : "read",
      acceptance_criteria: to.acceptance_criteria.map((a) => a.type === "manual" ? a.description : a.type === "command" ? `cmd: ${a.cmd}` : a.type === "file_exists" ? `exists: ${a.path}` : `${a.path} ~ /${a.pattern}/`),
      budget,
      warnings: this.hsc.slice({ statuses: ["contested"] }).map((e) => `contested: ${e.content}`),
    };
  }

  /** Redundancy detection: a candidate that restates an injectable entry of the same kind is not admitted twice. */
  isRedundant(kind: HSCEntry["kind"], content: string): HSCEntry | undefined {
    const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2));
    const a = words(content);
    for (const e of this.hsc.slice({ kinds: [kind] })) {
      const b = words(e.content); let inter = 0; for (const w of a) if (b.has(w)) inter++;
      const jaccard = inter / Math.max(1, a.size + b.size - inter);
      if (jaccard >= 0.6) return e;
    }
    return undefined;
  }

  /** Full potentially-available context: what a monolithic session would be carrying at this point. */
  availableTokens(): number { return this.hsc.tokens() + this.history.totalTokens(); }
}
