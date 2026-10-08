// Integration tests under `claude plugin test plugins/geppetto`: the engine's own dispatcher runs Geppetto's hooks;
// the hooks registered here sit beneath them and stand for Claude Code, so they see exactly what Geppetto passes down.
import { describe, expect, test } from 'claude-code/testing'
import type { AgentSpawnArgs, AgentSpawnInput, CommandRunInput, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const EXPLORE = 'Find every place in the codebase where the ledger is written to and report file paths with line numbers.'
const IMPLEMENT = 'Implement a --json flag for the status command in src/status.ts that prints the same information as JSON.'
const ARCHITECTURE = 'Design the architecture for multi-agent handoff across organizations: trust model and the trade-offs of push vs pull.'
const TRIVIAL = 'Fix the typo in README.md: recieve should be receive.'

/** Stand in for the engine beneath Geppetto: record each spawn as it arrives and answer like Claude Code would. */
function engine(on: On) {
  const spawns: { model?: string; subagentType: string; prompt: string }[] = []
  let n = 0
  on('agent.spawn', ($, e) => {
    spawns.push({ model: e.model, subagentType: e.subagentType, prompt: e.prompt })
    return { model: e.model ?? 'claude-sonnet-5-5', agentId: `agent-${++n}` }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return spawns
}

// The kit fills the engine-stamped fields (tool_use_id, origin, ...), as a session does.
const spawn = ($: Engine, prompt: string, extra: Partial<AgentSpawnArgs> = {}) =>
  $.agent.spawn({ prompt, description: prompt.slice(0, 24), subagentType: 'general-purpose', ...extra } as AgentSpawnInput)
const geppetto = async ($: Engine, args = '') => (await $.command.run({ command: 'geppetto', args } as CommandRunInput)).text ?? ''

describe('observe mode (the default)', () => {
  test('records what it would do and changes nothing', async ($, on) => {
    const spawns = engine(on)
    await spawn($, EXPLORE)
    expect(spawns[0]?.model).toBe(undefined)
    const out = { text: await geppetto($, 'explain') }
    expect(out.text).toContain('observe mode: this is what route mode would set')
    expect(out.text).toContain('claude-haiku-5-5')
  })
})

describe('route mode', () => {
  const route = { options: { mode: 'route' } }

  test('2. simple exploration routes to Haiku', route, async ($, on) => {
    const spawns = engine(on)
    await spawn($, EXPLORE)
    expect(spawns[0]?.model).toBe('haiku')
  })

  test('3. normal implementation routes to Sonnet', route, async ($, on) => {
    const spawns = engine(on)
    await spawn($, IMPLEMENT)
    expect(spawns[0]?.model).toBe('sonnet')
  })

  test('4. complex architecture routes to Opus', route, async ($, on) => {
    const spawns = engine(on)
    await spawn($, ARCHITECTURE)
    expect(spawns[0]?.model).toBe('opus')
  })

  test('model ids instead of aliases when configured', { options: { mode: 'route', modelParam: 'id' } }, async ($, on) => {
    const spawns = engine(on)
    await spawn($, IMPLEMENT)
    expect(spawns[0]?.model).toBe('claude-sonnet-5-5')
  })

  test('1. a trivial task is judged better kept inline; a spawn whose agent was explicit still goes through', route, async ($, on) => {
    // A spawn that reaches Geppetto without the model's Agent tool call before it (here: the kit's $.agent.spawn) counts as an
    // explicit choice, so it is never refused. The refusal of a model's own trivial Agent call is checked end to end against a
    // real session (docs/ROUTING.md, "End-to-end"), since the kit cannot chain a tool call into a spawn.
    const spawns = engine(on)
    const r = await spawn($, TRIVIAL)
    expect(r.deny).toBe(undefined)
    expect(spawns.length).toBe(1)
    const out = { text: await geppetto($, 'explain') }
    expect(out.text).toContain('delegate false')
    expect(out.text).toContain('better kept with main')
  })

  test('an explicit model is never overridden', route, async ($, on) => {
    const spawns = engine(on)
    await spawn($, EXPLORE, { model: 'opus' })
    expect(spawns[0]?.model).toBe('opus')
    const out = { text: await geppetto($, 'explain') }
    expect(out.text).toContain('explicit model "opus" respected')
  })

  test('5. failed execution escalates only with evidence', route, async ($, on) => {
    const spawns = engine(on)
    const first = await spawn($, IMPLEMENT)
    expect(spawns[0]?.model).toBe('sonnet')
    // interrupted: not evidence → the retry stays on sonnet
    await $.turn.complete({ agentId: first.agentId, reason: 'aborted', answer: '', durationMs: 5, isAborted: true, turnId: 't1' })
    await spawn($, IMPLEMENT)
    expect(spawns[1]?.model).toBe('sonnet')
    // the second run reports failing tests: evidence → the next retry escalates to opus
    await $.turn.complete({ agentId: 'agent-2', reason: 'answer', answer: 'Done, but 3 tests failing: expected next_cursor in items.test.ts', durationMs: 5, isAborted: false, turnId: 't2' })
    await spawn($, IMPLEMENT)
    expect(spawns[2]?.model).toBe('opus')
    const out = { text: await geppetto($, 'explain') }
    expect(out.text).toContain('escalated to opus')
  })

  test('6. unsupported spawns fall back to native behavior', route, async ($, on) => {
    const spawns = engine(on)
    await spawn($, IMPLEMENT, { subagentType: 'acme:deployer' }) // an agent Geppetto does not know may pin its own model
    expect(spawns[0]?.model).toBe(undefined)
    expect(spawns[0]?.subagentType).toBe('acme:deployer')
    await spawn($, 'Hello.')                                      // unclassifiable
    expect(spawns[1]?.model).toBe(undefined)
  })

  test('/geppetto reports status and switches mode', route, async ($, on) => {
    engine(on)
    await spawn($, IMPLEMENT)
    const s = { text: await geppetto($, '') }
    expect(s.text).toContain('Geppetto route')
    expect(s.text).toContain('routed: 1')
    await geppetto($, 'mode off')
    expect((await geppetto($, 'status'))).toContain('Geppetto off (configured: route)')
  })
})

describe('mode off', () => {
  test('passes every spawn through untouched', { options: { mode: 'off' } }, async ($, on) => {
    const spawns = engine(on)
    await spawn($, ARCHITECTURE)
    expect(spawns[0]?.model).toBe(undefined)
    expect((await geppetto($, ''))).toContain('Decisions: 0')
  })
})
