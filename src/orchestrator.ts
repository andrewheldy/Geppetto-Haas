import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentDefinition, ContextLedgerEntry, ContextPacket, ContextSection, Graph, GraphNode, HSCEntry, InvocationResult, NodeOutput, RuntimeAdapter, Task, WorkflowSummary } from "./types.ts";
import { Tracer } from "./trace.ts";
import { ContextLedger } from "./ledger.ts";
import { HistoricalStore } from "./history.ts";
import { HSCManager } from "./hsc.ts";
import { ContextGovernor } from "./governor.ts";
import { compileContext } from "./compiler.ts";
import type { Planner } from "./planner.ts";
import type { Router } from "./router.ts";
import { AGENT_OUTPUT_SCHEMA, analyzeCapabilities, createAgent } from "./factory.ts";
import { activeContext, estimateTokens } from "./tokens.ts";

export interface OrchestratorOptions {
  task: Task;
  workflow_id: string;
  runtime: RuntimeAdapter;
  planner: Planner;
  router: Router;
  workspace: string;
  out_dir: string;
  experiment_id?: string;
  /** L0 packet budget per node (tokens) */
  l0_budget?: number;
  /** tokens above which a raw output is compacted before handoff */
  compact_threshold?: number;
  max_turns?: number;
  auto_approve?: boolean;
  max_rehydrations?: number;
}

interface AgentOutput { summary: string; verdict: "pass" | "fail" | "n/a"; findings: string[]; decisions: string[]; assumptions: string[]; questions: string[]; files_changed: string[]; need_context: string[]; }

const EMPTY: AgentOutput = { summary: "", verdict: "n/a", findings: [], decisions: [], assumptions: [], questions: [], files_changed: [], need_context: [] };

function coerce(s: Record<string, unknown> | undefined, text: string): AgentOutput {
  if (!s) { try { s = JSON.parse(text.slice(text.lastIndexOf("{\"summary\""), text.lastIndexOf("}") + 1)); } catch { s = undefined; } }
  const arr = (x: unknown) => (Array.isArray(x) ? x.map(String) : []);
  const v = s?.verdict; const verdict = v === "pass" || v === "fail" ? v : "n/a";
  return { summary: String(s?.summary ?? text.slice(0, 600)), verdict, findings: arr(s?.findings), decisions: arr(s?.decisions), assumptions: arr(s?.assumptions), questions: arr(s?.questions), files_changed: arr(s?.files_changed), need_context: arr(s?.need_context) };
}

/**
 * Executes a Graph: ready-set scheduling (sequential + parallel + join), conditions, bounded review loops,
 * retries with escalation, replanning, budgets. Emits traces and ledger rows for every node.
 */
export class Orchestrator {
  readonly o: OrchestratorOptions;
  readonly tracer: Tracer;
  readonly ledger: ContextLedger;
  readonly history: HistoricalStore;
  readonly hsc: HSCManager;
  readonly governor: ContextGovernor;
  readonly agents: AgentDefinition[] = [];
  graph!: Graph;
  private nodeIndex = 0;
  private retries = 0;
  private loops = 0;
  private startedAt = 0;
  private costSoFar = 0;
  private tokensSoFar = 0;
  status: WorkflowSummary["status"] = "completed";

  constructor(o: OrchestratorOptions) {
    this.o = o;
    mkdirSync(o.out_dir, { recursive: true });
    this.tracer = new Tracer(join(o.out_dir, "trace.jsonl"), { experiment_id: o.experiment_id, workflow_id: o.workflow_id, mode: "governed" });
    this.ledger = new ContextLedger(join(o.out_dir, "ledger.jsonl"));
    this.history = new HistoricalStore(join(o.out_dir, "history.jsonl"));
    this.hsc = HSCManager.fromTask(o.workflow_id, o.task, join(o.out_dir, "hsc.json"));
    this.governor = new ContextGovernor(this.hsc, this.history, this.tracer);
  }

