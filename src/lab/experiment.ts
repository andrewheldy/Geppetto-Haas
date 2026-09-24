import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ContextLedgerEntry, EvaluationResult, ExecutionMode, RuntimeAdapter, Task, TraceEvent } from "./types.ts";
import { Orchestrator } from "./orchestrator.ts";
import { runControl } from "./control.ts";
import { DeterministicPlanner } from "./planner.ts";
import { DeterministicRouter, type Tier } from "./router.ts";
import { ClaudeCliRuntime, makeRuntime, primaryModel, type MockScenario } from "./runtime.ts";
import { ContextLedger } from "./ledger.ts";
import { estimateTokens } from "../tokens.ts";
import { blindReview, evaluateAcceptance } from "./evaluator.ts";
import { compare, renderReport, type ExperimentSummary, type ModeResult } from "./report.ts";
import { resetAgentSeq } from "./factory.ts";

export interface ExperimentOptions {
  task: Task; modes: ExecutionMode[]; runtime: "mock" | "claude"; scenario?: MockScenario; repo_root: string; out_root: string;
  experiment_id?: string; cap?: Tier; overrides?: Partial<Record<Tier, string>>; control_model?: string; blind_model?: string; l0_budget?: number; max_turns?: number;
}

/** Copy the repo (minus node_modules/runs/.git) into an isolated workspace with its own git baseline. */
export function prepareWorkspace(repoRoot: string, ws: string, source?: string): string {
  mkdirSync(ws, { recursive: true });
  const from = source ? join(repoRoot, source) : repoRoot;
  const skip = /^(node_modules(\.nosync)?|runs(\.nosync)?|\.git|\.DS_Store)$/;
  for (const name of readdirSync(from)) if (!skip.test(name)) cpSync(join(from, name), join(ws, name), { recursive: true, filter: (src) => !/(^|\/)(node_modules|\.DS_Store)(\/|$)/.test(src) });
  const nm = join(repoRoot, existsSync(join(repoRoot, "node_modules.nosync")) ? "node_modules.nosync" : "node_modules");
  if (existsSync(nm) && !existsSync(join(ws, "node_modules"))) symlinkSync(nm, join(ws, "node_modules"));
  return ws;
}

export function loadTask(file: string): Task {
  const t = JSON.parse(readFileSync(file, "utf8"));
  return { kind: "software_build", constraints: [], acceptance_criteria: [], budget: {}, ...t };
}

