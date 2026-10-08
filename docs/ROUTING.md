# Geppetto routing: design, verification, limits

## What it is

A routing core plus a Claude Code mod.

- **Core:** `plugins/geppetto/core/`. Pure TypeScript with no dependencies, Node or Claude Code types. It turns a `RoutingInput` and a `Policy` into a `RoutingDecision`.
- **Mod:** `plugins/geppetto/hooks/register.ts`. It applies the decision to the subagent spawns Claude Code is already making.

It adds no agent runtime and no model call on the default path.

```
Agent tool call ──► tool.call{Agent}   records what the call spelled out (subagent_type, model); changes nothing
                 └► agent.spawn        RoutingInput ──► route() ──► RoutingDecision
                                         route:  next({...e, model, subagentType?})   (route mode only)
                                         keep:   next(e)   explicit / pinned choice stands
                                         native: next(e)   unsupported, ambiguous, or routing threw (.catch)
                    turn.complete       records the model the subagent actually ran on and how it ended
                                        (failure evidence for the next escalation)
```

The core also backs the lab orchestrator's `DeterministicRouter` (`src/lab/router.ts`), which now takes its tier ladder from `tierForLevels` and `escalateTier`. The existing lab tests pass unchanged.

## Why these interception points (Claude Code 2.1.294)

| Need | API used | Found in |
|---|---|---|
| Change a subagent's model | `agent.spawn`: `model` is rewritable, and `undefined` means no explicit choice | `claude-code.d.ts` `AgentSpawnInput` |
| Tell explicit from defaulted agent type | `tool.call` on `Agent` sees the raw `subagent_type` before defaults; joined by `tool_use_id` | `BuiltinToolInputs.Agent` |
| Refuse a delegation | `agent.spawn` answers `{ deny }`, which the model sees as the Agent tool's error | `AgentSpawnResult` |
| Know what actually ran | `turn.complete` carries `agentId`, `reason` and `usage.model` | `TurnCompleteInput` |
| Optional classifier | `$.model.complete({ model: "haiku", effort: "low" })` on the session's own client; no extra provider | `ModelCompleteInput` |
| Commands | `$.command.register` + `command.run` | `CommandSpec` |

Not available, and so not done:

- **Effort.** `agent.spawn` has no effort field, and the Agent tool's `effort` parameter is reserved for explicit user requests.
- **Per-spawn `maxTurns`.** The Agent tool has none. `maxTurns` is advisory, or enforced opt-in by refusing tool calls past the budget, which is only ever more restrictive.

Agent definitions' own `model:` aren't exposed on the spawn. The mod reads `.claude/agents/*.md` and `~/.claude/agents/*.md` to find pins, and leaves every agent type it doesn't know untouched.

Built-in agents were measured with headless runs (main model sonnet, no `model` parameter): `general-purpose`, `Plan` and `Explore` all inherit the parent's model in this build, so routing may set one.

## Decision rules (in order)

1. **Never touch:** unsupported spawns (fork, teammate, workflow agent), an explicit model, `CLAUDE_CODE_SUBAGENT_MODEL`, an agent whose definition pins a model, or an agent type not in the known list.
2. **Classify** with typed regex rules. Paths, URLs and code spans are stripped first, so `ARCHITECTURE.md` is not a design task, and negated writes ("don't change anything") count as read-only. Below `minConfidence` (0.6), or kind `unknown`, the result is **native**.
3. **Tier:**
   - Start from the policy default for the kind.
   - High complexity moves implement, debug, review and test one tier up.
   - The cheapest tier needs a clear win: confidence ≥ 0.8 and no competing kind scoring above 1. Otherwise the task goes one tier up, because under-powering costs more than over-paying.
   - Unbounded tasks (over 4,000 characters, or many references) leave the cheapest tier.
   - High risk has a floor of sonnet.
4. **Escalate only on evidence.**
   - Kinds that count: `capability`, `test_failure` or `budget_exhausted`, each with an evidence line.
   - Kinds that never count: interruptions, refusals, API errors, permission denials, and attempts without evidence.
   - Escalation goes one tier above the failed attempt, never above `maxTier` (opus) unless the tier is in `authorized`.
   - A retry never routes below the tier that failed.
