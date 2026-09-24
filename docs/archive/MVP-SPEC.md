# MVP Specification

## Goal

Build a functioning experiment in which the same task can be run through:

- `static` orchestration
- `jit` orchestration

and produce comparable traces and evaluation scores.

## Five Required Components

### 1. Planner

Input:
- `TaskSpec`
- HSC-lite context
- available capability registry

Output:
- `PlanGraph`

The planner decomposes work into capability requirements.

It does not assign concrete agent identities.

### 2. Agent Factory

Input:
- one `PlanNode`
- capability registry
- tool registry
- prompt-module registry
- past successful agent patterns

Output:
- one or more `AgentManifest`s

The factory may decide:
- no agent is needed
- deterministic tool/script is sufficient
- one ephemeral specialist is enough
- multiple independent agents are useful
- a persistent registered specialist should be reused

### 3. Prompt + Capability Compiler

For each agent manifest, compile:

```text
system core
+ role module
+ task module
+ relevant HSC state
+ tool instructions
+ domain skill modules
+ constraints
+ output schema
+ evaluation criteria
```

Prompt source material stays modular.

Do not hand-maintain one giant prompt per agent.

### 4. JIT Harness Compiler

Input:
- `PlanGraph`
- generated agent manifests
- task constraints / budget

Output:
- `HarnessManifest`

Decisions include:
- sequential vs parallel
- supervisor vs peer-to-peer
- debate / independent review
- model class
- reasoning effort
- context refresh policy
- memory mode
- retries
- stop conditions
- evaluation gate

### 5. Evaluator

Input:
- original task
- execution trace
- final result
- rubric

Output:
- `EvaluationResult`

Score at least:
- correctness
- completeness
- evidence quality
- constraint adherence
- unnecessary work
- cost
- latency
- recovery behavior

## HSC-lite for MVP

Do not implement the whole HSC protocol.

Use:

```yaml
state:
  facts: []
  constraints: []
  decisions: []
  resources: []
  permissions: []
  provenance: []
```

The only purpose in MVP is to ensure the factory receives scoped state rather than entire conversation history.

## Registry Types

MVP registries:

```text
capabilities/
tools/
prompt-modules/
skills/
agent-patterns/
models/
```

They can begin as JSON files.

No database required for v0.

## Promotion

No automatic permanent promotion in MVP.

The evaluator may emit:

```yaml
promotion_candidate:
  type: agent_pattern
  reason: repeated_success
  confidence: 0.87
```

A human accepts or rejects it.

## API Shape

Conceptual:

```ts
runExperiment({
  task,
  mode: "static" | "jit",
  budget,
  runtime: "ruflo"
})
```

returns:

```ts
{
  result,
  plan,
  agents,
  harness,
  trace,
  evaluation
}
```

## Definition of Done

MVP is done when:

1. one task executes static and JIT modes
2. manifests are persisted
3. execution trace is persisted
4. evaluator produces comparable metrics
5. at least 10 benchmark tasks run automatically
6. one injected failure can be recovered from
7. all runtime-specific logic is behind the adapter
