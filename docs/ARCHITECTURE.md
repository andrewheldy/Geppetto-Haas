# Architecture

## Layer Model

```text
┌─────────────────────────────────────────────────────┐
│ HeldyOS Control                                      │
│ task intake · policies · budgets · approvals         │
└───────────────────────┬─────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────┐
│ HSC-lite Context Compiler                            │
│ truth · provenance · permissions · task scope        │
└───────────────────────┬─────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────┐
│ Planner                                               │
│ decomposes task into capability graph                 │
└───────────────────────┬─────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────┐
│ Agent Factory                                         │
│ creates specialized workers from requirements         │
└──────────────┬───────────────────────┬──────────────┘
               │                       │
       ┌───────▼────────┐      ┌──────▼─────────┐
       │ Tool/Skill      │      │ Prompt Compiler │
       │ Resolver        │      │                 │
       └───────┬────────┘      └──────┬─────────┘
               └────────────┬──────────┘
                            │
┌───────────────────────────▼─────────────────────────┐
│ JIT Harness Compiler                                 │
│ topology · memory · retries · model policy · gates   │
└───────────────────────────┬─────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────┐
│ Runtime Adapter                                       │
│ Ruflo now; other runtimes later                       │
└───────────────────────────┬─────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────┐
│ Evaluator                                             │
│ quality · cost · latency · failure recovery           │
└───────────────┬───────────────────────────┬─────────┘
                │                           │
        Experience memory             HSC candidate patch
```

## Separation of Responsibilities

### HSC
Owns:
- current semantic state
- provenance
- authority
- disclosure boundaries
- freshness
- candidate → canonical promotion

Does not own:
- execution process management
- swarm messaging
- retries
- model invocation

### Agent Factory
Owns:
- whether a new specialist should exist
- worker role
- worker objective
- required cognitive capabilities
- tool grants
- context scope
- expected output contract
- ephemeral vs reusable classification

### JIT Harness Compiler
Owns:
- collaboration topology
- sequencing / parallelism
- model class per worker
- reasoning effort
- memory policy
- retry / timeout policy
- verification gates
- stop conditions
- fallback behavior

### Ruflo Runtime Adapter
Owns:
- translating a compiled harness into Ruflo execution primitives
- spawning and coordinating workers
- collecting traces
- returning normalized execution results

It must **not** own canonical HeldyOS state.

## Runtime Boundary

Define an interface rather than importing Ruflo semantics throughout the codebase.

```ts
interface RuntimeAdapter {
  execute(harness: HarnessManifest): Promise<ExecutionTrace>;
}
```

Then:

```ts
class RufloRuntimeAdapter implements RuntimeAdapter {}
```

Later:

```ts
class LocalRuntimeAdapter implements RuntimeAdapter {}
class OpenAIRuntimeAdapter implements RuntimeAdapter {}
class AnthropicRuntimeAdapter implements RuntimeAdapter {}
```

This keeps HeldyOS independent of any specific swarm implementation.

## The Most Important Design Rule

The planner must output **capability requirements**, not preselected agent names.

Bad:

```yaml
steps:
  - researcher
  - coder
  - reviewer
```

Good:

```yaml
node:
  objective: verify feasibility
  capabilities:
    - repository_analysis
    - current_documentation_research
    - adversarial_reasoning
  tools:
    required:
      - github.read
      - web.search
  verification:
    required: true
```

The factory decides how to fulfill that requirement.
