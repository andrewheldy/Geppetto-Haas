import type { AcceptanceCheck, AgentDefinition, CapabilitySpec, GraphNode, ModelRoute, Task } from "./types.ts";

const ROLE: Record<string, string> = {
  plan: "Planning Architect", implement: "Implementation Engineer", patch: "Fix Engineer", review: "Independent Reviewer",
  diagnose: "Failure Analyst", research: "Researcher", synthesize: "Synthesizer", decide: "Decision Analyst", generic: "Specialist",
};

const CAPS: Record<string, string[]> = {
  plan: ["architecture", "task_decomposition"], implement: ["implementation", "test_generation"], patch: ["debugging", "implementation"],
  review: ["code_review", "adversarial_reasoning"], diagnose: ["debugging", "root_cause_analysis"],
};

/** Capability analysis: what the node needs the agent to be, independent of any predefined persona. */
export function analyzeCapabilities(node: GraphNode, task: Task): CapabilitySpec {
  const caps = new Set<string>([...(CAPS[node.node_type] ?? []), ...node.required_capabilities]);
  if (task.kind === "software_build") caps.add("typescript");
  return {
    required_capabilities: [...caps], task_complexity: node.complexity, reasoning_requirement: node.reasoning,
    tools: node.allowed_tools,
    context_scope: node.required_context.map((r) => r.kind === "files" ? `files:${r.paths.length}` : r.kind === "node_output" ? `output:${r.node_id}` : r.kind === "hsc" ? `hsc:${(r.kinds ?? ["all"]).join("+")}` : r.kind),
    needs_independence: node.node_type === "review",
  };
}

// ---- Prompt modules (modular composition; no giant hand-maintained prompt per agent) ----
const MODULES: Record<string, string> = {
  core: `You are an ephemeral specialist inside Geppetto, a governed agent harness. You receive a deliberately compiled context packet, not the project history. Work only from the packet, the files you read, and the tools you are allowed. Do not ask the user questions; there is no user. Be concise.`,
  rehydration: `If information you need is missing from the packet and cannot be found by reading files, do not guess: set "need_context" in your final JSON to short queries describing what is missing, leave the rest empty, and stop. The harness will retrieve it and re-run you.`,
  state: `Report state explicitly in the final JSON: decisions you made (durable), assumptions (may go stale), open questions, files changed. Nothing you report becomes canonical until validated.`,
  role_plan: `Produce a short implementation plan: files to create/modify, interfaces, test approach, risks. Read files as needed. Do not modify files.`,
  role_implement: `Implement the objective in the working directory. Write tests alongside behavior. Run the test command before finishing. Keep the diff minimal; do not refactor unrelated code. Do not commit.`,
  role_patch: `Fix exactly the findings and failures listed. Re-run the tests. Do not widen scope.`,
  role_review: `You did not write this code. Review the diff and test results adversarially against the acceptance criteria. Verdict "fail" if tests fail, any acceptance criterion is unmet, or there is a correctness bug. Cite file paths. Do not modify files.`,
  role_diagnose: `Explain the most likely root cause of the failure and the smallest change that would fix it. Do not modify files.`,
  output_json: `End with your final answer as JSON matching the provided schema.`,
};

export function resolvePrompt(node: GraphNode, spec: CapabilitySpec): { system: string; modules: string[] } {
  const modules = ["core", `role_${node.node_type}` in MODULES ? `role_${node.node_type}` : "", "state", "rehydration", "output_json"].filter(Boolean);
  const system = modules.map((m) => MODULES[m]).join("\n\n") + `\n\nRole: ${ROLE[node.node_type] ?? ROLE.generic}. Capabilities expected: ${spec.required_capabilities.join(", ")}.`;
  return { system, modules };
}

/** Least privilege: review/plan/diagnose never get write tools even if the node lists them. */
export function resolveTools(node: GraphNode): string[] {
  const readOnly = ["plan", "review", "diagnose", "research", "decide", "synthesize"].includes(node.node_type);
  return readOnly ? node.allowed_tools.filter((t) => !/Edit|Write|Bash|NotebookEdit/.test(t)) : node.allowed_tools;
}

export const AGENT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "What was done / concluded, 2-6 sentences" },
    verdict: { type: "string", enum: ["pass", "fail", "n/a"] },
    findings: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } },
    files_changed: { type: "array", items: { type: "string" } },
    need_context: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "verdict", "findings", "decisions", "assumptions", "questions", "files_changed", "need_context"],
  additionalProperties: false,
};

let agentSeq = 0;
export function resetAgentSeq(): void { agentSeq = 0; }

/** Agent = Role + Objective + Context + Prompt + Tools + Model + Budget + Authority + Acceptance Criteria. Ephemeral by default. */
export function createAgent(node: GraphNode, spec: CapabilitySpec, route: ModelRoute, criteria: AcceptanceCheck[]): AgentDefinition {
  const tools = resolveTools(node);
  const { system, modules } = resolvePrompt(node, spec);
  const role = ROLE[node.node_type] ?? ROLE.generic;
  return {
    agent_id: `${role.toLowerCase().replace(/\s+/g, "-")}-${String(++agentSeq).padStart(2, "0")}`,
    role, objective: node.objective, node_id: node.node_id, system_prompt: system, prompt_modules: modules, tools, model: route,
    budget: node.budget, authority: tools.includes("Bash") ? "write+shell" : tools.some((t) => /Edit|Write/.test(t)) ? "write" : "read",
    acceptance_criteria: criteria, lifecycle: "ephemeral", capabilities: spec,
  };
}
