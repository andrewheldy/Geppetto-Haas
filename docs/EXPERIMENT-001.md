# Experiment 001 — Geppetto builds Geppetto

## Question

For the same objective and comparable output quality, how much total context does a governed Geppetto workflow require compared with one competent long-running agent session?

Secondary: does specialization help or hurt quality; does HSC cost more than it saves; how often is compacted information needed again (retrievals); where does the overhead land.

## Governance labels (do not mix these up)

| Portion | Label |
|---|---|
| The harness in `src/` (contracts, orchestrator, governor, runtime, evaluator, report, tests) | **pre-Geppetto bootstrap** — written by a conventional single agent session, unmeasured |
| Smoke runs (`tasks/smoke.json`) | full governed vs control, but a trivial task; used to validate the runtime and the ledger, not as evidence |
| Experiment 001 task (`tasks/exp001-registry.json`) | **fully governed** (Mode A) vs **monolithic control** (Mode B), both on the real runtime |

Later Geppetto work that is executed through Geppetto should be labelled `partial` or `full` in the run summary (`WorkflowSummary.governance`).

## Modes

**Mode A — governed.** `DeterministicPlanner` graph → JIT specialists (`factory.ts`) → compiled L0 packets (`compiler.ts`) → `ClaudeCliRuntime` (fresh session per node, `--no-session-persistence`) → HSC promotion → compaction → isolated review → bounded patch loop → human gate (auto-approved, recorded).

**Mode B — control.** One `claude -p` session, resumed for every phase (`--resume`), same system prompt spirit, same tools, same phases (plan, implement, test, self-review, patch), same acceptance criteria. Nothing is compiled or compacted by us; whatever the runtime does automatically is left alone. The control is not sabotaged.

Both modes share: task file, workspace preparation (repo copy + git baseline), runtime configuration (`--safe-mode --strict-mcp-config`, tool list, permission mode), deterministic evaluation, blind reviewer.

## What is measured

Per invocation (ledger row): provider-reported input, output, cache-read, cache-write tokens; per-round-trip peak active context; cost (provider `total_cost_usd`); duration; compiled/available/retrieved/discarded packet tokens (chars/4 estimates); compaction removed; HSC delta.

Per workflow (summary): lifecycle tokens, peak/avg active context, injected vs avoided context, HSC/retrieval/compaction overhead, cost, duration, calls, nodes, loops, retries, replans.

Derived (`report.ts:compare`): context reduction (peak, avg), lifecycle token reduction, cost/duration reduction, HSC overhead ÷ tokens saved, retrieval overhead, compaction ratio, handoff efficiency (compiled ÷ available), quality deltas.

Quality: acceptance criteria (files, commands, test counts), review findings, retries, blind review score with random A/B labelling.

## Known measurement caveats

- Packet sizes are chars/4 estimates; model usage is provider-reported. Both are labelled in the ledger (`tokens_estimated`).
- Lifecycle tokens count cached prefixes every time they are re-read. That is what the model attends to and what is billed; it is also exactly the quantity the hypothesis is about.
- The Claude CLI adds its own tool definitions to every request; this overhead is identical for both modes and shows up as `prompt_overhead_tokens`.
- Control turns are driven by the same phase script as the governed graph so the two are comparable; a human driving the control might use fewer or more turns.
- One run per mode is an anecdote, not a distribution. Repeat with `--id` variations before drawing conclusions.

## Running it

```bash
npm test                                                 # bootstrap tests (mock runtime)
node src/cli.ts experiment --task tasks/smoke.json --runtime mock            # dry run
node src/cli.ts experiment --task tasks/exp001-registry.json --runtime claude --blind-model sonnet
node src/cli.ts report --dir runs/<experiment-id>
```
