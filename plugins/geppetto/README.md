# Geppetto for Claude Code

A Claude Code mod that chooses the model (and, for exploration, the read-only agent) for each subagent Claude Code spawns. It uses a deterministic, explainable policy. It adds no agent runtime: it rewrites the `model` of a spawn Claude Code is already making, and only when nobody chose one explicitly.

| Task the subagent gets | Routed to |
|---|---|
| Trivial (typo, version bump, one value) | stays with the current agent (route mode refuses the delegation) |
| Exploration (find, locate, survey, explain) | `Explore` agent on Haiku |
| Implementation, tests, review, ordinary debugging | Sonnet |
| Architecture, trade-offs, difficult debugging, high-complexity work | Opus |
| Failed attempt with evidence (failing tests, "could not…", budget hit) | one tier up |
| Fable | only if your policy lists it under `authorized` |
| Ambiguous / unknown / unsupported | unchanged (native Claude Code behavior) |

It never overrides:
- an explicit `model` on the Agent call
- `CLAUDE_CODE_SUBAGENT_MODEL`
- an agent definition that pins its own `model:`
- an agent type it doesn't know

It also never touches forks, teammates or workflow agents. Permissions are untouched: Geppetto only edits the spawn's `model` and `subagentType`, and only ever narrows the agent, so the subagent still runs under Claude Code's own permission checks.

## Install

Requires Claude Code 2.1.294 or newer (function-hook mods). In a terminal session:

```
/plugin install geppetto --marketplace andrewheldy/geppetto-haas
```

Answer `y` to add the marketplace, then pick a scope. It starts in **observe** mode: it records what it would do and changes nothing.

To run it from a clone instead: `claude --plugin-dir /path/to/geppetto-haas/plugins/geppetto`.

## Use

```
/geppetto                 status: mode, policy, decisions, which models subagents actually ran on
/geppetto explain [n]     the full trace of decision n (default: the latest)
/geppetto mode route      start routing for this session (also: observe, off)
/geppetto policy          the effective policy as JSON
```

To make routing the default, set the plugin option `mode` to `route` (`/config`, or `pluginConfigs.geppetto.options.mode` in settings). The environment variable `GEPPETTO_MODE=off|observe|route` overrides both.

| Option | Default | Effect |
|---|---|---|
| `mode` | `observe` | `off`, `observe` or `route` |
| `modelParam` | `alias` | pass `haiku`/`sonnet`/`opus` (Claude Code resolves the current version) or the policy's full model `id` |
| `classifier` | `false` | ask Haiku (low effort) to classify tasks the rules can't, only when the expected value beats the call's cost |
| `enforceBudget` | `false` | refuse a routed subagent's tool calls past its `maxTurns` budget so it reports back |
| `policyPath` | `.claude/geppetto.policy.json` | project policy merged over the defaults |

`GEPPETTO_DECISIONS_FILE=/path.json` writes every decision, and what the subagent actually ran on, to a file for auditing.

## Policy

Model versions live only in the policy. To move to a new Sonnet, change one id:

```json
{ "models": { "sonnet": { "id": "claude-sonnet-5-5" } }, "kinds": { "review": { "tier": "opus" } } }
```

See [`examples/geppetto.policy.json`](examples/geppetto.policy.json) and `/geppetto policy` for every field. An invalid policy file is rejected with the reasons, and the defaults are used instead.

## Develop

```
claude plugin validate plugins/geppetto    # what it hooks and calls
claude plugin test plugins/geppetto        # integration tests against the engine's dispatcher
npm test                                    # routing core (node:test), from the repo root
npm run e2e                                 # real headless Claude Code sessions (costs tokens)
```

The routing core (`core/`) is plain TypeScript with no dependencies and no Claude Code types. Any runtime can call `route(input, policy)`; Geppetto's own lab orchestrator does (`src/lab/router.ts`). Design and measurements: [`docs/ROUTING.md`](../../docs/ROUTING.md).
