import type { AcceptanceCheck, Graph, GraphNode, NodeType, Task } from "./types.ts";

export interface Planner {
  plan(task: Task, workflowId: string): Graph;
  /** Modify the graph after a node exhausted its retries. Returns the replacement node ids or [] to give up. */
  replan(graph: Graph, failed: GraphNode, evidence: string): string[];
  /** Expand a bounded review loop after a failed review. */
  expandLoop(graph: Graph, review: GraphNode, task: Task): GraphNode[];
}

const IMPL_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];
const READ_TOOLS = ["Read", "Glob", "Grep"];

export function node(partial: Partial<GraphNode> & Pick<GraphNode, "node_id" | "objective" | "node_type">): GraphNode {
  return {
    dependencies: [], required_capabilities: [], required_context: [{ kind: "task" }], allowed_tools: READ_TOOLS,
    acceptance_criteria: [], budget: {}, status: "pending", inputs: {}, state_changes: [],
    retry_policy: { max_retries: 1, on_exhausted: "replan" }, complexity: "medium", reasoning: "medium",
    attempts: 0, iteration: 1, ...partial,
  };
}

/**
 * Deterministic planner. Converts a software-build objective into the default loop:
 * PLAN → IMPLEMENT (fan-out per subtask) → TEST (join, deterministic) → REVIEW (independent) → [PATCH → TEST → REVIEW]* → HUMAN GATE.
 * ponytail: template planner; swap in an LLM planner behind the same interface once the template is the bottleneck.
 */
export class DeterministicPlanner implements Planner {
  plan(task: Task, workflowId: string): Graph {
    const files = task.context_files ?? [];
    const testCmd = task.test_command ?? "npm test";
    const nodes: GraphNode[] = [];
    const perNode: Partial<GraphNode> = { budget: { max_usd: task.budget.max_usd ? +(task.budget.max_usd / 6).toFixed(2) : undefined, max_seconds: 900 } };

    nodes.push(node({
      node_id: "plan", objective: `Produce an implementation plan for: ${task.objective}`, node_type: "plan",
      required_capabilities: ["architecture", "typescript", "task_decomposition"],
      required_context: [{ kind: "task" }, { kind: "hsc", kinds: ["constraint", "decision", "fact"] }, { kind: "files", paths: files, max_tokens: 8000 }],
      allowed_tools: READ_TOOLS, complexity: "medium", reasoning: "high", ...perNode,
    }));

    const implIds: string[] = [];
    const units = task.subtasks?.length ? task.subtasks : [{ id: "main", objective: task.objective, context_files: files }];
    for (const u of units) {
      const id = units.length > 1 ? `implement:${u.id}` : "implement";
      implIds.push(id);
      nodes.push(node({
        node_id: id, objective: u.objective, node_type: "implement", dependencies: ["plan"],
        required_capabilities: ["typescript", "implementation", "test_generation"],
        required_context: [{ kind: "task" }, { kind: "hsc", kinds: ["constraint", "decision", "artifact"] }, { kind: "node_output", node_id: "plan" }, { kind: "files", paths: u.context_files ?? files, max_tokens: 8000 }],
        allowed_tools: IMPL_TOOLS, complexity: "high", reasoning: "high", parallel_group: units.length > 1 ? "implement" : undefined,
        acceptance_criteria: task.acceptance_criteria.filter((a) => a.type === "file_exists"), ...perNode,
      }));
    }

    nodes.push(node({
      node_id: "test", objective: `Run ${testCmd}`, node_type: "test", dependencies: implIds, deterministic: true, command: testCmd,
      required_context: [], allowed_tools: ["Bash"], complexity: "low", reasoning: "low", retry_policy: { max_retries: 0, on_exhausted: "fail" },
    }));

    nodes.push(reviewNode("review", task, ["test"], implIds, 1));
    nodes.push(node({
      node_id: "human_gate", objective: "Human approval of the reviewed change", node_type: "human_gate", dependencies: ["review"],
      deterministic: true, required_context: [], allowed_tools: [], complexity: "low", reasoning: "low",
      retry_policy: { max_retries: 0, on_exhausted: "fail" },
    }));
    return { graph_id: `g-${workflowId}`, workflow_id: workflowId, version: 1, nodes, replans: [] };
  }

