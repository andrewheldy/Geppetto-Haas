#!/usr/bin/env node
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { calibrate, loadTask, prepareWorkspace, reevaluate, reportFromDir, runExperiment } from "./experiment.ts";
import { Orchestrator } from "./orchestrator.ts";
import { runControl } from "./control.ts";
import { DeterministicPlanner } from "./planner.ts";
import { DeterministicRouter, type Tier } from "./router.ts";
import { makeRuntime } from "./runtime.ts";

const USAGE = `geppetto <command> [options]

  run         --task <file> [--mode governed|control] [--runtime mock|claude] [--out runs/...] [--cap haiku|sonnet|opus]
  experiment  --task <file> [--modes governed,control] [--runtime mock|claude] [--cap tier] [--control-model m] [--blind-model m] [--out runs]
  report      --dir runs/<experiment-id>
  reevaluate  --dir runs/<experiment-id>      re-run deterministic acceptance checks on finished workspaces, rebuild ledger labels, regenerate report
  calibrate                                   measure the runtime's fixed per-request overhead per tool set (writes runs/overhead.json)
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values: v } = parseArgs({ args: rest, options: {
    task: { type: "string" }, mode: { type: "string", default: "governed" }, modes: { type: "string", default: "governed,control" },
    runtime: { type: "string", default: "mock" }, out: { type: "string" }, cap: { type: "string" }, "control-model": { type: "string" },
    "blind-model": { type: "string" }, dir: { type: "string" }, id: { type: "string" }, "l0-budget": { type: "string" }, "max-turns": { type: "string" },
  }, allowPositionals: true });
  const repo = resolve(process.cwd());
  if (cmd === "run") {
    const task = loadTask(v.task!);
    const id = v.id ?? `run-${task.id}-${Date.now()}`;
    const out = resolve(v.out ?? join("runs", id));
    const ws = prepareWorkspace(repo, join(out, "workspace"), task.workspace_source);
    const runtime = makeRuntime(v.runtime!, { log_dir: join(out, "invocations") });
    await runtime.runCommand("git init -q && git add -A && git -c user.name=geppetto -c user.email=g@local commit -qm baseline", ws);
    const summary = v.mode === "control"
      ? await runControl({ task, workflow_id: id, runtime, workspace: ws, out_dir: out, model: v["control-model"] ?? v.cap ?? "opus", max_turns: v["max-turns"] ? +v["max-turns"] : undefined })
      : await new Orchestrator({ task, workflow_id: id, runtime, planner: new DeterministicPlanner(), router: new DeterministicRouter({ cap: v.cap as Tier | undefined }), workspace: ws, out_dir: out, l0_budget: v["l0-budget"] ? +v["l0-budget"] : undefined, max_turns: v["max-turns"] ? +v["max-turns"] : undefined }).run();
    console.log(JSON.stringify(summary, null, 2));
    console.log(`artifacts: ${out}`);
  } else if (cmd === "experiment") {
    const task = loadTask(v.task!);
    const exp = await runExperiment({ task, modes: v.modes!.split(",") as any, runtime: v.runtime as any, repo_root: repo, out_root: resolve(v.out ?? "runs"), experiment_id: v.id, cap: v.cap as Tier | undefined, control_model: v["control-model"], blind_model: v["blind-model"], l0_budget: v["l0-budget"] ? +v["l0-budget"] : undefined, max_turns: v["max-turns"] ? +v["max-turns"] : undefined });
    console.log(reportFromDir(join(resolve(v.out ?? "runs"), exp.experiment_id)));
    console.log(`\nartifacts: ${join(resolve(v.out ?? "runs"), exp.experiment_id)}`);
  } else if (cmd === "calibrate") {
    console.log(JSON.stringify(await calibrate(), null, 2));
  } else if (cmd === "reevaluate") {
    const exp = await reevaluate(v.dir!, { blind_model: v["blind-model"] });
    console.log(JSON.stringify(exp.comparison, null, 2));
  } else if (cmd === "report") {
    const md = reportFromDir(v.dir!);
    mkdirSync(resolve(v.dir!), { recursive: true });
    writeFileSync(join(resolve(v.dir!), "report.md"), md);
    console.log(md);
  } else { console.log(USAGE); process.exit(cmd ? 1 : 0); }
}
main().catch((e) => { console.error(e); process.exit(1); });
