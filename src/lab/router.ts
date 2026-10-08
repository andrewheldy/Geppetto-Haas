import type { CapabilitySpec, GraphNode, Level, ModelRoute } from "./types.ts";
import { escalateTier, tierForLevels } from "../../plugins/geppetto/core/index.ts";

export interface Router { route(node: GraphNode, spec: CapabilitySpec, attempt: number): ModelRoute; }

export const TIERS = ["haiku", "sonnet", "opus"] as const;
export type Tier = (typeof TIERS)[number];

/** Deterministic router. Every decision carries its reasons. The tier ladder is the shared routing core's (plugins/geppetto/core). */
export class DeterministicRouter implements Router {
  readonly overrides: Partial<Record<Tier, string>>;
  readonly cap?: Tier;
  constructor(opts: { overrides?: Partial<Record<Tier, string>>; cap?: Tier } = {}) {
    this.overrides = opts.overrides ?? {}; this.cap = opts.cap;
  }

  route(node: GraphNode, spec: CapabilitySpec, attempt: number): ModelRoute {
    const reasons: string[] = [];
    const base = tierForLevels(TIERS, spec.task_complexity, spec.reasoning_requirement);
    let tier = base.tier as Tier;
    reasons.push(base.reason);
    if (node.node_type === "review" && tier === "haiku") { tier = "sonnet"; reasons.push("independent review needs at least mid tier"); }
    if (attempt > 0) {
      const up = escalateTier(TIERS, tier) as Tier | undefined;
      if (up) { tier = up; reasons.push(`retry attempt ${attempt} → escalate one tier`); }
      else reasons.push(`retry attempt ${attempt} → already at strongest tier, cannot escalate; failure context injected instead`);
    }
    if (node.budget.max_usd !== undefined && node.budget.max_usd < 0.05 && tier === "opus") { tier = "sonnet"; reasons.push(`node budget $${node.budget.max_usd} too small for opus`); }
    if (this.cap && TIERS.indexOf(tier) > TIERS.indexOf(this.cap)) { reasons.push(`capped to ${this.cap} by run configuration`); tier = this.cap; }
    const effort: Level = spec.reasoning_requirement;
    const model = this.overrides[tier] ?? tier;
    return { model, effort, candidates: [...TIERS], reasons, attempt };
  }
}
