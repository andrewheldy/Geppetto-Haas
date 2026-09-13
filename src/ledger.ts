import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ContextLedgerEntry, WorkflowSummary } from "./types.ts";

/** Context ledger: one row per model invocation. Makes "where did context go" inspectable. */
export class ContextLedger {
  readonly entries: ContextLedgerEntry[] = [];
  readonly file: string;
  constructor(file: string) { this.file = file; mkdirSync(dirname(file), { recursive: true }); }

  record(e: ContextLedgerEntry): void {
    this.entries.push(e);
    appendFileSync(this.file, JSON.stringify(e) + "\n");
  }

  totals(): Pick<WorkflowSummary,
    "lifecycle_input_tokens" | "lifecycle_output_tokens" | "lifecycle_cache_read_tokens" | "lifecycle_cache_write_tokens" |
    "total_model_tokens" | "peak_active_context" | "avg_active_context" | "cumulative_context_injected" |
    "cumulative_context_avoided" | "hsc_overhead_tokens" | "retrieval_overhead_tokens" | "compaction_overhead_tokens" |
    "estimated_cost_usd" | "cost_estimated" | "agent_calls" | "retrievals" | "compactions"> {
    const n = this.entries.length;
    const sum = (f: (e: ContextLedgerEntry) => number) => this.entries.reduce((a, e) => a + f(e), 0);
    const peak = this.entries.reduce((m, e) => Math.max(m, e.active_context_tokens), 0);
    return {
      lifecycle_input_tokens: sum((e) => e.input_tokens),
      lifecycle_output_tokens: sum((e) => e.output_tokens),
      lifecycle_cache_read_tokens: sum((e) => e.cache_read_tokens),
      lifecycle_cache_write_tokens: sum((e) => e.cache_write_tokens),
      total_model_tokens: sum((e) => e.input_tokens + e.cache_read_tokens + e.cache_write_tokens + e.output_tokens),
      peak_active_context: peak,
      avg_active_context: n ? Math.round(sum((e) => e.active_context_tokens) / n) : 0,
      cumulative_context_injected: sum((e) => e.compiled_context_tokens + e.retrieved_tokens),
      cumulative_context_avoided: sum((e) => e.discarded_tokens),
      hsc_overhead_tokens: sum((e) => e.hsc_tokens + e.hsc_delta_tokens),
      retrieval_overhead_tokens: sum((e) => e.retrieved_tokens),
      compaction_overhead_tokens: sum((e) => e.compacted_tokens_removed),
      estimated_cost_usd: sum((e) => e.estimated_cost_usd),
      cost_estimated: this.entries.some((e) => e.cost_estimated),
      agent_calls: this.entries.filter((e) => e.model !== "none").length,
      retrievals: sum((e) => e.retrievals),
      compactions: sum((e) => e.compactions),
    };
  }
}
