// The routing engine: RoutingInput + Policy → RoutingDecision. Deterministic; the optional classifier is consulted
// only for ambiguous tasks and only when its expected value beats its cost.
import { classifyTask } from "./classify.ts";
import { extractContextRefs } from "./context.ts";
import { aliasOf, ladder, rankOf, type Policy } from "./policy.ts";
import { TASK_KINDS, type Classification, type Classifier, type Fallback, type Level, type RoutingDecision, type RoutingInput, type TaskKind } from "./types.ts";

const BUMP_ON_HIGH: readonly TaskKind[] = ["implement", "debug", "review", "test"];

export interface RouteOptions {
  /** Classification decided elsewhere (the model-backed classifier). */
  classification?: Classification;
  /** Trace lines from before routing (the classifier gate). */
  preTrace?: string[];
}

export function route(input: RoutingInput, policy: Policy, opts: RouteOptions = {}): RoutingDecision {
  const trace = [...(opts.preTrace ?? [])];
  const cls = mergeCaller(opts.classification ?? classifyTask(input.task, input.description), input, trace);
  const kp = policy.kinds[cls.kind];
  const contextRefs = extractContextRefs(`${input.description ?? ""}\n${input.task}`, policy.maxContextRefs);
  const agent = input.resolvedAgent ?? input.requestedAgent ?? "default";
  const lad = ladder(policy, input.availableModels);
  const base = { delegate: kp.delegate, agent, maxTurns: kp.maxTurns, contextRefs, classification: cls, trace, policyVersion: policy.version };
  const leave = (action: "keep" | "native", model: string, reason: string, fallback: Fallback): RoutingDecision => {
    trace.push(reason);
    return { ...base, action, delegate: action === "keep" ? true : base.delegate, model: idOf(policy, model), alias: aliasOf(policy, model), reason, fallback, apply: {} };
  };
  const native: Fallback = { strategy: "native", when: "runtime default applies" };

  // 1. Hard limits: things routing must never touch.
  if (input.unsupported) return leave("native", input.requestedModel ?? "inherit", `routing unsupported here (${input.unsupported}); native behavior kept`, native);
  if (input.requestedModel) return leave("keep", input.requestedModel, `explicit model "${input.requestedModel}" respected`, native);
  if (input.userDefaultModel) return leave("keep", input.userDefaultModel, `user default subagent model "${input.userDefaultModel}" respected`, native);
  const def = input.availableAgents?.find((a) => a.id === agent);
  if (input.availableAgents && !def && agent !== "default") return leave("native", "inherit", `agent "${agent}" is not in the known agent list (its definition may pin a model); native behavior kept`, native);
  const pinned = def?.model && def.model !== "inherit" ? def.model : undefined;
  if (pinned) return leave("keep", pinned, `agent "${agent}" pins model "${pinned}" in its definition`, native);
  if (cls.kind === "unknown" || cls.confidence < policy.minConfidence) {
    return leave("native", "inherit", `classification ${cls.kind} at confidence ${cls.confidence} is below ${policy.minConfidence}; native behavior kept`, native);
  }
  if (lad.length === 0) return leave("native", "inherit", "no model in the policy is available to this runtime", native);

  // 2. Pick the tier.
  let tier = kp.tier;
  trace.push(`${cls.kind} → ${tier} (policy default)`);
  const at = (a: string) => policy.models[a]?.rank ?? 0;
  const above = (a: string) => lad.find((x) => at(x) > at(a));
  if (cls.complexity === "high" && BUMP_ON_HIGH.includes(cls.kind)) {
    const up = above(tier); if (up) { tier = up; trace.push(`high complexity ${cls.kind} → ${tier}`); }
  }
  if (tier === lad[0] && cls.kind !== "trivial") {
    const g = policy.cheapTierGuard;
    const rival = Object.entries(cls.scores ?? {}).filter(([k, v]) => k !== cls.kind && (v ?? 0) > g.maxCompetingScore).map(([k]) => k);
    const up = above(tier);
    if (up && (cls.confidence < g.minConfidence || rival.length)) {
      tier = up; trace.push(`cheapest tier needs a clear win (confidence ${cls.confidence}${rival.length ? `, competing: ${rival.join(",")}` : ""}) → ${tier}`);
    }
  }
  if (tier === lad[0] && (input.task.length > policy.boundedTaskChars || contextRefs.length >= policy.maxContextRefs)) {
    const up = above(tier); if (up) { tier = up; trace.push(`task not bounded (${input.task.length} chars, ${contextRefs.length} refs) → ${tier}`); }
  }
  if (input.risk === "high" && at(tier) < at(policy.highRiskMinTier)) { tier = policy.highRiskMinTier; trace.push(`high risk → at least ${tier}`); }

  // 3. Escalate only on evidence.
  const evidenced = (input.attempts ?? []).filter((a) => {
    const ok = policy.escalateOn.includes(a.kind) && !!a.evidence?.trim();
    if (!ok) trace.push(`attempt on ${a.model} (${a.kind}) ignored: ${a.evidence?.trim() ? "failure kind is not evidence a stronger model helps" : "no evidence"}`);
    return ok;
  });
  if (evidenced.length) {
    const failedRank = Math.max(...evidenced.map((a) => rankOf(policy, a.model) ?? at(tier)));
    const up = lad.find((x) => at(x) > failedRank);
    if (up && at(up) > at(tier)) { tier = up; trace.push(`escalated to ${tier}: ${evidenced.length} failed attempt(s) with evidence, last: ${clip(evidenced[evidenced.length - 1]!.evidence!)}`); }
    else if (!up) {
      // Never retry below the tier that already failed.
      const same = [...lad].reverse().find((x) => at(x) <= failedRank);
      if (same && at(same) > at(tier)) tier = same;
      trace.push(`failed attempt(s) already at the strongest permitted tier; staying on ${tier}, no escalation`);
    }
  }

  // 4. Cap: never above maxTier unless that tier is explicitly authorized.
  const cap = at(policy.maxTier);
  if (at(tier) > cap && !policy.authorized.includes(tier)) { tier = policy.maxTier; trace.push(`capped at ${tier}`); }
  if (!lad.includes(tier)) {
    const alt = lad.filter((x) => at(x) >= at(tier))[0] ?? lad[lad.length - 1]!;
    trace.push(`${tier} unavailable here → ${alt}`); tier = alt;
  }

  // 5. Agent: narrow to a read-only agent for exploration when the caller named none. Never widen.
  const apply: RoutingDecision["apply"] = { model: policy.models[tier]!.id };
  let chosenAgent = agent;
  const prefer = kp.preferAgent ? input.availableAgents?.find((a) => a.id === kp.preferAgent) : undefined;
  if (prefer?.readOnly && !input.requestedAgent && !def?.readOnly && prefer.id !== agent) {
    chosenAgent = prefer.id; apply.agent = prefer.id; trace.push(`no agent requested; read-only ${prefer.id} selected for ${cls.kind}`);
    if (prefer.model && prefer.model !== "inherit") { delete apply.model; trace.push(`${prefer.id} pins model "${prefer.model}"; model left to it`); }
  }
  if (!kp.delegate) trace.push(`${cls.kind} task: better kept with ${input.currentAgent ?? "the current agent"}`);

  const next = above(tier);
  const fallback: Fallback = next && (at(next) <= cap || policy.authorized.includes(next))
    ? { strategy: "escalate", to: next, when: `failure evidence of kind ${policy.escalateOn.join("|")}` }
    : { strategy: "none", when: "already at the strongest permitted tier" };
  const model = apply.model ?? idOf(policy, prefer?.model ?? tier);
  const reason = `${cls.kind}/${cls.complexity} (confidence ${cls.confidence}, ${cls.source}) → ${chosenAgent === agent ? "" : `${chosenAgent} on `}${tier}${trace.some((t) => t.startsWith("escalated")) ? " (escalated on evidence)" : ""}${kp.delegate ? "" : "; keep inline"}`;
  return { ...base, action: "route", agent: chosenAgent, model, alias: aliasOf(policy, model), reason, fallback, apply };
}