  async run(): Promise<WorkflowSummary> {
    this.startedAt = Date.now();
    const { task } = this.o;
    this.tracer.emit("workflow.created", { task_id: task.id, objective: task.objective, workspace: this.o.workspace, runtime: this.o.runtime.name });
    this.graph = this.o.planner.plan(task, this.o.workflow_id);
    this.tracer.ids.graph_id = this.graph.graph_id;
    this.tracer.emit("graph.planned", { nodes: this.graph.nodes.map((n) => ({ id: n.node_id, type: n.node_type, deps: n.dependencies, parallel_group: n.parallel_group })) });
    this.persist();

    while (true) {
      if (this.overBudget()) { this.status = "budget_exceeded"; break; }
      const pending = this.graph.nodes.filter((n) => n.status === "pending");
      if (!pending.length) break;
      const done = (id: string) => ["succeeded", "skipped"].includes(this.graph.nodes.find((n) => n.node_id === id)?.status ?? "");
      const ready = pending.filter((n) => n.dependencies.every(done));
      if (!ready.length) {
        const blocked = pending.map((n) => n.node_id);
        this.tracer.emit("workflow.blocked", { blocked });
        for (const n of pending) n.status = "blocked";
        this.status = "failed"; break;
      }
      for (const n of ready) {
        if (n.condition) {
          const src = this.graph.nodes.find((x) => x.node_id === n.condition!.node_id);
          const val = (src?.outputs?.structured as any)?.[n.condition.field] ?? src?.outputs?.verdict;
          if (val !== n.condition.equals) { n.status = "skipped"; this.tracer.emit("node.skipped", { condition: n.condition, actual: val }, { node_id: n.node_id }); }
        }
      }
      const batch = ready.filter((n) => n.status === "pending");
      if (batch.length > 1) this.tracer.emit("graph.parallel_batch", { nodes: batch.map((n) => n.node_id) });
      await Promise.all(batch.map((n) => this.runNode(n)));
      const gov = this.governor.govern(this.nodeIndex);
      if (gov.conflicts) this.tracer.emit("state.reconciled", { ...gov, stale: gov.stale.length });
      this.persist();
    }
    const failed = this.graph.nodes.filter((n) => n.status === "failed" || n.status === "blocked");
    if (failed.length && this.status === "completed") this.status = "failed";
    const summary = this.summary();
    writeFileSync(join(this.o.out_dir, "summary.json"), JSON.stringify(summary, null, 2));
    writeFileSync(join(this.o.out_dir, "agents.json"), JSON.stringify(this.agents.map((a) => ({ ...a, system_prompt: undefined, prompt_modules: a.prompt_modules })), null, 2));
    this.tracer.emit("workflow.completed", { ...summary });
    return summary;
  }

  private overBudget(): boolean {
    const b = this.o.task.budget;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const reason = b.max_usd && this.costSoFar > b.max_usd ? `cost ${this.costSoFar.toFixed(3)} > ${b.max_usd}` : b.max_tokens && this.tokensSoFar > b.max_tokens ? `tokens ${this.tokensSoFar} > ${b.max_tokens}` : b.max_seconds && elapsed > b.max_seconds ? `elapsed ${elapsed.toFixed(0)}s > ${b.max_seconds}` : undefined;
    if (reason) this.tracer.emit("workflow.budget_exceeded", { reason });
    return !!reason;
  }

  private async runNode(n: GraphNode): Promise<void> {
    n.status = "running"; n.attempts++; n.execution_order = ++this.nodeIndex;
    this.tracer.emit("node.started", { type: n.node_type, attempt: n.attempts, iteration: n.iteration, objective: n.objective }, { node_id: n.node_id });
    try {
      if (n.deterministic) await this.runDeterministic(n);
      else await this.runAgentNode(n);
      n.status = "succeeded";
      this.tracer.emit("node.completed", { verdict: n.outputs?.verdict, attempts: n.attempts }, { node_id: n.node_id });
      if (n.loop_policy && n.outputs?.verdict === "fail") this.expandLoop(n);
    } catch (err) {
      const msg = (err as Error).message;
      n.failure_reason = msg;
      this.tracer.emit("node.failed", { error: msg, attempt: n.attempts }, { node_id: n.node_id });
      this.history.append({ type: "agent_output", node_id: n.node_id, tags: [n.node_id, "failure"], content: `FAILURE attempt ${n.attempts}: ${msg}` });
      if (n.attempts <= n.retry_policy.max_retries) {
        this.retries++; n.status = "pending";
        const decision = "retry same node: escalate model tier one step, inject previous failure as context";
        n.inputs.previous_failure = msg;
        this.tracer.emit("node.retried", { decision, attempt: n.attempts + 1 }, { node_id: n.node_id });
      } else if (n.retry_policy.on_exhausted === "replan") {
        const added = this.o.planner.replan(this.graph, n, msg);
        n.status = added.length ? "replaced" : "failed";
        this.tracer.emit("graph.replanned", { failed: n.node_id, added, decision: added.length ? "insert diagnose node then re-attempt with its output" : "replan budget exhausted; giving up", replans: this.graph.replans.length }, { node_id: n.node_id });
        if (!added.length) this.status = "failed";
      } else {
        n.status = "failed";
        this.tracer.emit("node.escalated", { decision: n.retry_policy.on_exhausted }, { node_id: n.node_id });
      }
    }
  }

