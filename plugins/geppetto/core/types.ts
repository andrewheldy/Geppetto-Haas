// Geppetto routing core: contracts. Pure TypeScript, zero dependencies, no Node and no Claude Code types,
// so any runtime (Claude Code mod, the Geppetto lab orchestrator, AscensionOS) can call it.

export type Level = "low" | "medium" | "high";

/** What a task is, as far as routing cares. `unknown` routes nothing: the runtime keeps its native behavior. */
export type TaskKind = "trivial" | "explore" | "test" | "implement" | "review" | "debug" | "architecture" | "unknown";
export const TASK_KINDS: readonly TaskKind[] = ["trivial", "explore", "test", "implement", "review", "debug", "architecture", "unknown"];

/** Why an earlier attempt failed. Only some kinds are evidence that a stronger model would help. */
export type FailureKind =
  | "capability"        // the agent ran and reported it could not do the task
  | "test_failure"      // the agent finished but its checks failed
  | "budget_exhausted"  // the agent ran out of its turn budget
  | "interrupted"       // the user or host stopped it
  | "refusal"           // the model refused
  | "infra"             // API error, rate limit, context limit, network
  | "permission"        // a tool call was denied
  | "unknown";

export interface FailedAttempt {
  /** Model alias or id the attempt ran on. */
  model: string;
  agent?: string;
  kind: FailureKind;
  /** What shows the failure (an error line, a failing test name). An attempt without evidence never escalates. */
  evidence?: string;
}

export interface AgentOption {
  id: string;
  /** The agent definition's own model: an alias, an id, `inherit`, or undefined (the runtime default). Anything else is a pin. */
  model?: string;
  /** True when the agent cannot write (Explore-like). Routing only ever narrows to such an agent, never widens away from one. */
  readOnly?: boolean;
}

export interface RoutingInput {
  /** The task as the delegating agent wrote it (prompt). */
  task: string;
  /** Short label of the task, if any (the Agent tool's `description`). */
  description?: string;
  /** Caller-known complexity; skips that part of classification. */
  complexity?: Level;
  /** Required capabilities the caller already knows ("debugging", "architecture", ...). */
  capabilities?: string[];
  /** Who is delegating ("main" or an agent id). */
  currentAgent?: string;
  /** Agent type the caller asked for explicitly. Undefined means the runtime's default. */
  requestedAgent?: string;
  /** Agent type the runtime resolved to (default or explicit). */
  resolvedAgent?: string;
  /** Model the caller asked for explicitly. Never overridden. */
  requestedModel?: string;
  /** A user-level default subagent model (e.g. CLAUDE_CODE_SUBAGENT_MODEL). Never overridden. */
  userDefaultModel?: string;
  availableAgents?: AgentOption[];
  /** Aliases the runtime accepts. Defaults to every alias in the policy. */
  availableModels?: string[];
  context?: { tokensUsed?: number; tokenBudget?: number };
  risk?: Level;
  /** Prior failed attempts at this same task, most recent last. */
  attempts?: FailedAttempt[];
  /** Runtime facts that make routing unsupported (forks inherit the parent; teammates and workflow agents are pinned). */
  unsupported?: string;
}

export interface Classification {
  kind: TaskKind;
  complexity: Level;
  capabilities: string[];
  /** 0..1. Below the policy's routing threshold the decision is `native`. */
  confidence: number;
  signals: string[];
  /** Rule score per kind (rules only); lets routing see how close a competing kind came. */
  scores?: Partial<Record<TaskKind, number>>;
  source: "caller" | "rules" | "classifier";
}

export interface Fallback {
  /** escalate: retry one tier up on failure evidence; native: runtime default; none: already at the top. */
  strategy: "escalate" | "native" | "none";
  to?: string;
  when: string;
}

/**
 * route: apply `apply` (model and/or agent); keep: an explicit or pinned choice stands, change nothing;
 * native: no opinion (unsupported, ambiguous, or routing failed), change nothing.
 */
export type RoutingAction = "route" | "keep" | "native";

export interface RoutingDecision {
  action: RoutingAction;
  /** False when the task should stay with the current agent rather than a subagent. */
  delegate: boolean;
  /** Selected agent identifier. */
  agent: string;
  /** Selected model id (validated against the policy), or the kept/native model as known. */
  model: string;
  /** The policy alias of `model`, when it is one. */
  alias?: string;
  /** One-line explanation. */
  reason: string;
  maxTurns: number;
  contextRefs: string[];
  fallback: Fallback;
  /** Exactly what a runtime should change. Empty means change nothing. */
  apply: { model?: string; agent?: string };
  classification: Classification;
  /** Every rule that fired, in order. */
  trace: string[];
  policyVersion: string;
}

/** Optional model-backed classifier, used only for ambiguous tasks and only when its expected value beats its cost. */
export interface Classifier {
  readonly name: string;
  classify(task: string, rules: Classification): Promise<unknown>;
}
