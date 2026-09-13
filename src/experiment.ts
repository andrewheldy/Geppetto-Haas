import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EvaluationResult, ExecutionMode, Task, TraceEvent } from "./types.ts";
import { Orchestrator } from "./orchestrator.ts";
import { runControl } from "./control.ts";
import { DeterministicPlanner } from "./planner.ts";
import { DeterministicRouter, type Tier } from "./router.ts";
import { makeRuntime, type MockScenario } from "./runtime.ts";
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
  cpSync(source ? join(repoRoot, source) : repoRoot, ws, { recursive: true, filter: (src) => !/(^|\/)(node_modules(\.nosync)?|runs(\.nosync)?|\.git|\.DS_Store)(\/|$)/.test(src.slice(repoRoot.length)) });
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
  const exp: ExperimentSummary = {
    experiment_id: id, task_id: o.task.id, objective: o.task.objective, runtime: o.runtime, created_at: new Date().toISOString(),
    governance_note: "Governed mode = full Geppetto (graph, JIT specialists, HSC, governor, compiled L0, retrieval, compaction, isolated review). Control = one accumulating session (bootstrap-style, no governance). The harness itself was built pre-Geppetto (bootstrap); only the task under test is governed.",
    modes: {},
  };
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

export function reportFromDir(dir: string): string {
  const exp: ExperimentSummary = JSON.parse(readFileSync(join(resolve(dir), "summary.json"), "utf8"));
  for (const m of Object.values(exp.modes)) if (m) m.dir = join(resolve(dir), m.summary.mode);
  return renderReport(exp);
}
