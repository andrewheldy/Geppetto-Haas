// Geppetto for Claude Code: routes native subagent spawns through the shared routing core.
// It never runs an agent itself: it only rewrites the `model` (and narrows `subagentType`) of a spawn the engine is
// already making, and only when the caller made no explicit choice. Any failure passes the spawn through unchanged.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { DecisionRecord, GeppettoMode } from '../types'
import {
  DEFAULT_POLICY, parseAgentDefinition, resolvePolicy, routeWithClassifier, toAttempt,
  type AgentOption, type Classifier, type FailedAttempt, type Policy, type RoutingDecision,
} from '../core/index.ts'

const decisions = atom({ plugin: 'geppetto', key: 'decisions' } as const, [] as DecisionRecord[])
const seq = atom({ plugin: 'geppetto', key: 'seq' } as const, 0)
const modeOverride = atom({ plugin: 'geppetto', key: 'mode' } as const, null as GeppettoMode | null)
const KEEP = 50
const NATIVE_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'] // the Agent tool's `model` enum in 2.1.294

// Built-in agent types. In Claude Code 2.1.294 all three inherit the parent's model (measured; see docs/ROUTING.md),
// so routing may set one. Any agent not listed here or in an agents/*.md file is left alone.
const BUILTIN_AGENTS: AgentOption[] = [
  { id: 'general-purpose' },
  { id: 'Plan', readOnly: true },
  { id: 'Explore', readOnly: true },
]

type $T = EngineInterface
type Explicit = { agent?: string; model?: string }

// Module state: a reload starts it over and session.start rebuilds it. What must survive a reload lives in $.state.
const S = {
  options: {} as PluginOptions,
  policy: DEFAULT_POLICY as Policy,
  policyStatus: 'default policy',
  agents: BUILTIN_AGENTS,
  userDefaultModel: undefined as string | undefined,
  envMode: undefined as GeppettoMode | undefined,
  decisionsFile: undefined as string | undefined,                                       // GEPPETTO_DECISIONS_FILE: audit copy of the records
  explicit: new Map<string, Explicit>(),                                                // tool_use_id → what the Agent call spelled out
  budgets: new Map<string, { max: number; used: number; seq: number; hit: boolean }>(), // agentId → tool-call budget
}

function configured(): GeppettoMode { return S.envMode ?? (S.options.mode as GeppettoMode | undefined) ?? 'observe' }
async function modeOf($: $T): Promise<GeppettoMode> { return (await read($, modeOverride)) ?? configured() }

