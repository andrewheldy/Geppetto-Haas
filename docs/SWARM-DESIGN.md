# Multi-Agent Swarm Design

## Do Not Start With a Giant Swarm

The MVP should have only a few orchestration primitives.

### Primitive A — Single Specialist

Use when one worker can satisfy the capability node.

```text
Task → Specialist → Evaluator
```

### Primitive B — Parallel Specialists + Synthesizer

Use when independent evidence or perspectives improve the outcome.

```text
             ┌→ Specialist A ─┐
Task → Plan ─┼→ Specialist B ─┼→ Synthesizer → Evaluator
             └→ Specialist C ─┘
```

### Primitive C — Builder + Adversarial Reviewer

Use when producing an implementation.

```text
Task → Builder → Reviewer
          ↑         │
          └─ repair ┘
```

Maximum repair loops in MVP: 2.

### Primitive D — Planner / Workers / Supervisor

Use only for genuinely multi-stage tasks.

```text
              Supervisor
          ┌──────┼──────┐
          ▼      ▼      ▼
        W1      W2      W3
          └──────┼──────┘
                 ▼
              Result
```

## Topology Selection Rules

The Harness Compiler chooses topology using task properties.

| Property | Preferred topology |
|---|---|
| simple / deterministic | no swarm |
| one specialized domain | single specialist |
| uncertain factual research | parallel independent specialists |
| code / artifact production | builder + reviewer |
| multi-stage dependency graph | supervisor / workers |
| high-risk decision | independent parallel + adversarial review |

## Agent Manifest Philosophy

Every generated worker should have the narrowest viable:

- objective
- context
- tool access
- budget
- output schema
- lifetime

Avoid "general research agent" unless the planner cannot identify a narrower requirement.

## Agent Lifetime

### Ephemeral
Generated for one task and discarded.

### Cached Pattern
Manifest template retained because a similar worker is repeatedly useful.

### Registered Specialist
Human-approved durable capability.

MVP supports only:
- ephemeral
- cached pattern suggestion

Registered promotion is manual.
