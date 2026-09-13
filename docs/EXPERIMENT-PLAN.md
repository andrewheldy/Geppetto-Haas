# Experiment Plan

## Core Hypothesis

A JIT-compiled agent system will outperform a static multi-agent harness on heterogeneous tasks because it can adapt:

- worker specialization
- tool grants
- prompts
- model choice
- context scope
- topology

to the task.

## Baseline

Fixed swarm:

```text
Planner
 ↓
Researcher
 ↓
Builder
 ↓
Reviewer
```

All four exist for every task.

Fixed:
- prompt
- tools
- context policy
- model family
- topology

## JIT Condition

```text
Planner
 ↓
Capability Graph
 ↓
Agent Factory
 ↓
Harness Compiler
 ↓
minimum necessary swarm
```

## Benchmark Classes

Start with 12 tasks, 3 per class.

### Class 1 — Research
Example:
"Compare three agent memory approaches and recommend one under a strict cost constraint."

### Class 2 — Coding
Example:
"Inspect a small repo, identify one bug, patch it, and provide tests."

### Class 3 — Strategy / Analysis
Example:
"Evaluate whether a new feature should be built given constraints and evidence."

### Class 4 — Mixed workflow
Example:
"Research an API, inspect a repo, produce an implementation plan, and review it adversarially."

## Metrics

Capture automatically:

```yaml
quality:
  correctness: 0-10
  completeness: 0-10
  evidence_quality: 0-10
  constraint_adherence: 0-10
  evaluator_confidence: 0-1

efficiency:
  total_model_calls:
  total_tokens:
  estimated_cost_usd:
  wall_clock_ms:
  tool_calls:
  unnecessary_tool_calls:

architecture:
  agents_spawned:
  context_bytes_supplied:
  repair_loops:
  failed_steps:
  recovered_failures:
```

## Blind Evaluation

The evaluator should not know whether an output came from `static` or `jit`.

For stronger tests:
- randomize result order
- run at least two independent evaluators
- record disagreement

## Failure Injection

MVP should test one failure per workflow:

- one tool call fails
- one worker returns malformed output
- one worker exceeds token budget
- one worker produces low-confidence evidence

Measure whether the harness:
- retries
- reroutes
- degrades gracefully
- asks for human intervention

## Passing Signal

Do not declare victory from one demo.

A useful signal is:

- ≥10 heterogeneous benchmark tasks
- JIT improves average quality by ≥10% at comparable cost, **or**
- reduces cost by ≥20% at comparable quality
- no significant drop in completion rate
- manifests remain understandable to a human

These thresholds are experiment defaults, not claims of statistical significance.
