import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ContextLedgerEntry, InvocationResult, RuntimeAdapter, Task, WorkflowSummary } from "./types.ts";
import { Tracer } from "./trace.ts";
import { ContextLedger } from "./ledger.ts";
import { HistoricalStore } from "./history.ts";
import { activeContext, estimateTokens } from "../tokens.ts";
import { BLIND_REVIEW_SCHEMA } from "./evaluator.ts";

export interface ControlOptions {
  task: Task; workflow_id: string; runtime: RuntimeAdapter; workspace: string; out_dir: string; experiment_id?: string;
  model: string; max_turns?: number;
}

const SYSTEM = `You are a senior software engineer working autonomously in this repository. There is no user to ask; make reasonable decisions and proceed. Write tests alongside behavior, run them, and keep diffs minimal. Do not commit.`;

const REVIEW_SCHEMA = { type: "object", properties: { verdict: { type: "string", enum: ["pass", "fail"] }, findings: { type: "array", items: { type: "string" } }, summary: { type: "string" } }, required: ["verdict", "findings", "summary"], additionalProperties: false };

/**
 * MODE B — monolithic control: one agent, one continuously accumulating session, same objective, same acceptance
 * criteria, same tools, same phases as user turns. No HSC, no compilation, no isolation, no proactive compaction.
 * Not sabotaged: it is a competent conventional long-agent workflow.
 */