/** Decide whether the model-backed classifier is worth calling for this task. */
export function shouldClassify(rules: Classification, input: RoutingInput, policy: Policy, classifier?: Classifier): { call: boolean; why: string } {
  const c = policy.classifier;
  if (!c.enabled || !classifier) return { call: false, why: "classifier off" };
  if (input.requestedModel || input.userDefaultModel || input.unsupported) return { call: false, why: "classifier skipped: decision does not depend on classification" };
  if (rules.confidence >= c.callBelowConfidence) return { call: false, why: `classifier skipped: rules confident (${rules.confidence})` };
  if (input.task.length < c.minChars) return { call: false, why: `classifier skipped: task under ${c.minChars} chars` };
  const lad = ladder(policy, input.availableModels);
  const blended = (a: string) => { const p = policy.models[a]!.price; return 0.9 * p[0] + 0.1 * p[1]; };
  const spread = lad.length > 1 ? blended(lad[lad.length - 1]!) - blended(lad[0]!) : 0;
  const ev = (1 - rules.confidence) * spread * policy.kinds[rules.kind].expectedTokens / 1e6;
  if (ev <= c.costUsd) return { call: false, why: `classifier skipped: expected value $${ev.toFixed(4)} ≤ cost $${c.costUsd}` };
  return { call: true, why: `classifier called: rules confidence ${rules.confidence}, expected value $${ev.toFixed(4)} > cost $${c.costUsd}` };
}

