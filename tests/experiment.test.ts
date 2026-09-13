import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runExperiment } from "../src/experiment.ts";
import { runControl } from "../src/control.ts";
import { MockRuntime } from "../src/runtime.ts";
import { fakeRepo, task, tmp } from "./helpers.ts";

test("control mode: one session whose context accumulates monotonically", async () => {
  const out = tmp(); const ws = fakeRepo();
  const s = await runControl({ task: task(), workflow_id: "c", runtime: new MockRuntime({ review_verdicts: ["fail", "pass"] }), workspace: ws, out_dir: out, model: "opus" });
  const rows = readFileSync(join(out, "ledger.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(s.status, "completed");
  assert.deepEqual(rows.map((r) => r.node_id), ["plan", "implement", "test", "review", "patch#2", "test#2", "review#2"]);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].active_context_tokens > rows[i - 1].active_context_tokens, "context grows every turn");
  assert.equal(s.retrievals, 0); assert.equal(s.compactions, 0);
});

test("experiment runs both modes on isolated workspaces and produces a comparable report", async () => {
  const repo = fakeRepo(); const out = tmp();
  const exp = await runExperiment({ task: task({ acceptance_criteria: [{ type: "file_exists", path: "src/widget.ts" }, { type: "command", cmd: "npm test" }] }), modes: ["governed", "control"], runtime: "mock", scenario: { write_on_implement: { "src/widget.ts": "export const w = 1;" } }, repo_root: repo, out_root: out, experiment_id: "e1" });
  assert.ok(exp.modes.governed && exp.modes.control);
  assert.ok(existsSync(join(out, "e1/governed/workspace/src/widget.ts")));
  assert.ok(existsSync(join(out, "e1/report.md")) && existsSync(join(out, "e1/summary.json")));
  const md = readFileSync(join(out, "e1/report.md"), "utf8");
  assert.match(md, /Lifecycle token reduction/); assert.match(md, /Routing decisions/); assert.match(md, /Compiled context packets/);
  assert.equal(typeof exp.comparison!.lifecycle_token_reduction, "number");
  assert.equal(exp.modes.governed!.evaluation.criteria_passed, 2);
  assert.notEqual(exp.modes.governed!.blind_label, exp.modes.control!.blind_label);
});