  private expandLoop(review: GraphNode): void {
    const added = this.o.planner.expandLoop(this.graph, review, this.o.task);
    if (added.length) {
      this.loops++;
      this.tracer.emit("graph.replanned", { reason: "review verdict fail", added: added.map((a) => a.node_id), iteration: added[0].iteration, max_iterations: review.loop_policy?.max_iterations }, { node_id: review.node_id });
    } else {
      this.tracer.emit("loop.exhausted", { iterations: review.iteration, max: review.loop_policy?.max_iterations }, { node_id: review.node_id });
      this.hsc.add({ kind: "question", content: `Review loop exhausted after ${review.iteration} iterations; findings unresolved: ${(review.outputs?.structured as any)?.findings?.join("; ") ?? ""}`, status: "active", confidence: 0.9, producer: "orchestrator", node_id: review.node_id, tags: ["escalation"] });
    }
  }

  private async runDeterministic(n: GraphNode): Promise<void> {
    const started = Date.now();
    if (n.node_type === "human_gate") {
      const approved = this.o.auto_approve ?? true;
      const lastReview = this.graph.nodes.filter((x) => x.node_type === "review" && x.outputs).sort((a, b) => (b.execution_order ?? 0) - (a.execution_order ?? 0))[0];
      const verdict = approved && lastReview?.outputs?.verdict === "pass" ? "pass" : "fail";
      n.outputs = { text: `human gate: ${verdict} (auto_approve=${approved}, last review=${lastReview?.outputs?.verdict})`, summary: `human gate ${verdict}`, history_ref: "", verdict };
      this.tracer.emit("human_gate.decided", { verdict, auto_approve: approved }, { node_id: n.node_id });
      const e = this.hsc.add({ kind: "decision", key: "gate", content: `Human gate: ${verdict}`, status: "accepted", confidence: 1, producer: "human_gate", node_id: n.node_id, tags: ["gate"] });
      n.state_changes.push(e.id);
      return;
    }
    const r = await this.o.runtime.runCommand(n.command!, this.o.workspace, (n.budget.max_seconds ?? 600) * 1000);
    this.tracer.emit("tool.called", { cmd: n.command, exit_code: r.exit_code, duration_ms: r.duration_ms, output_tokens: estimateTokens(r.stdout + r.stderr) }, { node_id: n.node_id });
    const raw = `$ ${r.cmd}\nexit code: ${r.exit_code}\n${r.stdout}\n${r.stderr}`;
    const c = this.governor.compact(raw, { node_id: n.node_id, trigger: estimateTokens(raw) > (this.o.compact_threshold ?? 800) ? "large tool output" : "task phase completed", type: "tool_output", maxLines: 30 });
    const verdict = r.exit_code === 0 ? "pass" : "fail";
    n.outputs = { text: raw, summary: c.summary, history_ref: c.history_ref, verdict, structured: { exit_code: r.exit_code } };
    const e = this.hsc.add({ kind: "evidence", key: "tests", content: `Tests (${n.node_id}): ${verdict}, exit ${r.exit_code}`, status: "accepted", confidence: 1, producer: "test-runner", node_id: n.node_id, evidence_refs: [c.history_ref], tags: ["tests"] });
    n.state_changes.push(e.id);
    this.ledger.record(this.ledgerRow(n, "test-runner", `tool-${n.node_id}`, "none", undefined, undefined, { tool_tokens: estimateTokens(raw), compacted: c.pre_tokens - c.post_tokens, compactions: 1, duration_ms: Date.now() - started, hsc_delta: estimateTokens(e.content) }));
  }

