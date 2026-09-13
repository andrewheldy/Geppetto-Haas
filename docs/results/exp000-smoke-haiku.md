# Experiment exp000-smoke-haiku

**Objective:** Add src/hello.ts exporting greet(name: string): string that returns `Hello, <name>!`, plus tests/hello.test.ts using node:test covering a normal name and an empty string (which should return `Hello, stranger!`).

Runtime: `claude` · Created: 2026-09-13T05:56:00.424Z

> Governed mode = full Geppetto (graph, JIT specialists, HSC, governor, compiled L0, retrieval, compaction, isolated review). Control = one accumulating session (bootstrap-style, no governance). The harness itself was built pre-Geppetto (bootstrap); only the task under test is governed.

## Headline comparison

| Metric | Geppetto (governed) | Long agent (control) |
|---|---|---|
| Lifecycle model tokens (input+cache+output) | 143,672 | 127,094 |
| Lifecycle input tokens (uncached) | 126 | 96 |
| Lifecycle cache-read tokens | 117,592 | 107,113 |
| Lifecycle cache-write tokens | 18,921 | 15,598 |
| Lifecycle output tokens | 7,033 | 4,287 |
| Peak active context | 12,663 | 14,473 |
| Average active context | 6,331 | 12,420 |
| Cumulative context injected (compiled+retrieved) | 2,805 | 49,678 |
| Cumulative context avoided | 494 | 0 |
| Cost | $0.0914 | $0.0646 |
| Duration | 69s | 52s |
| Agent calls | 3 | 4 |
| Graph nodes / turns | 5 | 4 |
| Retries | 0 | 0 |
| Review loops | 0 | 0 |
| Replans | 0 | 0 |
| Context retrievals | 0 | N/A |
| Context compactions | 4 | N/A |
| HSC overhead tokens | 1,721 | N/A |
| Acceptance criteria passed | 3/3 | 3/3 |
| Tests passed / failed | 2 / 0 | 2 / 0 |
| Blind review score (0-10) | 9 (10 findings, as "B") | 9 (10 findings, as "A") |
| Review findings raised | 0 | 0 |
| Status | completed | completed |

## Derived context-efficiency metrics

| Metric | Value | Definition |
|---|---|---|
| Context reduction (peak) | 12.5% | 1 − governed peak / control peak |
| Context reduction (avg) | 49.0% | 1 − governed avg / control avg |
| Lifecycle token reduction | -13.0% | 1 − governed lifecycle / control lifecycle |
| Cost reduction | -41.5% | 1 − governed cost / control cost |
| Duration reduction | -33.8% | 1 − governed elapsed / control elapsed |
| Tokens saved | -16,578 | control − governed lifecycle tokens (negative = Geppetto cost more) |
| HSC overhead / tokens saved | n/a (no savings) | tokens spent maintaining state ÷ tokens saved |
| Retrieval overhead | 0 tokens over 0 calls | context pulled back because it was omitted from L0 |
| Compaction ratio | 3.03× | Σ pre-compaction / Σ post-compaction |
| Handoff efficiency | 88.8% | avg compiled / available per agent node (lower = more context left out) |
| Quality Δ (criteria) | 0 | governed − control criteria passed |
| Quality Δ (blind score) | 0 | governed − control blind score |

## Active context by task (tokens the model attended to per invocation)

### Geppetto (governed)
```
plan                   ██████████████     6,604  (compiled 604, avail 604, out 1,887, claude-haiku-4-5-20251001)
implement              ██████████████████████████    12,663  (compiled 1,067, avail 1,144, out 2,319, claude-haiku-4-5-20251001)
test                   ▏         0  (compiled 0, avail 1,332, out 0, none)
review                 █████████████     6,057  (compiled 1,134, avail 1,551, out 2,827, claude-haiku-4-5-20251001)
```

### Long agent (control)
```
plan                   █████████████████████    10,068  (compiled 10,068, avail 10,068, out 1,361, claude-haiku-4-5-20251001)
implement              █████████████████████████    12,040  (compiled 12,040, avail 12,040, out 997, claude-haiku-4-5-20251001)
test                   ███████████████████████████    13,097  (compiled 13,097, avail 13,097, out 391, claude-haiku-4-5-20251001)
review                 ██████████████████████████████    14,473  (compiled 14,473, avail 14,473, out 1,538, claude-haiku-4-5-20251001)
```

## Cumulative lifecycle tokens over time

### Geppetto

| Step | Active context | Cumulative tokens |
|---|---|---|
| plan | 6,604 | 18,346 |
| implement | 12,663 | 129,861 |
| test | 0 | 129,861 |
| review | 6,057 | 143,672 |

### Long agent

