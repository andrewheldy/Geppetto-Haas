# Geppetto — governed agent harness, Experiment 001 rig

Geppetto is a model-agnostic harness that turns an objective into an execution graph, builds ephemeral specialists just in time, compiles a deliberately minimal context packet for each one, keeps canonical state in a structured HSC layer instead of a transcript, and measures every token along the way.

The repo is also **Experiment 001**: does a governed graph of specialists with selective context use less lifecycle context than one long-running agent session, at equal quality? The system is instrumented so the answer comes from traces, not from the design.

Results so far: [docs/EXPERIMENT-001.md](docs/EXPERIMENT-001.md). Raw run artifacts are archived under [docs/results/](docs/results/).

## Layout

```
src/types.ts        contracts: Task, Graph/GraphNode, HSCState/HSCEntry, ContextPacket, AgentDefinition, ModelRoute,
                    RuntimeAdapter, TraceEvent, ContextLedgerEntry, EvaluationResult, WorkflowSummary
src/planner.ts      deterministic planner: PLAN → IMPLEMENT (parallel fan-out) → TEST (join) → REVIEW → [PATCH→TEST→REVIEW]* → HUMAN GATE
src/factory.ts      capability analysis, modular prompt resolver, least-privilege tool resolver, ephemeral agent assembly
src/router.ts       deterministic model router; every decision carries reasons
src/hsc.ts          L1 canonical state: candidate → promote/reject, supersede, decay, conflict detection
src/history.ts      L2 historical store (JSONL, searchable, never auto-injected)
src/governor.ts     Context Governor: admission, compaction (classify, keep raw in L2), rehydration, decay, conflicts, handoffs
src/compiler.ts     Context Compiler: node requirements → measured L0 packet
src/orchestrator.ts graph executor: ready-set scheduling, parallel batches, conditions, bounded loops, retries, replanning, budgets
src/control.ts      MODE B: one accumulating session driven through the same phases
src/runtime.ts      RuntimeAdapter: MockRuntime (deterministic, scriptable) and ClaudeCliRuntime (`claude -p`, real usage/cost)
src/evaluator.ts    deterministic acceptance checks + blind LLM review
src/experiment.ts   isolated workspaces, both modes, evaluation, comparison metrics
src/report.ts       markdown report from ledgers and traces
src/cli.ts          run | experiment | report | reevaluate | calibrate
tests/              node:test suites (23 tests), mock runtime end to end
tasks/              experiment task specs
docs/               original planning docs (HeldyOS JIT framing), ADRs, experiment write-ups
```

Zero runtime dependencies; Node 24 runs the TypeScript directly. `typescript` is a dev dependency for `npm run typecheck`.

## Run it

```bash
npm install
npm test                                                   # mock runtime, full graph incl. loops/retries/replans
node src/cli.ts experiment --task tasks/exp000-smoke.json  # both modes on the mock runtime
node src/cli.ts experiment --task tasks/exp001-registry.json --runtime claude --blind-model sonnet   # real run
node src/cli.ts report --dir runs/<experiment-id>
node src/cli.ts reevaluate --dir runs/<experiment-id>      # re-score finished workspaces, rebuild ledger labels
node src/cli.ts calibrate                                  # measure the runtime's fixed per-request overhead
```

Every run writes `trace.jsonl` (correlated experiment → workflow → graph → node → agent → invocation), `ledger.jsonl` (one row per model call: available, compiled, HSC, retrieved, tool, overhead, input/output/cache tokens, cost), `history.jsonl` (L2), `hsc.json`, `graph.json`, `agents.json`, raw `invocations/*.json`, `evaluation.json`, and a `report.md`.

## Governance labels

- **bootstrap**: the harness in `src/` was written conventionally by one agent session before Geppetto could run. Its measurements are not Geppetto results.
- **full**: everything under `runs/<experiment>/governed/` was planned, routed, context-compiled, executed, reviewed and promoted by Geppetto.
- **control**: `runs/<experiment>/control/` is the same task through one accumulating `claude -p --resume` session.

## Invariants kept

State ≠ transcript · available ≠ injected · agent output ≠ canonical truth (candidate → validated → promoted) · compaction ≠ deletion (raw stays in L2) · routing has reasons · loops are bounded · the runtime is replaceable behind `RuntimeAdapter` · metrics are not massaged.

## Not built (on purpose)

Learned routing, vector retrieval, graph database, LLM planner (interface exists: `Planner`), specialist promotion registry (interface only; Experiment 001's task builds it), dashboards, Ruflo adapter.