export async function runExperiment(o: ExperimentOptions): Promise<ExperimentSummary> {
  const id = o.experiment_id ?? `exp-${o.task.id}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const dir = join(o.out_root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.json"), JSON.stringify(o.task, null, 2));
  const labels = Math.random() < 0.5 ? ["A", "B"] : ["B", "A"];
  const prior: ExperimentSummary | undefined = existsSync(join(dir, "summary.json")) ? JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) : undefined;
  const exp: ExperimentSummary = prior ? { ...prior, modes: Object.fromEntries(Object.entries(prior.modes).filter(([m]) => !o.modes.includes(m as ExecutionMode))), comparison: undefined } : {
    experiment_id: id, task_id: o.task.id, objective: o.task.objective, runtime: o.runtime, created_at: new Date().toISOString(),
    governance_note: "Governed mode = full Geppetto (graph, JIT specialists, HSC, governor, compiled L0, retrieval, compaction, isolated review). Control = one accumulating session (bootstrap-style, no governance). The harness itself was built pre-Geppetto (bootstrap); only the task under test is governed.",
    modes: {},
  };
  for (const m of Object.values(exp.modes)) if (m) m.dir = join(dir, m.summary.mode);
  for (const mode of o.modes) {
    resetAgentSeq();
    const modeDir = join(dir, mode); const ws = prepareWorkspace(o.repo_root, join(modeDir, "workspace"), o.task.workspace_source);
    const runtime = makeRuntime(o.runtime, { scenario: o.scenario, log_dir: join(modeDir, "invocations") });
    await runtime.runCommand("git init -q && git add -A && git -c user.name=geppetto -c user.email=g@local commit -qm baseline", ws);
    const workflow_id = `${id}-${mode}`;
    const summary = mode === "governed"
      ? await new Orchestrator({ task: o.task, workflow_id, runtime, planner: new DeterministicPlanner(), router: new DeterministicRouter({ cap: o.cap, overrides: o.overrides }), workspace: ws, out_dir: modeDir, experiment_id: id, l0_budget: o.l0_budget, max_turns: o.max_turns }).run()
      : await runControl({ task: o.task, workflow_id, runtime, workspace: ws, out_dir: modeDir, experiment_id: id, model: o.control_model ?? o.overrides?.opus ?? (o.cap ?? "opus"), max_turns: o.max_turns });
    const trace: TraceEvent[] = readFileSync(join(modeDir, "trace.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const findings = trace.filter((e) => e.type === "candidate_state.created" || e.type === "control.turn.completed").length && trace.reduce((a, e) => a + (e.type === "node.completed" && e.data.verdict === "fail" ? 1 : 0), 0);
    const evaluation: EvaluationResult = await evaluateAcceptance(o.task, ws, runtime, { workflow_id, mode, retries: summary.retries, review_findings: findings });
    const diff = await runtime.runCommand("git add -A -N . && git --no-pager diff", ws);
    writeFileSync(join(modeDir, "diff.patch"), diff.stdout);
    const label = labels[mode === "governed" ? 0 : 1];
    if (o.blind_model) evaluation.blind_review = await blindReview(o.task, diff.stdout, runtime, o.blind_model, label, ws);
    summary.evaluation = evaluation;
    writeFileSync(join(modeDir, "evaluation.json"), JSON.stringify(evaluation, null, 2));
    writeFileSync(join(modeDir, "summary.json"), JSON.stringify(summary, null, 2));
    exp.modes[mode] = { summary, evaluation, dir: modeDir, blind_label: label } satisfies ModeResult;
  }
  const g = exp.modes.governed;
  const gTrace: TraceEvent[] = g ? readFileSync(join(g.dir, "trace.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const gLedger = g ? readFileSync(join(g.dir, "ledger.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  exp.comparison = compare(g, exp.modes.control, gTrace, gLedger);
  writeFileSync(join(dir, "summary.json"), JSON.stringify(exp, null, 2));
  writeFileSync(join(dir, "report.md"), renderReport(exp));
  return exp;
}

/** Re-score finished runs (deterministic checks only; blind reviews are kept) and regenerate summary + report. */
export async function reevaluate(dir: string, opts: { blind_model?: string } = {}): Promise<ExperimentSummary> {
  const root = resolve(dir);
  const exp: ExperimentSummary = JSON.parse(readFileSync(join(root, "summary.json"), "utf8"));
  const task = loadTask(join(root, "task.json"));
  const runtime = makeRuntime("claude");
  for (const m of Object.values(exp.modes)) {
    if (!m) continue;
    m.dir = join(root, m.summary.mode);
    const fresh = await evaluateAcceptance(task, join(m.dir, "workspace"), runtime, { workflow_id: m.summary.workflow_id, mode: m.summary.mode, retries: m.summary.retries, review_findings: m.evaluation.review_findings });
    m.evaluation = { ...fresh, blind_review: m.evaluation.blind_review };
    if (opts.blind_model && (!m.evaluation.blind_review || m.evaluation.blind_review.score < 0)) {
      const diff = readFileSync(join(m.dir, "diff.patch"), "utf8");
      m.evaluation.blind_review = await blindReview(task, diff, makeRuntime("claude", { log_dir: join(m.dir, "invocations") }), opts.blind_model, m.blind_label ?? "A", join(m.dir, "workspace"));
    }
    rebuildLedger(m.dir, runtime, task);
    Object.assign(m.summary, new ContextLedger(join(m.dir, "ledger.jsonl")).totals());
    m.summary.evaluation = m.evaluation;
    writeFileSync(join(m.dir, "evaluation.json"), JSON.stringify(m.evaluation, null, 2));
    writeFileSync(join(m.dir, "summary.json"), JSON.stringify(m.summary, null, 2));
  }
  const g = exp.modes.governed;
  const gTrace: TraceEvent[] = g ? readFileSync(join(g.dir, "trace.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const gLedger = g ? readFileSync(join(g.dir, "ledger.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  exp.comparison = compare(g, exp.modes.control, gTrace, gLedger);
  writeFileSync(join(root, "summary.json"), JSON.stringify(exp, null, 2));
  writeFileSync(join(root, "report.md"), renderReport(exp));
  return exp;
}

/** Correct ledger rows in place from the raw runtime responses saved under invocations/: primary model, overhead vs tool tokens. */
export function rebuildLedger(modeDir: string, runtime: RuntimeAdapter, _task: Task): void {
  const file = join(modeDir, "ledger.jsonl");
  if (!existsSync(file)) return;
  const rows: ContextLedgerEntry[] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const overheadFor = (tools: string[]) => { const k = [...tools].sort().join(","); return OVERHEAD_TABLE[k] ?? OVERHEAD_TABLE["*"] ?? 0; };
  for (const r of rows) {
    const inv = join(modeDir, "invocations", `${r.invocation_id}.json`);
    if (!existsSync(inv)) continue;
    const j = JSON.parse(readFileSync(inv, "utf8"));
    let out: any; try { out = JSON.parse(String(j.stdout).trim().split("\n").filter((l: string) => l.startsWith("{")).pop() ?? ""); } catch { continue; }
    r.model = primaryModel(out?.modelUsage) ?? r.model;
    const overhead = overheadFor(j.req.tools ?? []);
    const system = estimateTokens(String(j.req.system_prompt ?? ""));
    r.prompt_overhead_tokens = overhead;
    r.tool_tokens = Math.max(0, r.active_context_tokens - r.compiled_context_tokens - r.retrieved_tokens - (r.mode === "governed" ? system : 0) - overhead);
  }
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  void runtime;
}

/** Measured once per tool set with `calibrateOverhead`; keyed by sorted tool list. "*" is the fallback. Fill via `geppetto calibrate`. */
export const OVERHEAD_TABLE: Record<string, number> = existsSync(resolve("runs/overhead.json")) ? JSON.parse(readFileSync(resolve("runs/overhead.json"), "utf8")) : {};

export async function calibrate(): Promise<Record<string, number>> {
  const rt = new ClaudeCliRuntime();
  const sets = [["Glob", "Grep", "Read"], ["Bash", "Edit", "Glob", "Grep", "Read", "Write"], []];
  const out: Record<string, number> = {};
  for (const s of sets) out[[...s].sort().join(",")] = await rt.calibrateOverhead(s, resolve("."));
  out["*"] = out["Bash,Edit,Glob,Grep,Read,Write"];
  mkdirSync(resolve("runs"), { recursive: true });
  writeFileSync(resolve("runs/overhead.json"), JSON.stringify(out, null, 2));
  return out;
}

export function reportFromDir(dir: string): string {
  const exp: ExperimentSummary = JSON.parse(readFileSync(join(resolve(dir), "summary.json"), "utf8"));
  for (const m of Object.values(exp.modes)) if (m) m.dir = join(resolve(dir), m.summary.mode);
  return renderReport(exp);
}