5. **Agent:** only for exploration, and only when the caller named no agent, narrow to a read-only agent (`Explore`). Never widen.
6. **Trivial:** `delegate: false`. In route mode, a confident (≥ 0.8) trivial delegation with no explicit agent is refused with a message saying to do it inline. An explicit `subagent_type` or `model` on a retry goes through.

Every decision carries `reason`, a `trace` of every rule that fired, and the policy version. `/geppetto explain` shows them along with what was applied and what the subagent actually ran on.

## Verification

### Automated

| Suite | Command | Result |
|---|---|---|
| Routing core: six scenarios, safety, policy validation, classifier gate, overhead | `npm test` (`tests/routing/`) | 19/19 |
| Existing Geppetto (incl. lab router now on the core) | `npm test` | 40/40 |
| Plugin under the engine's dispatcher (`claude-code/testing`) | `claude plugin test plugins/geppetto` | 11/11 |
| Manifest, hooks, state contract, marketplace | `claude plugin validate plugins/geppetto` and `claude plugin validate .` | pass |
| Types | `npm run typecheck`, `tsc -p plugins/geppetto` | clean |

### End-to-end

`npm run e2e` runs real headless Claude Code 2.1.294 sessions with `--plugin-dir`. The main model really calls the Agent tool, and three independent records are compared:

1. Geppetto's decision
2. the subagent's `turn.complete` model
3. Claude Code's own `modelUsage`

Results are in [`results/e2e-claude-code.json`](results/e2e-claude-code.json): 20/20 checks, $0.83 total.

| Scenario | Main model | Subagent ran on |
|---|---|---|
| Exploration, route mode | sonnet | haiku via `Explore` |
| Implementation, route mode | haiku | sonnet (and the file was written) |
| Architecture, route mode | haiku | opus |
| Trivial, route mode | sonnet | refused; the main model fixed the typo inline |
| Explicit `model: "haiku"` on an architecture task | sonnet | haiku (kept, not opus) |
| Observe mode | sonnet | sonnet (decision recorded, nothing applied) |
| Off mode | sonnet | sonnet (nothing recorded) |

The engine itself spends about 20 Haiku output tokens per session (titles and summaries). The checks require far more than that before counting Haiku as the subagent's model.

What the end-to-end suite does **not** cover:

- **Evidence-based escalation.** It is tested in the core and under the plugin kit (an aborted run doesn't escalate; a run reporting failing tests does), but not against a real failing subagent.
- **The classifier.** It is off by default and was not exercised live; its gate and schema validation are unit-tested with a fake.

### Classification accuracy, honestly

| Set | Source | Accuracy | Routed | Under-powered |
|---|---|---|---|---|
| `tests/routing/corpus.json` (42) | written with the rules: in-sample | 1.00 | 86% | 0 |
| `tests/routing/heldout.json` (24) | written by me after the first rules, then used to generalize them | 0.96 | 88% | 0 |
| `tests/routing/blind.json` (48) | written by a separate subagent from kind definitions alone, never shown the rules | **0.63** | 69% | **2 of 31** |

The blind set is the only honest generalization estimate. Its score of 0.63 / 5 under-powered was recorded before the cheap-tier guard was added. The guard was chosen after seeing that result (it was motivated by asymmetric cost, not by fitting items), so the 2-of-31 figure is post-hoc. The set has not been used to tune the regexes.

Most misses fall back to native, which changes nothing. The remaining confident misroutes are:

- a behavioral bug report without failure vocabulary ("returns an empty list since yesterday's deploy") read as exploration
- an "idempotent retries" design task read as debugging

Measured delegation overhead: about 30 µs per decision with no model call. The classifier is never called for trivial, confident or short tasks (asserted).

**What would change this.** Routing decisions plus `observedModel` and outcomes are now recorded per session. A batch of real decision logs labeled after the fact would give an uncontaminated accuracy number. Enabling the Haiku classifier is justified only if that number shows misroutes that cost more than the classifier does.

## Limits

- Classification is keyword-based. Accuracy is moderate (blind 0.63), but it fails mostly *safe*: native, or one tier too strong.
- The `Agent` tool-call record is held in module memory between `tool.call` and `agent.spawn`. If the module reloads in between, the spawn is treated as explicit (no agent narrowing, no trivial refusal); model routing still works.
- `maxTurns` is a tool-call budget, not a model-turn count, and is enforced only with `enforceBudget`.
- Escalation matches retries by identical description, or by word overlap ≥ 0.6 between task prompts.
