// Routing policy: model aliases → validated ids, the tier ladder, and per-kind defaults.
// Versions live here and in a project's policy file, nowhere else.
import type { FailureKind, Level, TaskKind } from "./types.ts";

export interface ModelSpec {
  /** Full model id, e.g. claude-sonnet-5-5. */
  id: string;
  /** Position on the capability ladder; higher is stronger. */
  rank: number;
  /** USD per million tokens [input, output]; used only for the classifier's cost gate. */
  price: [number, number];
  /** True for a tier the policy may route to only when `authorized` names it. */
  requiresAuthorization?: boolean;
}

export interface KindPolicy {
  tier: string;
  maxTurns: number;
  /** False keeps the task with the current agent. */
  delegate: boolean;
  /** Narrower agent type to select when the caller named none (and it is available and read-only). */
  preferAgent?: string;
  /** Rough tokens a subagent of this kind spends; feeds the classifier's expected-value gate. */
  expectedTokens: number;
}

export interface Policy {
  version: string;
  models: Record<string, ModelSpec>;
  /** Aliases explicitly authorized beyond the default ladder (e.g. "fable"). */
  authorized: string[];
  kinds: Record<TaskKind, KindPolicy>;
  /** Highest tier escalation may reach without authorization. */
  maxTier: string;
  /** Failure kinds that count as evidence a stronger model would help. */
  escalateOn: FailureKind[];
  /** Below this classification confidence the decision is `native`. */
  minConfidence: number;
  /** In route mode, refuse a confident trivial delegation so the current agent does it inline. */
  denyTrivialDelegation: boolean;
  /** Haiku is for bounded tasks: longer prompts than this route one tier up. */
  boundedTaskChars: number;
  /**
   * Under-powering costs more than over-paying, so the cheapest tier needs a clear win: at least this confidence and
   * no competing kind scoring above `maxCompetingScore`. Otherwise the task routes one tier up.
   */
  cheapTierGuard: { minConfidence: number; maxCompetingScore: number };
  /** High risk never routes below this tier. */
  highRiskMinTier: string;
  maxContextRefs: number;
  classifier: {
    enabled: boolean;
    /** Alias the classifier runs on. */
    model: string;
    /** Rules at or above this confidence never call the classifier. */
    callBelowConfidence: number;
    /** Tasks shorter than this never call the classifier. */
    minChars: number;
    /** Estimated USD per classifier call (input + output). */
    costUsd: number;
  };
}

export const DEFAULT_POLICY: Policy = {
  version: "geppetto-routing/1",
  models: {
    haiku: { id: "claude-haiku-5-5", rank: 1, price: [1, 5] },
    sonnet: { id: "claude-sonnet-5-5", rank: 2, price: [2, 10] },
    opus: { id: "claude-opus-5-5", rank: 3, price: [5, 25] },
    fable: { id: "claude-fable-5-1", rank: 4, price: [10, 50], requiresAuthorization: true },
  },
  authorized: [],
  kinds: {
    trivial: { tier: "haiku", maxTurns: 3, delegate: false, expectedTokens: 5_000 },
    explore: { tier: "haiku", maxTurns: 15, delegate: true, preferAgent: "Explore", expectedTokens: 40_000 },
    test: { tier: "sonnet", maxTurns: 25, delegate: true, expectedTokens: 80_000 },
    implement: { tier: "sonnet", maxTurns: 30, delegate: true, expectedTokens: 120_000 },
    review: { tier: "sonnet", maxTurns: 20, delegate: true, expectedTokens: 80_000 },
    debug: { tier: "sonnet", maxTurns: 30, delegate: true, expectedTokens: 120_000 },
    architecture: { tier: "opus", maxTurns: 40, delegate: true, expectedTokens: 150_000 },
    unknown: { tier: "sonnet", maxTurns: 30, delegate: true, expectedTokens: 80_000 },
  },
  maxTier: "opus",
  escalateOn: ["capability", "test_failure", "budget_exhausted"],
  minConfidence: 0.6,
  denyTrivialDelegation: true,
  boundedTaskChars: 4_000,
  cheapTierGuard: { minConfidence: 0.8, maxCompetingScore: 1 },
  highRiskMinTier: "sonnet",
  maxContextRefs: 8,
  classifier: { enabled: false, model: "haiku", callBelowConfidence: 0.6, minChars: 200, costUsd: 0.002 },
};

const MODEL_ID = /^claude-[a-z]+(-[0-9]+)+(-[0-9]{8})?$/;
const ALIAS = /^[a-z][a-z0-9-]{0,31}$/;
const LEVELS: readonly Level[] = ["low", "medium", "high"];

export class PolicyError extends Error {}