  expandLoop(graph: Graph, review: GraphNode, task: Task): GraphNode[] {
    const it = review.iteration + 1;
    const max = review.loop_policy?.max_iterations ?? 0;
    if (review.iteration - 1 >= max) return []; // iteration k means k-1 loops already run
    const testCmd = task.test_command ?? "npm test";
    const patch = node({
      node_id: `patch#${it}`, objective: `Address review findings and test failures from ${review.node_id}`, node_type: "patch",
      dependencies: [review.node_id], required_capabilities: ["typescript", "debugging", "implementation"],
      required_context: [{ kind: "task" }, { kind: "hsc", kinds: ["constraint", "decision"] }, { kind: "node_output", node_id: review.node_id, full: true }, { kind: "node_output", node_id: review.dependencies[0] }],
      allowed_tools: IMPL_TOOLS, complexity: "high", reasoning: "high", iteration: it, budget: review.budget,
    });
    const test = node({ node_id: `test#${it}`, objective: `Run ${testCmd}`, node_type: "test", dependencies: [patch.node_id], deterministic: true, command: testCmd, required_context: [], allowed_tools: ["Bash"], complexity: "low", reasoning: "low", iteration: it, retry_policy: { max_retries: 0, on_exhausted: "fail" } });
    const rev = reviewNode(`review#${it}`, task, [test.node_id], [patch.node_id], it, review.loop_policy?.max_iterations);
    // the human gate now waits for the newest review
    const gate = graph.nodes.find((n) => n.node_type === "human_gate");
    if (gate) gate.dependencies = [rev.node_id];
    graph.nodes.push(patch, test, rev);
    graph.version++;
    graph.replans.push({ at: new Date().toISOString(), reason: `review ${review.node_id} failed`, node_id: review.node_id, action: `expand loop iteration ${it}: ${patch.node_id} → ${test.node_id} → ${rev.node_id}` });
    return [patch, test, rev];
  }

  replan(graph: Graph, failed: GraphNode, evidence: string): string[] {
    if (graph.replans.filter((r) => r.action.startsWith("replan")).length >= 2) return [];
    const diag = node({
      node_id: `diagnose:${failed.node_id}`, objective: `Diagnose why "${failed.objective}" failed and state the smallest fix`, node_type: "diagnose",
      dependencies: failed.dependencies, required_capabilities: ["debugging", "typescript"],
      required_context: [{ kind: "task" }, { kind: "hsc", kinds: ["constraint", "decision"] }, { kind: "history", query: `${failed.node_id} failure ${evidence.slice(0, 80)}`, limit: 2 }],
      allowed_tools: READ_TOOLS, complexity: "medium", reasoning: "high", retry_policy: { max_retries: 0, on_exhausted: "fail" },
    });
    const retry = node({ ...failed, node_id: `${failed.node_id}#r`, dependencies: [diag.node_id], status: "pending", attempts: 0, outputs: undefined, failure_reason: undefined,
      required_context: [...failed.required_context, { kind: "node_output", node_id: diag.node_id }], retry_policy: { max_retries: 0, on_exhausted: "fail" }, state_changes: [] });
    for (const n of graph.nodes) n.dependencies = n.dependencies.map((d) => (d === failed.node_id ? retry.node_id : d));
    graph.nodes.push(diag, retry);
    graph.version++;
    graph.replans.push({ at: new Date().toISOString(), reason: evidence.slice(0, 200), node_id: failed.node_id, action: `replan: insert ${diag.node_id} then ${retry.node_id}` });
    return [diag.node_id, retry.node_id];
  }
}

function reviewNode(id: string, task: Task, deps: string[], implIds: string[], iteration: number, maxIter?: number): GraphNode {
  const manual: AcceptanceCheck[] = task.acceptance_criteria;
  return node({
    node_id: id, objective: "Independently review the change against the acceptance criteria and test results", node_type: "review",
    dependencies: deps, required_capabilities: ["code_review", "typescript", "adversarial_reasoning"],
    required_context: [{ kind: "task" }, { kind: "hsc", kinds: ["constraint", "decision", "assumption"] }, { kind: "node_output", node_id: deps[0] }, ...implIds.map((i) => ({ kind: "node_output" as const, node_id: i }))],
    allowed_tools: READ_TOOLS, complexity: "medium", reasoning: "high", acceptance_criteria: manual, iteration,
    loop_policy: { on_fail_expand: ["patch", "test", "review"] as NodeType[], max_iterations: maxIter ?? task.max_review_iterations ?? 2 },
    retry_policy: { max_retries: 1, on_exhausted: "fail" },
  });
}