| Step | Active context | Cumulative tokens |
|---|---|---|
| plan | 10,068 | 35,497 |
| implement | 12,040 | 71,244 |
| test | 13,097 | 97,498 |
| review | 14,473 | 127,094 |

## Agent / model distribution

### Geppetto
- planning-architect-01 @ claude-haiku-4-5-20251001: 1 call(s)
- implementation-engineer-02 @ claude-haiku-4-5-20251001: 1 call(s)
- test-runner @ none: 1 call(s)
- independent-reviewer-03 @ claude-haiku-4-5-20251001: 1 call(s)

### Long agent
- monolith @ claude-haiku-4-5-20251001: 4 call(s)

## Routing decisions (governed)

| Node | Requirements | Selected | Reasons |
|---|---|---|---|
| plan | {"complexity":"medium","reasoning":"high","independence":false} | haiku (high) | complexity=medium, reasoning=high → strongest tier; capped to haiku by run configuration |
| implement | {"complexity":"high","reasoning":"high","independence":false} | haiku (high) | complexity=high, reasoning=high → strongest tier; capped to haiku by run configuration |
| review | {"complexity":"medium","reasoning":"high","independence":true} | haiku (high) | complexity=medium, reasoning=high → strongest tier; capped to haiku by run configuration |

## Compaction events (governed)

| Node | Trigger | Pre | Post | Ratio | L2 ref |
|---|---|---|---|---|---|
| plan | agent handoff | 363 | 130 | 2.79× | h1 |
| implement | agent handoff | 342 | 130 | 2.63× | h2 |
| test | task phase completed | 66 | 37 | 1.78× | h3 |
| review | agent handoff | 521 | 130 | 4.01× | h4 |

## Compiled context packets (governed)

- **plan**: 604 tokens injected of 604 available (0 items left out) — task:81, handoff:56, hsc:constraint+decision+fact:79, file:package.json:130, file:tests/helpers.ts:257
- **implement**: 1,067 tokens injected of 1,144 available (0 items left out) — task:81, handoff:217, hsc:constraint+decision+artifact:181, output:plan:200, file:package.json:130, file:tests/helpers.ts:257
- **review**: 1,134 tokens injected of 1,551 available (0 items left out) — task:81, handoff:282, hsc:constraint+decision+assumption:303, output:test:47, output:implement:201, diff:219

## Quality

### Geppetto

- [x] file exists: src/hello.ts
- [x] file exists: tests/hello.test.ts
- [x] command passes: node --test tests/hello.test.ts (exit 0, pass 2 fail 0)

Blind review (claude-haiku-4-5-20251001, saw only "Artifact B"): score 9
- Both required files created with correct syntax and structure
- Function logic correctly handles normal names and empty strings with proper return format
- Tests cover both specified scenarios with clear, descriptive names
- Correctly uses node:test and node:assert/strict with strict equality assertions
- Zero new dependencies - complies with constraints
- Minimal, focused diff with no extraneous code
- TypeScript type annotations are correct and complete
- Import path uses .ts extension which assumes TypeScript transpilation is configured in the project
- Tests are adequate for stated requirements but lack additional edge case coverage (though not required)
- Code is clean, readable, and uses idiomatic JavaScript patterns

### Long agent

- [x] file exists: src/hello.ts
- [x] file exists: tests/hello.test.ts
- [x] command passes: node --test tests/hello.test.ts (exit 0, pass 2 fail 0)

Blind review (claude-haiku-4-5-20251001, saw only "Artifact A"): score 9
- Implementation correctly handles both required cases: normal names return 'Hello, <name>!' and empty strings return 'Hello, stranger!'
- Both required files created with proper structure and exports
- Tests use node:test and node:assert/strict as specified
- No new dependencies introduced—satisfies constraint
- Diff is minimal with only 2 new files
- TypeScript types properly specified for function signature
- Test descriptions are clear and specific
- Assumes TypeScript is properly configured in project to execute .ts files directly; configuration not verified
- Test suite is minimal but complete for stated requirements—no edge case coverage (null, undefined, whitespace)
- Code execution cannot be independently verified without running 'node --test' in the actual environment

## Measurement notes

- Token counts: some rows are heuristic estimates (chars/4) — see `tokens_estimated` in the ledgers. Compiled/available packet sizes are always chars/4 estimates.
- Active context = input + cache_read + cache_write of the largest API round-trip inside an invocation. Lifecycle tokens sum every round-trip, so cached prefixes are counted each time they are re-read (that is what the provider bills and what the model attends to).
- The control's per-turn "available" and "compiled" context are equal by construction: a monolithic session injects everything it has.
- Blind review labels (A/B) were assigned randomly per experiment; the evaluator never saw the mode.