/** Route, consulting the classifier only when `shouldClassify` says so. Classifier failure falls back to the rules. */
export async function routeWithClassifier(input: RoutingInput, policy: Policy, classifier?: Classifier): Promise<RoutingDecision & { classifierCalled: boolean }> {
  const rules = mergeCaller(classifyTask(input.task, input.description), input, []);
  const gate = shouldClassify(rules, input, policy, classifier);
  const preTrace = [gate.why];
  let classification: Classification | undefined;
  if (gate.call && classifier) {
    try {
      const parsed = parseClassification(await classifier.classify(input.task, rules));
      if (typeof parsed === "string") preTrace.push(`classifier answer rejected (${parsed}); rules used`);
      else { classification = { ...parsed, signals: [...rules.signals, `classifier:${classifier.name}`] }; preTrace.push(`classifier → ${parsed.kind}/${parsed.complexity} at ${parsed.confidence}`); }
    } catch (err) { preTrace.push(`classifier failed (${clip(String(err))}); rules used`); }
  }
  return { ...route(input, policy, { classification: classification ?? rules, preTrace }), classifierCalled: gate.call };
}

/** Validate a classifier answer (object or JSON text). Returns the classification or a reason it was rejected. */
export function parseClassification(raw: unknown): Classification | string {
  let v = raw;
  if (typeof v === "string") {
    const m = /\{[\s\S]*\}/.exec(v);
    if (!m) return "no JSON object";
    try { v = JSON.parse(m[0]); } catch { return "invalid JSON"; }
  }
  if (typeof v !== "object" || v === null) return "not an object";
  const o = v as Record<string, unknown>;
  if (!TASK_KINDS.includes(o.kind as TaskKind)) return `kind "${String(o.kind)}" unknown`;
  if (!["low", "medium", "high"].includes(o.complexity as string)) return `complexity "${String(o.complexity)}" invalid`;
  if (typeof o.confidence !== "number" || o.confidence < 0 || o.confidence > 1) return "confidence must be 0..1";
  const caps = Array.isArray(o.capabilities) ? o.capabilities.filter((c): c is string => typeof c === "string").slice(0, 8) : [];
  return { kind: o.kind as TaskKind, complexity: o.complexity as Level, capabilities: caps, confidence: o.confidence, signals: [], source: "classifier" };
}

// ---- Tier-ladder helpers shared with the lab orchestrator's router ----

/** Complexity × reasoning → ladder position: both low → weakest, either high → strongest, else middle. */
export function tierForLevels(lad: readonly string[], complexity: Level, reasoning: Level): { tier: string; reason: string } {
  if (complexity === "high" || reasoning === "high") return { tier: lad[lad.length - 1]!, reason: `complexity=${complexity}, reasoning=${reasoning} → strongest tier` };
  if (complexity === "low" && reasoning === "low") return { tier: lad[0]!, reason: "low complexity and reasoning → cheapest tier" };
  return { tier: lad[Math.ceil((lad.length - 1) / 2)]!, reason: "medium complexity → mid tier" };
}

/** One tier up the ladder, or undefined at the top. */
export function escalateTier(lad: readonly string[], tier: string): string | undefined {
  const i = lad.indexOf(tier);
  return i >= 0 && i < lad.length - 1 ? lad[i + 1] : undefined;
}

function mergeCaller(cls: Classification, input: RoutingInput, trace: string[]): Classification {
  let out = cls;
  if (input.complexity && input.complexity !== cls.complexity) { out = { ...out, complexity: input.complexity }; trace.push(`complexity ${input.complexity} from caller`); }
  if (input.capabilities?.length) out = { ...out, capabilities: [...new Set([...out.capabilities, ...input.capabilities])] };
  return out;
}

function idOf(policy: Policy, model: string): string {
  return policy.models[model]?.id ?? model;
}

function clip(s: string, n = 120): string { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