  private async runAgentNode(n: GraphNode): Promise<void> {
    const { task, runtime } = this.o;
    const spec = analyzeCapabilities(n, task);
    const route = this.o.router.route(n, spec, n.attempts - 1);
    const agent = createAgent(n, spec, route, n.acceptance_criteria);
    this.agents.push(agent); n.assigned_agent = agent.agent_id;
    this.tracer.emit("agent.created", { role: agent.role, tools: agent.tools, authority: agent.authority, capabilities: spec, prompt_modules: agent.prompt_modules, lifecycle: agent.lifecycle }, { node_id: n.node_id, agent_id: agent.agent_id });
    this.tracer.emit("model.routed", { requirements: { complexity: spec.task_complexity, reasoning: spec.reasoning_requirement, independence: spec.needs_independence }, candidates: route.candidates, selected: route.model, effort: route.effort, reasons: route.reasons }, { node_id: n.node_id, agent_id: agent.agent_id });

    const prev = n.dependencies.map((d) => this.graph.nodes.find((x) => x.node_id === d)).filter((x): x is GraphNode => !!x?.outputs).sort((a, b) => (b.execution_order ?? 0) - (a.execution_order ?? 0))[0];
    const handoff = this.governor.handoff(prev, n, n.budget);
    this.tracer.emit("handoff.created", { from: prev?.node_id, to: n.node_id, tokens: estimateTokens(JSON.stringify(handoff)) }, { node_id: n.node_id });
    const extra: ContextSection[] = [];
    if (n.inputs.previous_failure) extra.push({ name: "previous_failure", source: "history", tokens: 0, text: `## Previous attempt failed\n${String(n.inputs.previous_failure).slice(0, 1500)}`, provenance: ["orchestrator"] });
    if (n.node_type === "review" || n.node_type === "patch") {
      const diff = await runtime.runCommand("git add -A -N . 2>/dev/null; git --no-pager diff --stat; git --no-pager diff", this.o.workspace);
      const raw = diff.stdout || "(no diff)";
      const big = estimateTokens(raw) > 6000;
      const text = big ? this.governor.compact(raw, { node_id: n.node_id, trigger: "large tool output", type: "artifact", maxLines: 120, tags: [n.node_id, "diff"] }).summary + "\n(read files for full content)" : raw;
      extra.push({ name: "diff", source: "file", tokens: 0, text: `## Working tree diff\n\`\`\`diff\n${text}\n\`\`\``, provenance: ["git diff"] });
    }
    const packet = compileContext({ task, node: n, graph_nodes: this.graph.nodes, governor: this.governor, workspace: this.o.workspace, handoff, max_tokens: this.o.l0_budget ?? 12000, extra });

    let prompt = `${packet.text}\n\n## Your task (${n.node_type})\n${n.objective}`;
    let result: InvocationResult; let out: AgentOutput; let retrievedTokens = packet.retrieved_tokens; let retrievals = this.governor.retrievals; let rehydrated = 0;
    const startRetrievals = retrievals;
    let usageAgg = { input: 0, output: 0, cache_read: 0, cache_write: 0 }; let cost = 0; let costEst = false; let tokEst = false; let dur = 0; let peak = 0;
    while (true) {
      const invocation_id = `inv-${randomUUID().slice(0, 8)}`;
      this.tracer.emit("agent.invoked", { model: route.model, prompt_tokens: estimateTokens(prompt), system_tokens: estimateTokens(agent.system_prompt), rehydration: rehydrated }, { node_id: n.node_id, agent_id: agent.agent_id, invocation_id });
      result = await runtime.invoke({ invocation_id, agent_id: agent.agent_id, node_id: n.node_id, model: route.model, effort: route.effort, system_prompt: agent.system_prompt, prompt, tools: agent.tools, cwd: this.o.workspace, max_turns: this.o.max_turns ?? 60, max_usd: n.budget.max_usd, json_schema: AGENT_OUTPUT_SCHEMA });
      usageAgg.input += result.usage.input; usageAgg.output += result.usage.output; usageAgg.cache_read += result.usage.cache_read; usageAgg.cache_write += result.usage.cache_write;
      cost += result.cost_usd; costEst ||= result.cost_estimated; tokEst ||= result.usage.estimated; dur += result.duration_ms;
      peak = Math.max(peak, ...(result.iterations.length ? result.iterations.map(activeContext) : [activeContext(result.usage)]));
      this.tracer.emit("agent.completed", { usage: result.usage, cost_usd: result.cost_usd, duration_ms: result.duration_ms, turns: result.num_turns, error: result.error, peak_active_context: peak }, { node_id: n.node_id, agent_id: agent.agent_id, invocation_id: result.invocation_id });
      if (result.error) throw new Error(result.error);
      out = coerce(result.structured, result.output_text);
      if (out.need_context.length && !out.summary && rehydrated < (this.o.max_rehydrations ?? 2)) {
        rehydrated++;
        const r = this.governor.rehydrate(out.need_context.join(" "), n);
        retrievedTokens += r.tokens;
        prompt += `\n\n## Rehydrated context (requested: ${out.need_context.join("; ")})\n${r.text || "(nothing found in HSC or history)"}`;
        continue;
      }
      break;
    }
    retrievals = this.governor.retrievals - startRetrievals + (packet.sections.some((s) => s.source === "history") ? 0 : 0);

    // raw → L2, compacted summary for handoff
    const rawTokens = estimateTokens(result.output_text);
    const c = this.governor.compact(result.output_text, { node_id: n.node_id, agent_id: agent.agent_id, trigger: rawTokens > (this.o.compact_threshold ?? 800) ? "agent handoff (large output)" : "agent handoff", maxLines: 25 });
    const summary = out.summary ? `${out.summary}${out.findings.length ? `\nFindings:\n${out.findings.map((f) => `- ${f}`).join("\n")}` : ""}${out.files_changed.length ? `\nFiles: ${out.files_changed.join(", ")}` : ""}` : c.summary;
    const verdict = out.verdict === "n/a" ? undefined : out.verdict;
    n.outputs = { text: result.output_text, summary, structured: out as unknown as Record<string, unknown>, history_ref: c.history_ref, verdict, files_changed: out.files_changed };

    // candidate state → validation → promotion / rejection
    const cands: HSCEntry[] = [];
    const add = (kind: HSCEntry["kind"], content: string, key?: string) => cands.push(this.hsc.add({ kind, content, key, producer: agent.agent_id, node_id: n.node_id, evidence_refs: [c.history_ref], confidence: 0.6, tags: [n.node_id, n.node_type] }));
    for (const d of out.decisions) add("decision", d);
    for (const a of out.assumptions) add("assumption", a);
    for (const q of out.questions) add("question", q);
    for (const f of out.files_changed) add("artifact", `${f} (changed in ${n.node_id})`, `artifact:${f}`);
    if (out.summary) add("completed_action", `${n.node_id}: ${out.summary.slice(0, 300)}`);
    if (n.node_type === "review") add("evidence", `Review ${n.node_id}: ${out.verdict}${out.findings.length ? ` — ${out.findings.length} findings` : ""}`, `review:${n.iteration}`);
    this.tracer.emit("candidate_state.created", { count: cands.length, ids: cands.map((e) => e.id) }, { node_id: n.node_id, agent_id: agent.agent_id });
    const validation = await this.validateNode(n, out);
    if (validation.ok) {
      for (const e of cands) this.hsc.promote([e.id], `validated at ${n.node_id}`, e.kind === "assumption" ? "tentative" : e.kind === "question" ? "active" : "accepted");
      this.tracer.emit("state.promoted", { ids: cands.map((e) => e.id), checks: validation.checks }, { node_id: n.node_id, agent_id: agent.agent_id });
    } else {
      this.hsc.reject(cands.map((e) => e.id), `validation failed at ${n.node_id}: ${validation.reason}`);
      this.tracer.emit("state.rejected", { ids: cands.map((e) => e.id), reason: validation.reason, checks: validation.checks }, { node_id: n.node_id, agent_id: agent.agent_id });
    }
    n.state_changes.push(...cands.map((e) => e.id));
    const hscDelta = cands.reduce((a, e) => a + estimateTokens(e.content), 0);
    this.costSoFar += cost; this.tokensSoFar += usageAgg.input + usageAgg.output + usageAgg.cache_read + usageAgg.cache_write;

    this.ledger.record(this.ledgerRow(n, agent.agent_id, result.invocation_id, result.model, packet, usageAgg, { retrieved: retrievedTokens, retrievals: rehydrated + packet.sections.filter((s) => s.source === "history").length, compacted: c.pre_tokens - c.post_tokens, compactions: 1, cost, cost_est: costEst, tok_est: tokEst, duration_ms: dur, peak, hsc_delta: hscDelta }));
    this.tracer.emit("evaluation.completed", { node: n.node_id, ok: validation.ok, checks: validation.checks }, { node_id: n.node_id });
    if (!validation.ok) throw new Error(`validation failed: ${validation.reason}`);
  }