export const register: Register = (on, options) => {
  S.options = options

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'geppetto', description: 'Geppetto routing: status, explain [n], mode off|observe|route, policy', argumentHint: '[explain [n] | mode <m> | policy]' })
    const m = await $.env.get('GEPPETTO_MODE')
    S.envMode = m === 'off' || m === 'observe' || m === 'route' ? m : undefined
    S.decisionsFile = (await $.env.get('GEPPETTO_DECISIONS_FILE')) || undefined
    S.userDefaultModel = (await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL')) || undefined
    const loaded = await loadPolicy($, String(options.policyPath ?? '.claude/geppetto.policy.json'), options.classifier === true)
    S.policy = loaded.policy
    S.policyStatus = loaded.policyStatus
    S.agents = [...BUILTIN_AGENTS, ...(await loadAgents($))]
    return next(e)
  })

  // Record what the model's Agent call spelled out, before the engine resolves defaults. Never changes the call.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    S.explicit.set(e.tool_use_id, { agent: e.subagent_type, model: e.model })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const mode = await modeOf($)
    if (mode === 'off') return next(e)
    const asked = S.explicit.get(e.tool_use_id) ?? { agent: e.subagentType, model: e.model } // no record (a plugin's spawn): treat as explicit
    S.explicit.delete(e.tool_use_id)
    const unsupported = e.workflow ? 'workflow agent: content is not rewritable' : e.fork ? 'fork inherits the parent model' : e.isTeammate ? 'teammate' : undefined
    const attempts = await priorFailures($, e.description, e.prompt)
    const d = await routeWithClassifier({
      task: e.prompt, description: e.description, currentAgent: e.parentAgentId ?? 'main',
      requestedAgent: asked.agent, resolvedAgent: e.subagentType, requestedModel: e.model ?? asked.model,
      userDefaultModel: S.userDefaultModel, availableAgents: S.agents, unsupported, attempts,
    }, S.policy, S.policy.classifier.enabled ? haikuClassifier($, S.policy) : undefined)

    const applied: DecisionRecord['applied'] = {}
    let rec = await record($, mode, e.tool_use_id, e.description, e.prompt, asked, e.subagentType, d, applied)

    if (mode === 'route' && d.action === 'route') {
      if (!d.delegate && S.policy.denyTrivialDelegation && d.classification.confidence >= 0.8 && !asked.agent) {
        const why = `Geppetto: this looks like a trivial task (${d.reason}). Do it directly instead of delegating. If delegation is intended, call Agent again with an explicit subagent_type or model.`
        await patch($, rec.seq, { applied: { denied: why } })
        return { deny: why }
      }
      // Claude Code resolves its own aliases; a policy's custom alias is passed as the full id it names.
      const model = d.apply.model && (options.modelParam !== 'id' && d.alias && NATIVE_ALIASES.includes(d.alias) ? d.alias : d.apply.model)
      Object.assign(applied, model ? { model } : {}, d.apply.agent ? { agent: d.apply.agent } : {})
      const r = await next({ ...e, ...(model ? { model } : {}), ...(d.apply.agent ? { subagentType: d.apply.agent } : {}) })
      rec = await patch($, rec.seq, { applied, agentId: r.agentId, spawnedModel: r.model })
      if (r.agentId && options.enforceBudget === true) S.budgets.set(r.agentId, { max: d.maxTurns, used: 0, seq: rec.seq, hit: false })
      if (r.deny === undefined && r.agentId) $.ui.status(`geppetto: ${e.description.slice(0, 30)} → ${applied.model ?? r.model}`)
      return r
    }
    const r = await next(e)
    await patch($, rec.seq, { agentId: r.agentId, spawnedModel: r.model })
    return r
  }).catch(async ($, e, next) => {
    // Fail open: whatever went wrong, the spawn proceeds as Claude Code would have made it.
    if (!next.called) { try { await record($, 'observe', e.tool_use_id, e.description, e.prompt, {}, e.subagentType, undefined, {}) } catch { /* nothing to do */ } }
    return next(e)
  })

  // Optional, opt-in: a routed subagent past its budget is told to stop and report. Only ever more restrictive.
  on('tool.call', async ($, e, next) => {
    const b = e.agentId ? S.budgets.get(e.agentId) : undefined
    if (!b) return next(e)
    b.used++
    if (b.used > b.max) {
      b.hit = true
      return { deny: `Geppetto: this subagent's budget of ${b.max} tool calls is spent. Stop now and report what you found and what remains.` }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const list = await read($, decisions)
      const rec = list.find((r) => r.agentId === e.agentId)
      if (rec) {
        const b = S.budgets.get(e.agentId)
        const failure = toAttempt(rec.spawnedModel ?? rec.model, rec.agent, { reason: e.reason, answer: e.answer, budgetExhausted: b?.hit })
        await patch($, rec.seq, {
          observedModel: e.usage?.model,
          outcome: { reason: e.reason, failure: failure?.kind, evidence: failure?.evidence, toolCalls: b?.used },
        })
        S.budgets.delete(e.agentId)
      }
    }
    return next(e)
  })

  on('command.run', { command: 'geppetto' }, async ($, e) => {
    const [verb = 'status', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const list = await read($, decisions)
    if (verb === 'mode') {
      const m = rest[0]
      if (m !== 'off' && m !== 'observe' && m !== 'route') return { text: `Usage: /geppetto mode off|observe|route (now ${await modeOf($)})` }
      await update($, modeOverride, () => m)
      return { text: `Geppetto mode for this session: ${m}.${m === 'route' ? ' Subagent spawns without an explicit model will be routed.' : ''}` }
    }
    if (verb === 'policy') return { text: `Policy (${S.policyStatus}):\n${JSON.stringify(S.policy, null, 2)}` }
    if (verb === 'explain') {
      const n = rest[0] ? Number(rest[0]) : undefined
      const rec = n === undefined ? list[list.length - 1] : list.find((r) => r.seq === n)
      if (!rec) return { text: list.length ? `No decision #${rest[0]}. Known: ${list.map((r) => r.seq).join(', ')}` : 'No routing decisions yet this session.' }
      return { text: explain(rec) }
    }
    return { text: await status($, list) }
  })

}