export async function runControl(o: ControlOptions): Promise<WorkflowSummary> {
  mkdirSync(o.out_dir, { recursive: true });
  const tracer = new Tracer(join(o.out_dir, "trace.jsonl"), { experiment_id: o.experiment_id, workflow_id: o.workflow_id, mode: "control" });
  const ledger = new ContextLedger(join(o.out_dir, "ledger.jsonl"));
  const history = new HistoricalStore(join(o.out_dir, "history.jsonl"));
  const started = Date.now();
  const session_id = randomUUID();
  const { task } = o;
  const testCmd = task.test_command ?? "npm test";
  const criteria = task.acceptance_criteria.map((c) => `- ${c.type === "manual" ? c.description : c.type === "command" ? `command passes: ${c.cmd}` : c.type === "file_exists" ? `file exists: ${c.path}` : `${c.path} matches /${c.pattern}/`}`).join("\n");
  const brief = `# Task\n${task.objective}\n\n## Constraints\n${task.constraints.map((c) => `- ${c}`).join("\n")}\n\n## Acceptance criteria\n${criteria}\n\nTest command: ${testCmd}\nRelevant files: ${(task.context_files ?? []).join(", ") || "(explore the repo)"}`;
  tracer.emit("workflow.created", { task_id: task.id, objective: task.objective, workspace: o.workspace, runtime: o.runtime.name, session_id });

  const overhead = await (o.runtime as { calibrateOverhead?: (t: string[], c: string) => Promise<number> }).calibrateOverhead?.(["Read", "Edit", "Write", "Glob", "Grep", "Bash"], o.workspace) ?? 0;
  let transcriptTokens = 0; let turn = 0; let retries = 0; let findings = 0; let status: WorkflowSummary["status"] = "completed";
  let costSoFar = 0;
  const say = async (label: string, prompt: string, schema?: Record<string, unknown>): Promise<InvocationResult> => {
    if (task.budget.max_usd && costSoFar > task.budget.max_usd) throw new Error(`budget exceeded: $${costSoFar.toFixed(2)} > $${task.budget.max_usd}`);
    turn++;
    const invocation_id = `ctl-${turn}-${randomUUID().slice(0, 6)}`;
    const promptTokens = estimateTokens(prompt);
    tracer.emit("control.turn.started", { turn, label, prompt_tokens: promptTokens, transcript_tokens_before: transcriptTokens }, { invocation_id, agent_id: "monolith" });
    const r = await o.runtime.invoke({ invocation_id, agent_id: "monolith", node_id: label, model: o.model, effort: "high", system_prompt: SYSTEM, prompt, tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"], cwd: o.workspace, max_turns: o.max_turns ?? 60, max_usd: task.budget.max_usd, session_id, resume: turn > 1, json_schema: schema });
    history.append({ type: "conversation", node_id: label, agent_id: "monolith", tags: [label], content: `USER:\n${prompt}\n\nASSISTANT:\n${r.output_text}` });
    const peak = Math.max(...(r.iterations.length ? r.iterations.map(activeContext) : [activeContext(r.usage)]));
    // In a monolithic session everything ever seen is both available and injected: no compilation happens.
    const available = transcriptTokens + promptTokens + estimateTokens(SYSTEM);
    const row: ContextLedgerEntry = {
      workflow_id: o.workflow_id, mode: "control", node_id: label, agent_id: "monolith", invocation_id, model: r.model, phase: label,
      available_context_tokens: Math.max(available, peak), compiled_context_tokens: Math.max(available, peak), hsc_tokens: 0, retrieved_tokens: 0, file_tokens: 0,
      tool_tokens: Math.max(0, peak - available - overhead), prompt_overhead_tokens: overhead,
      input_tokens: r.usage.input, output_tokens: r.usage.output, cache_read_tokens: r.usage.cache_read, cache_write_tokens: r.usage.cache_write, active_context_tokens: peak,
      compacted_tokens_removed: 0, discarded_tokens: 0, retrievals: 0, compactions: 0, hsc_delta_tokens: 0,
      estimated_cost_usd: r.cost_usd, cost_estimated: r.cost_estimated, tokens_estimated: r.usage.estimated, duration_ms: r.duration_ms, attempt: 1, ts: new Date().toISOString(),
    };
    ledger.record(row);
    transcriptTokens = Math.max(transcriptTokens + promptTokens + r.usage.output, peak); // the session now carries everything, including tool results
    costSoFar += r.cost_usd;
    tracer.emit("control.turn.completed", { turn, label, usage: r.usage, cost_usd: r.cost_usd, duration_ms: r.duration_ms, peak_active_context: peak, transcript_tokens_after: transcriptTokens, error: r.error }, { invocation_id, agent_id: "monolith" });
    if (r.error) throw new Error(r.error);
    return r;
  };

  try {
    await say("plan", `${brief}\n\nFirst, read the relevant files and write a short implementation plan (files, interfaces, tests, risks). Do not modify files yet.`);
    await say("implement", `Implement the plan now. Write tests. Run \`${testCmd}\` before finishing and report the result.`);
    await say("test", `Run \`${testCmd}\` and report the exact result.`);
    const maxIter = task.max_review_iterations ?? 2;
    for (let i = 0; i <= maxIter; i++) {
      if (task.budget.max_usd && costSoFar > task.budget.max_usd) { status = "budget_exceeded"; tracer.emit("workflow.budget_exceeded", { cost: costSoFar }); break; }
      const r = await say(i === 0 ? "review" : `review#${i + 1}`, `Review your work critically against the acceptance criteria and the test results. List concrete findings (bugs, unmet criteria, missing tests). Verdict "fail" if tests fail or any criterion is unmet.`, REVIEW_SCHEMA);
      const s = (r.structured ?? {}) as { verdict?: string; findings?: string[] };
      findings += s.findings?.length ?? 0;
      if (s.verdict !== "fail") break;
      if (i === maxIter) { tracer.emit("loop.exhausted", { iterations: i }); break; }
      retries++;
      await say(`patch#${i + 2}`, `Fix these findings, then re-run \`${testCmd}\` and report:\n${(s.findings ?? []).map((f) => `- ${f}`).join("\n")}`);
      await say(`test#${i + 2}`, `Run \`${testCmd}\` and report the exact result.`);
    }
  } catch (err) {
    status = "failed";
    tracer.emit("workflow.failed", { error: (err as Error).message });
  }
  const t = ledger.totals();
  const summary: WorkflowSummary = {
    workflow_id: o.workflow_id, mode: "control", governance: "bootstrap", task_id: task.id, runtime: o.runtime.name, status, ...t,
    elapsed_ms: Date.now() - started, graph_nodes: turn, loops: retries, retries, replans: 0,
  };
  writeFileSync(join(o.out_dir, "summary.json"), JSON.stringify(summary, null, 2));
  tracer.emit("workflow.completed", { ...summary });
  return summary;
}

export { BLIND_REVIEW_SCHEMA };
