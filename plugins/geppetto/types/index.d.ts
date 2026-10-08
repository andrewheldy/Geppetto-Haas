// Geppetto mod: the values it keeps in $.state for the session.

export type GeppettoMode = 'off' | 'observe' | 'route'

/** One routing decision at an agent spawn, and what became of it. JSON only. */
export type DecisionRecord = {
  seq: number
  at: string
  mode: GeppettoMode
  toolUseId: string
  description: string
  taskPreview: string
  /** What the caller asked for explicitly. */
  requested: { agent?: string; model?: string }
  /** What the runtime had resolved before Geppetto looked. */
  resolvedAgent: string
  action: 'route' | 'keep' | 'native' | 'error'
  delegate: boolean
  agent: string
  model: string
  alias?: string
  kind: string
  complexity: string
  confidence: number
  source: string
  reason: string
  maxTurns: number
  contextRefs: string[]
  fallback: string
  trace: string[]
  classifierCalled: boolean
  /** What Geppetto changed: nothing in observe mode, nothing for keep/native. `denied` refused a trivial delegation. */
  applied: { model?: string; agent?: string; denied?: string }
  /** The started subagent and the model the engine said it started on. */
  agentId?: string
  spawnedModel?: string
  /** From the subagent's turn.complete: the model it actually ran on, and how it ended. */
  observedModel?: string
  outcome?: { reason: string; failure?: string; evidence?: string; toolCalls?: number }
}

declare module 'claude-code' {
  interface PluginState {
    geppetto: { mode: GeppettoMode | null; decisions: DecisionRecord[]; seq: number }
  }
}
