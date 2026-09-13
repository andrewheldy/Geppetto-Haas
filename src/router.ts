import type { CapabilitySpec, GraphNode, Level, ModelRoute } from "./types.ts";

export interface Router { route(node: GraphNode, spec: CapabilitySpec, attempt: number): ModelRoute; }

export const TIERS = ["haiku", "sonnet", "opus"] as const;
export type Tier = (typeof TIERS)[number];

/** Deterministic router. Every decision carries its reasons. ponytail: rules table, no learned routing until traces justify it. */
export class DeterministicRouter implements Router {
  readonly overrides: Partial<Record<Tier, string>>;
  readonly cap?: Tier;
  constructor(opts: { overrides?: Partial<Record<Tier, string>>; cap?: Tier } = {}) {
    this.overrides = opts.overrides ?? {}; this.cap = opts.cap;
  }

  route(node: GraphNode, spec: CapabilitySpec, attempt: number): ModelRoute {
    const reasons: string[] = [];
    let tier: Tier = "sonnet";
    if (spec.task_complexity === "high" || spec.reasoning_requirement === "high") { tier = "opus"; reasons.push(`complexity=${spec.task_complexity}, reasoning=${spec.reasoning_requirement} → strongest tier`); }
    else if (spec.task_complexity === "low" && spec.reasoning_requirement === "low") { tier = "haiku"; reasons.push("low complexity and reasoning → cheapest tier"); }
    else reasons.push("medium complexity → mid tier");
    if (node.node_type === "review" && tier === "haiku") { tier = "sonnet"; reasons.push("independent review needs at least mid tier"); }
    if (attempt > 0) { const i = Math.min(TIERS.length - 1, TIERS.indexOf(tier) + 1); if (TIERS[i] !== tier) { tier = TIERS[i]; reasons.push(`retry attempt ${attempt} → escalate one tier`); } else reasons.push(`retry attempt ${attempt} → already at strongest tier, cannot escalate; failure context injected instead`); }
    if (node.budget.max_usd !== undefined && node.budget.max_usd < 0.05 && tier === "opus") { tier = "sonnet"; reasons.push(`node budget $${node.budget.max_usd} too small for opus`); }
    if (this.cap && TIERS.indexOf(tier) > TIERS.indexOf(this.cap)) { reasons.push(`capped to ${this.cap} by run configuration`); tier = this.cap; }
    const effort: Level = spec.reasoning_requirement;
    const model = this.overrides[tier] ?? tier;
    return { model, effort, candidates: [...TIERS], reasons, attempt };
  }
}
