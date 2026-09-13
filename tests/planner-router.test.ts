import { test } from "node:test";
import assert from "node:assert/strict";
import { DeterministicPlanner } from "../src/planner.ts";
import { DeterministicRouter } from "../src/router.ts";
import { analyzeCapabilities, createAgent, resolveTools } from "../src/factory.ts";
import { task } from "./helpers.ts";

test("planner emits the default build loop with a deterministic test join and bounded review loop", () => {
  const g = new DeterministicPlanner().plan(task(), "w");
  assert.deepEqual(g.nodes.map((n) => n.node_id), ["plan", "implement", "test", "review", "human_gate"]);
  assert.equal(g.nodes[2].deterministic, true);
  assert.equal(g.nodes[3].loop_policy?.max_iterations, 2);
});

test("subtasks fan out in parallel and join at test", () => {
  const t = task({ subtasks: [{ id: "a", objective: "A" }, { id: "b", objective: "B" }] });
  const g = new DeterministicPlanner().plan(t, "w");
  const impls = g.nodes.filter((n) => n.node_type === "implement");
  assert.equal(impls.length, 2);
  assert.ok(impls.every((n) => n.parallel_group === "implement"));
  assert.deepEqual(g.nodes.find((n) => n.node_id === "test")!.dependencies, ["implement:a", "implement:b"]);
});

test("loop expansion is bounded and rewires the human gate; replan inserts diagnose then re-attempt, max twice", () => {
  const p = new DeterministicPlanner(); const t = task({ max_review_iterations: 1 });
  const g = p.plan(t, "w");
  const review = g.nodes.find((n) => n.node_id === "review")!;
  const added = p.expandLoop(g, review, t);
  assert.deepEqual(added.map((n) => n.node_id), ["patch#2", "test#2", "review#2"]);
  assert.deepEqual(g.nodes.find((n) => n.node_type === "human_gate")!.dependencies, ["review#2"]);
  assert.equal(p.expandLoop(g, added[2], t).length, 0, "second iteration exceeds max_iterations=1");
  const impl = g.nodes.find((n) => n.node_id === "implement")!;
  assert.deepEqual(p.replan(g, impl, "boom"), ["diagnose:implement", "implement#r"]);
  assert.deepEqual(g.nodes.find((n) => n.node_id === "test")!.dependencies, ["implement#r"], "dependents rewired");
  p.replan(g, impl, "boom2");
  assert.equal(p.replan(g, impl, "boom3").length, 0, "replans bounded");
});

test("router explains itself, escalates on retry, respects caps; factory enforces least privilege", () => {
  const g = new DeterministicPlanner().plan(task(), "w");
  const impl = g.nodes.find((n) => n.node_id === "implement")!, review = g.nodes.find((n) => n.node_id === "review")!;
  const r = new DeterministicRouter();
  const a = r.route(impl, analyzeCapabilities(impl, task()), 0);
  assert.equal(a.model, "opus"); assert.ok(a.reasons.length);
  const capped = new DeterministicRouter({ cap: "haiku" }).route(impl, analyzeCapabilities(impl, task()), 0);
  assert.equal(capped.model, "haiku"); assert.match(capped.reasons.join(), /capped/);
  const low = { ...impl, complexity: "low" as const, reasoning: "low" as const };
  assert.equal(r.route(low, analyzeCapabilities(low, task()), 0).model, "haiku");
  assert.equal(r.route(low, analyzeCapabilities(low, task()), 1).model, "sonnet");
  review.allowed_tools = ["Read", "Edit", "Bash"];
  assert.deepEqual(resolveTools(review), ["Read"]);
  const agent = createAgent(review, analyzeCapabilities(review, task()), a, []);
  assert.equal(agent.authority, "read"); assert.equal(agent.lifecycle, "ephemeral");
  assert.ok(agent.capabilities.needs_independence);
});

test("parallel implement nodes only carry file criteria that belong to their subtask", () => {
  const t = task({ acceptance_criteria: [{ type: "file_exists", path: "src/a.ts" }, { type: "file_exists", path: "src/b.ts" }], subtasks: [{ id: "a", objective: "write src/a.ts" }, { id: "b", objective: "write src/b.ts" }] });
  const g = new DeterministicPlanner().plan(t, "w");
  assert.deepEqual(g.nodes.find((n) => n.node_id === "implement:a")!.acceptance_criteria, [{ type: "file_exists", path: "src/a.ts" }]);
  assert.deepEqual(g.nodes.find((n) => n.node_id === "implement:b")!.acceptance_criteria, [{ type: "file_exists", path: "src/b.ts" }]);
});
