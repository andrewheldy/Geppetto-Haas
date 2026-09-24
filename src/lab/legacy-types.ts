export type OrchestrationMode = "static" | "jit";

export interface Budget {
  maxUsd?: number;
  maxTokens?: number;
  maxSeconds?: number;
}

export interface TaskSpec {
  id: string;
  objective: string;
  constraints?: string[];
  successCriteria?: string[];
  budget?: Budget;
}

export interface HSCContext {
  facts: Array<Record<string, unknown>>;
  constraints: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  resources: Array<Record<string, unknown>>;
  permissions: Array<Record<string, unknown>>;
  provenance: Array<Record<string, unknown>>;
}

export interface PlanNode {
  id: string;
  objective: string;
  capabilities: string[];
  requiredTools?: string[];
  verification?: boolean;
  dependencies?: string[];
  parallelizable?: boolean;
}

export interface PlanGraph {
  taskId: string;
  nodes: PlanNode[];
}

export interface AgentManifest {
  id: string;
  objective: string;
  capabilities: string[];
  tools: { allow: string[]; deny?: string[] };
  skills?: string[];
  promptModules?: string[];
  contextScope: string[];
  modelPolicy?: {
    class?: string;
    effort?: "low" | "medium" | "high";
  };
  lifecycle: "ephemeral" | "cached-pattern" | "registered";
  outputContract: Record<string, unknown>;
}

export type Topology =
  | "single"
  | "parallel-synthesize"
  | "builder-reviewer"
  | "supervisor-workers";

export interface HarnessManifest {
  id: string;
  topology: Topology;
  agents: AgentManifest[];
  executionOrder?: string[];
  maxRepairLoops?: number;
  memoryPolicy?: "none" | "task" | "experience-read" | "experience-write";
  failurePolicy?: Record<string, unknown>;
  budget?: Budget;
}

export interface ExecutionTrace {
  runId: string;
  runtime: string;
  startedAt: string;
  completedAt?: string;
  events: Array<Record<string, unknown>>;
  metrics: {
    modelCalls?: number;
    toolCalls?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    wallClockMs?: number;
  };
  finalResult?: unknown;
}

export interface EvaluationResult {
  runId: string;
  scores: {
    correctness?: number;
    completeness?: number;
    evidenceQuality?: number;
    constraintAdherence?: number;
    evaluatorConfidence?: number;
  };
  efficiency: Record<string, number>;
  failureRecovery?: Record<string, unknown>;
  promotionCandidates?: Array<Record<string, unknown>>;
}

export interface RuntimeAdapter {
  execute(harness: HarnessManifest, task: TaskSpec, context: HSCContext): Promise<ExecutionTrace>;
}
