# HeldyOS JIT Swarm MVP

## Purpose

This MVP tests one narrow hypothesis:

> A planning system that compiles task-specific agents, prompts, tools, context scopes, and swarm topology just in time can outperform a fixed multi-agent harness on quality, cost, latency, and recoverability.

This repository is intentionally not the full HeldyOS architecture. It is an experiment rig.

## MVP Loop

```text
Task
  ↓
HSC-lite Task Context
  ↓
Planner
  ↓
Capability Graph
  ↓
Agent Factory
  ↓
Tool + Skill + Prompt Resolution
  ↓
JIT Harness Compiler
  ↓
Ruflo Runtime Adapter
  ↓
Swarm Execution
  ↓
Evaluator
  ↓
Trace + Metrics + Candidate Promotions
```

## What is being tested

Two conditions execute the same benchmark task set.

### A. Static baseline
A fixed planner → researcher → builder → reviewer swarm with fixed prompts and tools.

### B. JIT condition
The planner outputs capability requirements. The Agent Factory creates only the agents needed for the task, selects their tools and prompt modules, and the Harness Compiler chooses topology, routing, retries, memory policy, and evaluation gates.

Compare:

- output quality
- task completion rate
- number of model calls
- token usage / cost
- elapsed execution time
- unnecessary tool calls
- recovery after injected failures
- context precision
- evaluator disagreement
- reusable agent-pattern discovery

## MVP Constraints

Do **not** build:
- a full UI
- enterprise auth
- full HSC federation
- a permanent agent marketplace
- autonomous promotion without a human gate
- a custom swarm runtime

Use Ruflo as an execution substrate behind an adapter.

## First success criterion

The MVP is interesting if the JIT condition shows either:

1. materially better quality at similar cost, or
2. materially lower cost at similar quality,

across multiple task classes, while producing inspectable manifests that explain why the swarm was assembled the way it was.

## Start Here

1. Read `docs/MVP-SPEC.md`
2. Read `docs/ARCHITECTURE.md`
3. Implement the contracts in `src/types.ts`
4. Implement the five pipeline components behind interfaces
5. Run the experiment in `docs/EXPERIMENT-PLAN.md`
6. Do not optimize until both baseline and JIT conditions run end-to-end
