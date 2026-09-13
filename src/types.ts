// Geppetto core contracts. Zero runtime dependencies. Runtime-specific types never appear here.

export type ExecutionMode = "governed" | "control";
export type Governance = "bootstrap" | "partial" | "full";

export interface Budget {
  max_usd?: number;
  max_tokens?: number;
  max_seconds?: number;
  max_retries?: number;
  max_iterations?: number;
}

export type AcceptanceCheck =
  | { type: "command"; cmd: string; description?: string }
  | { type: "file_exists"; path: string; description?: string }
  | { type: "file_contains"; path: string; pattern: string; description?: string }
  | { type: "manual"; description: string };

export interface Task {
  id: string;
  objective: string;
  kind: "software_build" | "generic";
  constraints: string[];
  acceptance_criteria: AcceptanceCheck[];
  /** Files the work is expected to touch or read. Used as file-scope hints by the context compiler. */
  context_files?: string[];
  /** Independent work units. If >1, the planner fans them out in parallel and joins. */
  subtasks?: Array<{ id: string; objective: string; context_files?: string[] }>;
  /** Directory (relative to repo) that is copied into each mode's workspace. Defaults to the repo root. */
  workspace_source?: string;
  test_command?: string;
  budget: Budget;
  /** Runtime knobs for a review loop. */
  max_review_iterations?: number;
}

// ---------- HSC (L1) ----------
export type StateStatus =
  | "candidate" | "accepted" | "active" | "tentative" | "unverified" | "contested"
  | "stale" | "superseded" | "rejected" | "quarantined" | "archived";
export type StateKind =
  | "objective" | "constraint" | "decision" | "assumption" | "hypothesis" | "question"
  | "dependency" | "artifact" | "completed_action" | "next_action" | "evidence" | "fact" | "observation";
export type TtlClass = "durable" | "session" | "volatile";

export interface Provenance {
  producer: string;            // agent_id | "user" | "system" | "planner"
  node_id?: string;
  workflow_id: string;
  evidence_refs: string[];     // history record ids
  created_at: string;
  updated_at: string;
  produced_at_node_index: number;
}

export interface HSCEntry {
  id: string;
  kind: StateKind;
  /** Optional normalized key; two active entries with the same key but different content are a conflict. */
  key?: string;
  content: string;
  status: StateStatus;
  confidence: number;          // 0..1
  ttl: TtlClass;
  tags: string[];
  provenance: Provenance;
  supersedes?: string;
  superseded_by?: string;
  status_reason?: string;
}

export interface HSCState {
  workflow_id: string;
  version: number;
  objective: string;
  entries: HSCEntry[];
}

export interface HSCDelta {
  adds: HSCEntry[];
  updates: Array<{ id: string; patch: Partial<HSCEntry>; reason: string }>;
  tokens: number;
}

// ---------- Graph ----------
export type NodeType =
  | "plan" | "implement" | "test" | "review" | "patch" | "synthesize" | "decide"
  | "human_gate" | "research" | "diagnose" | "generic";
export type NodeStatus = "pending" | "ready" | "running" | "succeeded" | "failed" | "skipped" | "blocked" | "replaced";
export type Level = "low" | "medium" | "high";

export type ContextRequirement =
  | { kind: "task" }
  | { kind: "hsc"; kinds?: StateKind[]; tags?: string[]; max_tokens?: number }
  | { kind: "files"; paths: string[]; max_tokens?: number }
  | { kind: "node_output"; node_id: string; full?: boolean }
  | { kind: "history"; query: string; limit?: number };

export interface RetryPolicy { max_retries: number; on_exhausted: "replan" | "escalate" | "fail"; }
export interface LoopPolicy {
  /** When this node's evaluation fails, expand these node types (in order) and loop back. */
  on_fail_expand: NodeType[];
  max_iterations: number;
}
export interface Condition {
  /** Skip this node unless outputs[node_id].verdict/field equals value. */
  node_id: string; field: string; equals: string;
}

export interface NodeOutput {
  text: string;                 // raw agent output (also stored in L2)
  summary: string;              // compacted representation used for handoff
  structured?: Record<string, unknown>;
  history_ref: string;          // L2 record id of raw output
  verdict?: "pass" | "fail";
  files_changed?: string[];
}

export interface GraphNode {
  node_id: string;
  objective: string;
  node_type: NodeType;
  dependencies: string[];
  required_capabilities: string[];
  required_context: ContextRequirement[];
  allowed_tools: string[];
  acceptance_criteria: AcceptanceCheck[];
  budget: Budget;
  status: NodeStatus;
  assigned_agent?: string;
  inputs: Record<string, unknown>;
  outputs?: NodeOutput;
  state_changes: string[];      // HSC entry ids produced/affected
  retry_policy: RetryPolicy;
  loop_policy?: LoopPolicy;
  condition?: Condition;
  complexity: Level;
  reasoning: Level;
  /** True when the node runs deterministically (no model call), e.g. a test command. */
  deterministic?: boolean;
  command?: string;
  attempts: number;
  iteration: number;
  parallel_group?: string;
  failure_reason?: string;
  execution_order?: number;
}

export interface Graph {
  graph_id: string;
  workflow_id: string;
  version: number;
  nodes: GraphNode[];
  replans: Array<{ at: string; reason: string; node_id: string; action: string }>;
}

// ---------- Agent / Routing ----------
export interface CapabilitySpec {
  required_capabilities: string[];
  task_complexity: Level;
  reasoning_requirement: Level;
  tools: string[];
  context_scope: string[];
  needs_independence: boolean;  // must not be the author of the artifact it judges
}

export interface ModelRoute {
  model: string;                // provider-neutral alias or id
  effort: Level;
  candidates: string[];
  reasons: string[];
  attempt: number;
}