  private async validateNode(n: GraphNode, out: AgentOutput): Promise<{ ok: boolean; reason?: string; checks: string[] }> {
    const checks: string[] = [];
    if (!out.summary) return { ok: false, reason: "empty output", checks };
    if (n.node_type === "review" && out.verdict === "n/a") return { ok: false, reason: "review produced no verdict", checks };
    for (const c of n.acceptance_criteria) {
      if (c.type === "file_exists") {
        const r = await this.o.runtime.runCommand(`test -e "${c.path}"`, this.o.workspace);
        checks.push(`${c.path}: ${r.exit_code === 0 ? "exists" : "missing"}`);
        if (r.exit_code !== 0 && this.o.runtime.name !== "mock") return { ok: false, reason: `expected file missing: ${c.path}`, checks };
      }
    }
    return { ok: true, checks };
  }

  private ledgerRow(n: GraphNode, agent_id: string, invocation_id: string, model: string, packet: ContextPacket | undefined, usage: { input: number; output: number; cache_read: number; cache_write: number } | undefined,
    x: { retrieved?: number; retrievals?: number; compacted?: number; compactions?: number; cost?: number; cost_est?: boolean; tok_est?: boolean; duration_ms?: number; peak?: number; hsc_delta?: number; tool_tokens?: number }): ContextLedgerEntry {
    const u = usage ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    const compiled = packet?.tokens ?? 0;
    const active = x.peak ?? u.input + u.cache_read + u.cache_write;
    return {
      workflow_id: this.o.workflow_id, mode: "governed", node_id: n.node_id, agent_id, invocation_id, model, phase: n.node_type,
      available_context_tokens: packet?.available_tokens ?? this.governor.availableTokens(), compiled_context_tokens: compiled,
      hsc_tokens: packet?.hsc_tokens ?? 0, retrieved_tokens: x.retrieved ?? 0, file_tokens: packet?.file_tokens ?? 0, tool_tokens: x.tool_tokens ?? Math.max(0, active - compiled - (x.retrieved ?? 0)),
      prompt_overhead_tokens: usage ? Math.max(0, (u.input + u.cache_read + u.cache_write) - compiled - (x.retrieved ?? 0) - (x.tool_tokens ?? 0)) : 0,
      input_tokens: u.input, output_tokens: u.output, cache_read_tokens: u.cache_read, cache_write_tokens: u.cache_write, active_context_tokens: active,
      compacted_tokens_removed: x.compacted ?? 0, discarded_tokens: packet?.discarded_tokens ?? 0, retrievals: x.retrievals ?? 0, compactions: x.compactions ?? 0,
      hsc_delta_tokens: x.hsc_delta ?? 0, estimated_cost_usd: x.cost ?? 0, cost_estimated: x.cost_est ?? true, tokens_estimated: x.tok_est ?? true,
      duration_ms: x.duration_ms ?? 0, attempt: n.attempts, ts: new Date().toISOString(),
    };
  }

  private persist(): void {
    writeFileSync(join(this.o.out_dir, "graph.json"), JSON.stringify(this.graph, null, 2));
    this.hsc.save();
  }

  summary(): WorkflowSummary {
    const t = this.ledger.totals();
    return {
      workflow_id: this.o.workflow_id, mode: "governed", governance: "full", task_id: this.o.task.id, runtime: this.o.runtime.name, status: this.status,
      ...t, elapsed_ms: Date.now() - this.startedAt, graph_nodes: this.graph.nodes.length, loops: this.loops, retries: this.retries,
      replans: this.graph.replans.filter((r) => r.action.startsWith("replan")).length,
    };
  }
}