/** Merge a partial policy (parsed JSON) over the defaults and validate the result. Throws PolicyError with every problem. */
export function resolvePolicy(raw: unknown, base: Policy = DEFAULT_POLICY): Policy {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return base;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new PolicyError("policy must be a JSON object");
  const r = raw as Record<string, unknown>;
  const known = new Set(Object.keys(base));
  for (const k of Object.keys(r)) if (!known.has(k)) problems.push(`unknown key "${k}"`);

  const models: Record<string, ModelSpec> = { ...base.models };
  if (r.models !== undefined) {
    if (!isObj(r.models)) problems.push("models must be an object");
    else for (const [alias, spec] of Object.entries(r.models)) {
      if (!ALIAS.test(alias)) { problems.push(`models: bad alias "${alias}"`); continue; }
      if (spec === null) { delete models[alias]; continue; }
      if (!isObj(spec)) { problems.push(`models.${alias} must be an object`); continue; }
      models[alias] = { ...models[alias], ...(spec as Partial<ModelSpec>) } as ModelSpec;
    }
  }
  for (const [alias, m] of Object.entries(models)) {
    if (typeof m.id !== "string" || !MODEL_ID.test(m.id)) problems.push(`models.${alias}.id "${String(m.id)}" is not a model id like claude-sonnet-5-5`);
    if (typeof m.rank !== "number" || !Number.isFinite(m.rank)) problems.push(`models.${alias}.rank must be a number`);
    if (!Array.isArray(m.price) || m.price.length !== 2 || !m.price.every((p) => typeof p === "number" && p >= 0)) problems.push(`models.${alias}.price must be [input, output]`);
  }

  const kinds = { ...base.kinds };
  if (r.kinds !== undefined) {
    if (!isObj(r.kinds)) problems.push("kinds must be an object");
    else for (const [k, v] of Object.entries(r.kinds)) {
      if (!(k in base.kinds)) { problems.push(`kinds: unknown kind "${k}"`); continue; }
      if (!isObj(v)) { problems.push(`kinds.${k} must be an object`); continue; }
      kinds[k as TaskKind] = { ...base.kinds[k as TaskKind], ...(v as Partial<KindPolicy>) };
    }
  }
  for (const [k, v] of Object.entries(kinds)) {
    if (!(v.tier in models)) problems.push(`kinds.${k}.tier "${v.tier}" is not a model alias`);
    if (!Number.isInteger(v.maxTurns) || v.maxTurns < 1) problems.push(`kinds.${k}.maxTurns must be a positive integer`);
  }

  const out: Policy = {
    ...base, ...(r as Partial<Policy>), models, kinds,
    classifier: { ...base.classifier, ...(isObj(r.classifier) ? (r.classifier as Partial<Policy["classifier"]>) : {}) },
    cheapTierGuard: { ...base.cheapTierGuard, ...(isObj(r.cheapTierGuard) ? (r.cheapTierGuard as Partial<Policy["cheapTierGuard"]>) : {}) },
  };
  if (typeof out.version !== "string") problems.push("version must be a string");
  if (!Array.isArray(out.authorized) || !out.authorized.every((a) => typeof a === "string" && a in models)) problems.push("authorized must list model aliases");
  for (const key of ["maxTier", "highRiskMinTier"] as const) if (!(out[key] in models)) problems.push(`${key} "${out[key]}" is not a model alias`);
  if (!(out.classifier.model in models)) problems.push(`classifier.model "${out.classifier.model}" is not a model alias`);
  if (!(out.minConfidence >= 0 && out.minConfidence <= 1)) problems.push("minConfidence must be within 0..1");
  if (!Array.isArray(out.escalateOn)) problems.push("escalateOn must be a list");
  if (problems.length) throw new PolicyError(problems.join("; "));
  return out;
}

/** Aliases a decision may pick: authorization-gated tiers only when authorized. Ordered weakest first. */
export function ladder(policy: Policy, available?: readonly string[]): string[] {
  return Object.entries(policy.models)
    .filter(([a, m]) => (!m.requiresAuthorization || policy.authorized.includes(a)) && (!available || available.includes(a)))
    .sort((x, y) => x[1].rank - y[1].rank)
    .map(([a]) => a);
}

/** Alias for a model name given as alias or full id; undefined when the policy doesn't know it. */
export function aliasOf(policy: Policy, model: string): string | undefined {
  if (model in policy.models) return model;
  const hit = Object.entries(policy.models).find(([, m]) => m.id === model || model.startsWith(`${m.id}-`) || model.startsWith(`${m.id}[`));
  if (hit) return hit[0];
  // Family match for ids of another version (claude-opus-4-7 → opus): ladder position only, never used as an id.
  const fam = /^claude-([a-z]+)-/.exec(model)?.[1];
  return fam && fam in policy.models ? fam : undefined;
}

export function rankOf(policy: Policy, model: string): number | undefined {
  const a = aliasOf(policy, model);
  return a === undefined ? undefined : policy.models[a]?.rank;
}

export function isLevel(x: unknown): x is Level { return typeof x === "string" && (LEVELS as readonly string[]).includes(x); }
function isObj(x: unknown): x is Record<string, unknown> { return typeof x === "object" && x !== null && !Array.isArray(x); }