async function status($: $T, list: DecisionRecord[]): Promise<string> {
  const mode = await modeOf($)
  const routed = list.filter((r) => r.applied.model || r.applied.agent)
  const byModel = new Map<string, number>()
  for (const r of list) { const m = r.observedModel ?? r.spawnedModel; if (m) byModel.set(m, (byModel.get(m) ?? 0) + 1) }
  const mismatch = list.filter((r) => r.applied.model && r.observedModel && !matches(r, r.observedModel))
  const lines = [
    `Geppetto ${mode}${mode === configured() ? '' : ` (configured: ${configured()})`} · ${S.policyStatus} · ${S.policy.version}`,
    `Classifier: ${S.policy.classifier.enabled ? `on (${S.policy.classifier.model}, low effort)` : 'off'} · budgets: ${S.options.enforceBudget === true ? 'enforced' : 'advisory'} · model param: ${S.options.modelParam ?? 'alias'}`,
    S.userDefaultModel ? `User default subagent model ${S.userDefaultModel}: respected, never overridden.` : '',
    `Decisions: ${list.length} · routed: ${routed.length} · kept explicit/pinned: ${list.filter((r) => r.action === 'keep').length} · native: ${list.filter((r) => r.action === 'native' || r.action === 'error').length}`,
    byModel.size ? `Subagents ran on: ${[...byModel].map(([m, c]) => `${m} ×${c}`).join(', ')}` : '',
    mismatch.length ? `⚠ ${mismatch.length} routed spawn(s) ran on a model other than the policy's: ${mismatch.map((r) => `#${r.seq}`).join(', ')}` : '',
    ...list.slice(-8).map((r) => `  #${r.seq} ${r.action}${r.applied.denied ? ' (denied: inline)' : ''} ${r.kind}/${r.complexity} → ${r.applied.agent ?? r.resolvedAgent} on ${r.observedModel ?? r.spawnedModel ?? r.applied.model ?? '(native)'}${r.mode === 'observe' && r.action === 'route' ? ` (would: ${r.agent} on ${r.alias})` : ''}${r.outcome?.failure ? ` · failed: ${r.outcome.failure}` : ''} · ${r.description}`),
    list.length ? 'Run /geppetto explain <n> for a decision\'s full trace.' : 'No subagent spawns yet this session.',
  ]
  return lines.filter(Boolean).join('\n')
}

async function priorFailures($: $T, description: string, prompt: string): Promise<FailedAttempt[]> {
  const list = await read($, decisions)
  return list
    .filter((r) => r.outcome?.failure && (r.description === description || similar(r.taskPreview, prompt.slice(0, 400)) >= 0.6))
    .map((r) => ({ model: r.observedModel ?? r.spawnedModel ?? r.model, agent: r.agent, kind: r.outcome!.failure as FailedAttempt['kind'], evidence: r.outcome!.evidence }))
}

async function record($: $T, mode: GeppettoMode, toolUseId: string, description: string, prompt: string, requested: Explicit, resolvedAgent: string, d: (RoutingDecision & { classifierCalled: boolean }) | undefined, applied: DecisionRecord['applied']): Promise<DecisionRecord> {
  const n = await update($, seq, (x) => x + 1)
  const rec: DecisionRecord = {
    seq: n, at: new Date().toISOString(), mode, toolUseId, description, taskPreview: prompt.slice(0, 400),
    requested: strip(requested), resolvedAgent,
    action: d?.action ?? 'error', delegate: d?.delegate ?? true, agent: d?.agent ?? resolvedAgent, model: d?.model ?? 'inherit', alias: d?.alias,
    kind: d?.classification.kind ?? 'unknown', complexity: d?.classification.complexity ?? 'medium', confidence: d?.classification.confidence ?? 0,
    source: d?.classification.source ?? 'none', reason: d?.reason ?? 'routing failed; native behavior kept', maxTurns: d?.maxTurns ?? 0,
    contextRefs: d?.contextRefs ?? [], fallback: d ? `${d.fallback.strategy}${d.fallback.to ? ` → ${d.fallback.to}` : ''} (${d.fallback.when})` : 'native',
    trace: d?.trace ?? [], classifierCalled: d?.classifierCalled ?? false, applied,
  }
  await audit($, await update($, decisions, (list) => [...list, rec].slice(-KEEP)))
  return rec
}

async function patch($: $T, n: number, fields: Partial<DecisionRecord>): Promise<DecisionRecord> {
  let out: DecisionRecord | undefined
  const list = await update($, decisions, (l) => l.map((r) => (r.seq === n ? (out = { ...r, ...strip(fields) }) : r)))
  await audit($, list)
  return out!
}

/** Optional audit copy of the session's decisions (GEPPETTO_DECISIONS_FILE). Best effort: never blocks routing. */
async function audit($: $T, list: DecisionRecord[]): Promise<void> {
  if (!S.decisionsFile) return
  try { await $.fs.write(S.decisionsFile, JSON.stringify(list, null, 2)) } catch { /* audit is best effort */ }
}

