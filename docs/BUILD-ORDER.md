# Build Order

## Phase 0 — Contracts

Implement only types and JSON validation.

- TaskSpec
- HSCContext
- PlanGraph / PlanNode
- AgentManifest
- HarnessManifest
- ExecutionTrace
- EvaluationResult

Do not connect Ruflo yet.

## Phase 1 — Mock Pipeline

Use deterministic fixtures:

```text
Task
→ fake planner
→ fake agent factory
→ fake harness compiler
→ mock runtime
→ evaluator
```

Goal: prove the data contracts.

## Phase 2 — Real Planner + Factory

Use one frontier model to:
- generate capability graph
- generate agent manifests

Persist every generated manifest.

## Phase 3 — Static Runtime

Connect Ruflo only for the static baseline.

Verify:
- execution
- trace capture
- failure normalization

## Phase 4 — JIT Runtime

Translate `HarnessManifest` into Ruflo swarm primitives.

Support only:
- single specialist
- parallel + synthesis
- builder + reviewer

## Phase 5 — Experiment Runner

CLI:

```bash
npm run experiment -- --suite ./tests/benchmarks.json
```

Produces:

```text
runs/<run-id>/
  task.json
  plan.json
  agents.json
  harness.json
  trace.json
  evaluation.json
```

## Phase 6 — Failure Injection

Add failure hooks.

## Phase 7 — Pattern Learning

Only after experiment data exists:

- cluster similar successful agent manifests
- suggest reusable patterns
- require human promotion

Do not build an autonomous self-modifying registry before this phase.