export interface AgentDefinition {
  agent_id: string;
  role: string;
  objective: string;
  node_id: string;
  system_prompt: string;
  prompt_modules: string[];
  tools: string[];
  model: ModelRoute;
  budget: Budget;
  authority: "read" | "write" | "write+shell";
  acceptance_criteria: AcceptanceCheck[];
  lifecycle: "ephemeral" | "cached-pattern" | "registered";
  capabilities: CapabilitySpec;
}

// ---------- Context (L0) ----------
export interface ContextSection {
  name: string;
  source: "task" | "hsc" | "file" | "node_output" | "history" | "handoff" | "rehydration";
  tokens: number;
  text: string;
  provenance: string[];
}

export interface ContextPacket {
  node_id: string;
  sections: ContextSection[];
  text: string;
  tokens: number;
  available_tokens: number;     // everything the governor could have injected
  hsc_tokens: number;
  file_tokens: number;
  node_output_tokens: number;
  retrieved_tokens: number;
  discarded_tokens: number;     // available - injected (context avoided)
  discarded_items: number;
}

export interface HandoffPacket {
  objective: string;
  current_status: string;
  accepted_decisions: string[];
  relevant_constraints: string[];
  required_inputs: string[];
  previous_outputs: string[];
  active_hypotheses: string[];
  unresolved_questions: string[];
  evidence_refs: string[];
  artifact_refs: string[];
  allowed_tools: string[];
  authority: string;
  acceptance_criteria: string[];
  budget: Budget;
  warnings: string[];
}

// ---------- Runtime ----------
export interface TokenUsage {
  input: number; output: number; cache_read: number; cache_write: number; total: number;
  /** true when numbers are heuristic estimates rather than provider-reported */
  estimated: boolean;
}

export interface InvocationRequest {
  invocation_id: string;
  agent_id: string;
  node_id: string;
  model: string;
  effort: Level;
  system_prompt: string;
  prompt: string;
  tools: string[];
  cwd: string;
  max_turns: number;
  max_usd?: number;
  /** control mode: continue an existing session so context accumulates */
  session_id?: string;
  resume?: boolean;
  json_schema?: Record<string, unknown>;
}

export interface InvocationResult {
  invocation_id: string;
  output_text: string;
  structured?: Record<string, unknown>;
  usage: TokenUsage;
  /** per API round-trip usage when the runtime exposes it; lets us compute peak active context */
  iterations: TokenUsage[];
  cost_usd: number;
  cost_estimated: boolean;
  duration_ms: number;
  model: string;
  session_id?: string;
  num_turns: number;
  error?: string;
}

export interface CommandResult { cmd: string; exit_code: number; stdout: string; stderr: string; duration_ms: number; }

export interface RuntimeAdapter {
  readonly name: string;
  invoke(req: InvocationRequest): Promise<InvocationResult>;
  runCommand(cmd: string, cwd: string, timeoutMs?: number): Promise<CommandResult>;
}

// ---------- Telemetry ----------
export interface TraceEvent {
  ts: string;
  seq: number;
  type: string;
  experiment_id?: string;
  workflow_id: string;
  mode: ExecutionMode;
  graph_id?: string;
  node_id?: string;
  agent_id?: string;
  invocation_id?: string;
  data: Record<string, unknown>;
}

export interface ContextLedgerEntry {
  workflow_id: string;
  mode: ExecutionMode;
  node_id: string;
  agent_id: string;
  invocation_id: string;
  model: string;
  phase: string;                // node_type or control turn label
  available_context_tokens: number;
  compiled_context_tokens: number;
  hsc_tokens: number;
  retrieved_tokens: number;
  file_tokens: number;
  tool_tokens: number;          // tool-result context consumed inside the invocation (estimated)
  prompt_overhead_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  active_context_tokens: number; // input + cache_read + cache_write at the largest API iteration
  compacted_tokens_removed: number;
  discarded_tokens: number;
  retrievals: number;
  compactions: number;
  hsc_delta_tokens: number;
  estimated_cost_usd: number;
  cost_estimated: boolean;
  tokens_estimated: boolean;
  duration_ms: number;
  attempt: number;
  ts: string;
}

// ---------- Evaluation ----------
export interface CriterionResult { criterion: string; passed: boolean; detail?: string; }
export interface EvaluationResult {
  workflow_id: string;
  mode: ExecutionMode;
  criteria: CriterionResult[];
  criteria_passed: number;
  criteria_total: number;
  tests_passed?: number;
  tests_failed?: number;
  errors: string[];
  review_findings: number;
  retries: number;
  blind_review?: { score: number; findings: string[]; model: string; label: string };
  human_approval?: boolean;
}

export interface WorkflowSummary {
  workflow_id: string;
  mode: ExecutionMode;
  governance: Governance;
  task_id: string;
  runtime: string;
  status: "completed" | "failed" | "budget_exceeded";
  lifecycle_input_tokens: number;
  lifecycle_output_tokens: number;
  lifecycle_cache_read_tokens: number;
  lifecycle_cache_write_tokens: number;
  total_model_tokens: number;
  peak_active_context: number;
  avg_active_context: number;
  cumulative_context_injected: number;
  cumulative_context_avoided: number;
  hsc_overhead_tokens: number;
  retrieval_overhead_tokens: number;
  compaction_overhead_tokens: number;
  estimated_cost_usd: number;
  cost_estimated: boolean;
  elapsed_ms: number;
  agent_calls: number;
  graph_nodes: number;
  loops: number;
  retries: number;
  retrievals: number;
  compactions: number;
  replans: number;
  evaluation?: EvaluationResult;
}