function matches(r: DecisionRecord, observed: string): boolean {
  const want = r.alias ? S.policy.models[r.alias]?.id : r.model
  return !want || observed === want || observed.startsWith(`${want}-`) || observed.startsWith(`${want}[`)
}

/** Optional classifier: one low-effort completion on the session's own client, compact schema-validated JSON back. */
function haikuClassifier($: $T, policy: Policy): Classifier {
  return {
    name: `model.complete:${policy.classifier.model}`,
    async classify(task, rules) {
      const r = await $.model.complete({
        model: policy.classifier.model,
        effort: 'low',
        maxTokens: 120,
        timeoutMs: 8000,
        system: 'Classify a software task delegated to a coding subagent. Reply with one JSON object and nothing else: {"kind":"trivial|explore|test|implement|review|debug|architecture|unknown","complexity":"low|medium|high","confidence":0..1}',
        prompt: `Rules guessed ${rules.kind} at ${rules.confidence}.\nTask:\n${task.slice(0, 4000)}`,
      })
      if (!r.isAnswered) throw new Error(`classifier ${r.reason}`)
      return r.text
    },
  }
}

async function loadPolicy($: $T, path: string, classifier: boolean): Promise<{ policy: Policy; policyStatus: string }> {
  const withFlag = (p: Policy) => (classifier && !p.classifier.enabled ? { ...p, classifier: { ...p.classifier, enabled: true } } : p)
  try {
    if (!(await $.fs.exists(path))) return { policy: withFlag(DEFAULT_POLICY), policyStatus: 'default policy' }
    return { policy: withFlag(resolvePolicy(JSON.parse(await $.fs.read(path)))), policyStatus: `policy ${path}` }
  } catch (err) {
    $.ui.toast(`geppetto: ${path} rejected, using the default policy: ${String(err).slice(0, 160)}`)
    return { policy: withFlag(DEFAULT_POLICY), policyStatus: `default policy (${path} invalid: ${String(err).slice(0, 120)})` }
  }
}

/** Project and user agent definitions, so a definition that pins its model is never overridden. */
async function loadAgents($: $T): Promise<AgentOption[]> {
  const home = await $.env.get('HOME')
  const out: AgentOption[] = []
  for (const dir of ['.claude/agents', ...(home ? [`${home}/.claude/agents`] : [])]) {
    try {
      if (!(await $.fs.exists(dir))) continue
      for (const f of await $.fs.list(dir)) {
        if (f.kind !== 'file' || !f.name.endsWith('.md')) continue
        const def = parseAgentDefinition(await $.fs.read(`${dir}/${f.name}`), f.name.replace(/\.md$/, ''))
        if (!out.some((a) => a.id === def.id)) out.push(def)
      }
    } catch { /* unreadable agents dir: those agents stay unknown, so they are never routed */ }
  }
  return out
}

function explain(r: DecisionRecord): string {
  return [
    `Decision #${r.seq} · ${r.at} · mode ${r.mode}`,
    `Task: ${r.description} — ${r.taskPreview.slice(0, 160).replace(/\s+/g, ' ')}${r.taskPreview.length > 160 ? '…' : ''}`,
    `Requested: agent ${r.requested.agent ?? '(default)'}, model ${r.requested.model ?? '(none)'} · engine resolved agent ${r.resolvedAgent}`,
    `Classification: ${r.kind} / ${r.complexity} complexity, confidence ${r.confidence} (${r.source})${r.classifierCalled ? ', classifier called' : ''}`,
    `Decision: ${r.action} · delegate ${r.delegate} · agent ${r.agent} · model ${r.model}${r.alias ? ` (${r.alias})` : ''} · maxTurns ${r.maxTurns}`,
    `Reason: ${r.reason}`,
    `Applied: ${r.applied.denied ? `denied — ${r.applied.denied}` : Object.keys(r.applied).length ? JSON.stringify(r.applied) : r.mode === 'observe' && r.action === 'route' ? 'nothing (observe mode: this is what route mode would set)' : 'nothing'}`,
    `Spawned: ${r.agentId ?? '-'} on ${r.spawnedModel ?? '-'} · ran on ${r.observedModel ?? '(not finished)'}${r.outcome ? ` · ended ${r.outcome.reason}${r.outcome.failure ? `, failure ${r.outcome.failure}: ${r.outcome.evidence}` : ''}` : ''}`,
    `Fallback: ${r.fallback}`,
    `Context refs: ${r.contextRefs.join(', ') || '(none)'}`,
    'Trace:', ...r.trace.map((t) => `  - ${t}`),
  ].join('\n')
}

function similar(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])
  const x = words(a), y = words(b)
  if (!x.size || !y.size) return 0
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / (x.size + y.size - both)
}

function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}
