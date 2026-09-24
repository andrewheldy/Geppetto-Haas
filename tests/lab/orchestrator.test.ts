import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Orchestrator } from "../../src/lab/orchestrator.ts";
import { DeterministicPlanner } from "../../src/lab/planner.ts";
import { DeterministicRouter } from "../../src/lab/router.ts";
import { MockRuntime, type MockScenario } from "../../src/lab/runtime.ts";
import { fakeRepo, task, tmp } from "./helpers.ts";
import type { Task } from "../../src/lab/types.ts";

async function run(scenario: MockScenario = {}, t: Task = task()) {
  const out = tmp(); const ws = fakeRepo();
  const runtime = new MockRuntime({ write_on_implement: { "src/widget.ts": "export const w = 1;" }, ...scenario });
  const orch = new Orchestrator({ task: t, workflow_id: "w", runtime, planner: new DeterministicPlanner(), router: new DeterministicRouter(), workspace: ws, out_dir: out });
  const summary = await orch.run();
  const trace = readFileSync(join(out, "trace.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const types = trace.map((e: any) => e.type);
  return { summary, orch, trace, types, runtime, out };
}

test("happy path: task → graph → JIT agents → compiled context → HSC → ledger → trace", async () => {
  const { summary, orch, types, out } = await run();
  assert.equal(summary.status, "completed");
  for (const t of ["workflow.created", "graph.planned", "node.started", "context.compiled", "agent.created", "model.routed", "handoff.created", "tool.called", "context.compacted", "candidate_state.created", "state.promoted", "human_gate.decided", "workflow.completed"]) assert.ok(types.includes(t), `missing trace ${t}`);
  assert.equal(orch.agents.length, 3, "plan, implement, review specialists");
  assert.equal(orch.ledger.entries.length, 4, "3 agent invocations + test runner; the human gate costs no context");
  assert.equal(summary.agent_calls, 3);
  const impl = orch.ledger.entries.find((e) => e.node_id === "implement")!;
  assert.ok(impl.compiled_context_tokens > 0 && impl.compiled_context_tokens <= impl.available_context_tokens);
  assert.ok(orch.hsc.slice({ kinds: ["decision"] }).length >= 1, "decisions promoted into HSC");
  assert.ok(orch.hsc.state.entries.every((e) => e.provenance.producer), "provenance on every entry");
  assert.ok(readFileSync(join(out, "hsc.json"), "utf8").includes("\"entries\""));
  assert.equal(summary.peak_active_context, Math.max(...orch.ledger.entries.map((e) => e.active_context_tokens)));
});

test("review fail triggers a bounded patch→test→review loop, then passes", async () => {
  const { summary, orch, types } = await run({ review_verdicts: ["fail", "pass"] });
  assert.equal(summary.status, "completed"); assert.equal(summary.loops, 1);
  assert.deepEqual(orch.graph.nodes.map((n) => n.node_id), ["plan", "implement", "test", "review", "human_gate", "patch#2", "test#2", "review#2"]);
  assert.ok(types.includes("graph.replanned"));
  assert.equal(orch.graph.nodes.find((n) => n.node_id === "human_gate")!.outputs?.verdict, "pass");
});

test("review loop exhaustion is recorded and the gate fails closed", async () => {
  const { summary, orch, types } = await run({ review_verdicts: ["fail", "fail", "fail"] }, task({ max_review_iterations: 1 }));
  assert.ok(types.includes("loop.exhausted"));
  assert.equal(summary.loops, 1);
  assert.equal(orch.graph.nodes.find((n) => n.node_id === "human_gate")!.outputs?.verdict, "fail");
  assert.ok(orch.hsc.slice({ kinds: ["question"] }).some((e) => /exhausted/.test(e.content)));
});

test("missing context → JIT rehydration → re-invocation, measured as a retrieval not a retry", async () => {
  const { summary, orch, types, runtime } = await run({ need_context_on: ["implement"] });
  assert.equal(summary.retries, 0); assert.equal(summary.retrievals, 1);
  assert.ok(types.includes("context.retrieved"));
  assert.equal(runtime.invocations.filter((i) => i.node_id === "implement").length, 2);
  const row = orch.ledger.entries.find((e) => e.node_id === "implement")!;
  assert.equal(row.retrievals, 1);
  assert.ok(runtime.invocations[2].prompt.includes("Rehydrated context"));
});

test("node failure → retry with escalated model → replan with diagnose node", async () => {
  const { summary, orch, types, trace } = await run({ fail_times: { implement: 2 } });
  assert.equal(summary.status, "completed");
  assert.equal(summary.retries, 1); assert.equal(summary.replans, 1);
  assert.ok(types.includes("node.retried") && types.includes("graph.replanned"));
  assert.ok(orch.graph.nodes.some((n) => n.node_id === "diagnose:implement"));
  const routed = trace.filter((e: any) => e.type === "model.routed" && e.node_id === "implement");
  assert.ok(routed[1].data.reasons.some((r: string) => /escalate/.test(r)), "second attempt escalated the model tier");
  assert.equal(orch.graph.nodes.find((n) => n.node_id === "implement")!.status, "replaced");
});

test("parallel fan-out runs concurrently and joins at test", async () => {
  const t = task({ subtasks: [{ id: "a", objective: "A" }, { id: "b", objective: "B" }] });
  const { orch, trace } = await run({ delay_ms: 30 }, t);
  const batch = trace.find((e: any) => e.type === "graph.parallel_batch");
  assert.deepEqual(batch.data.nodes, ["implement:a", "implement:b"]);
  const starts = trace.filter((e: any) => e.type === "node.started" && e.node_id.startsWith("implement:")).map((e: any) => e.ts);
  const ends = trace.filter((e: any) => e.type === "node.completed" && e.node_id.startsWith("implement:")).map((e: any) => e.ts);
  assert.ok(starts[1] < ends[0], "second implement started before first finished");
  assert.equal(orch.graph.nodes.find((n) => n.node_id === "test")!.status, "succeeded");
});

test("budget exhaustion stops the workflow", async () => {
  const { summary, types } = await run({}, task({ budget: { max_tokens: 10 } }));
  assert.equal(summary.status, "budget_exceeded");
  assert.ok(types.includes("workflow.budget_exceeded"));
});
