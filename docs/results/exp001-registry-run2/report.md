# Experiment exp001-registry-run2

**Objective:** Extend Geppetto with two independent pieces of telemetry tooling. (A) A specialist promotion registry: src/registry.ts exporting a SpecialistRegistry class that ingests one or more run directories (each containing agents.json, ledger.jsonl and trace.jsonl as produced by src/orchestrator.ts), aggregates per-role statistics (number of invocations, node success rate derived from node.completed vs node.failed trace events, mean cost, mean input and output tokens, models used) and suggests promotion candidates (roles with at least 3 invocations and success rate >= 0.8) with a human-readable reason; it must be able to save/load registry.json and must never auto-promote (candidates only). Wire a `registry --runs <dir> [--out registry.json]` command into src/cli.ts that scans every subdirectory containing agents.json and prints a table. (B) A CSV exporter: src/ledger-csv.ts exporting ledgerToCsv(rows: ContextLedgerEntry[]): string that writes a header row from the ContextLedgerEntry keys and escapes commas, quotes and newlines correctly. Both parts need tests in tests/registry.test.ts and tests/ledger-csv.test.ts using node:test, and the whole repo must still typecheck.

Runtime: `claude` · Created: 2026-09-13T05:59:47.708Z

> Governed mode = full Geppetto (graph, JIT specialists, HSC, governor, compiled L0, retrieval, compaction, isolated review). Control = one accumulating session (bootstrap-style, no governance). The harness itself was built pre-Geppetto (bootstrap); only the task under test is governed.

## Headline comparison

| Metric | Geppetto (governed) | Long agent (control) |
|---|---|---|
| Lifecycle model tokens (input+cache+output) | 1,518,970 | 1,844,456 |
| Lifecycle input tokens (uncached) | 84 | 68 |
| Lifecycle cache-read tokens | 1,310,713 | 1,656,098 |
| Lifecycle cache-write tokens | 154,890 | 147,061 |
| Lifecycle output tokens | 53,283 | 41,229 |
| Peak active context | 57,708 | 81,355 |
| Average active context | 34,089 | 66,920 |
| Cumulative context injected (compiled+retrieved) | 26,507 | 267,680 |
| Cumulative context avoided | 11,256 | 0 |
| Cost | $3.5727 | $3.3313 |
| Duration | 540s | 487s |
| Agent calls | 4 | 4 |
| Graph nodes / turns | 6 | 4 |
| Retries | 0 | 0 |
| Review loops | 0 | 0 |
| Replans | 0 | 0 |
| Context retrievals | 0 | N/A |
| Context compactions | 5 | N/A |
| HSC overhead tokens | 13,285 | N/A |
| Acceptance criteria passed | 7/7 | 7/7 |
| Tests passed / failed | 41 / 0 | 44 / 0 |
| Blind review score (0-10) | 8.3 (15 findings, as "B") | 8.5 (14 findings, as "A") |
| Review findings raised | 0 | 0 |
| Status | completed | completed |

## Derived context-efficiency metrics

| Metric | Value | Definition |
|---|---|---|
| Context reduction (peak) | 29.1% | 1 − governed peak / control peak |
| Context reduction (avg) | 49.1% | 1 − governed avg / control avg |
| Lifecycle token reduction | 17.6% | 1 − governed lifecycle / control lifecycle |
| Cost reduction | -7.2% | 1 − governed cost / control cost |
| Duration reduction | -10.7% | 1 − governed elapsed / control elapsed |
| Tokens saved | 325,486 | control − governed lifecycle tokens (negative = Geppetto cost more) |
| HSC overhead / tokens saved | 0.041 | tokens spent maintaining state ÷ tokens saved |
| Retrieval overhead | 0 tokens over 0 calls | context pulled back because it was omitted from L0 |
| Compaction ratio | 13.25× | Σ pre-compaction / Σ post-compaction |
| Handoff efficiency | 82.9% | avg compiled / available per agent node (lower = more context left out) |
| Quality Δ (criteria) | 0 | governed − control criteria passed |
| Quality Δ (blind score) | -0.1999999999999993 | governed − control blind score |

## Active context by task (tokens the model attended to per invocation)

### Geppetto (governed)
```
plan                   █████████████    35,330  (compiled 4,123, avail 4,123, out 7,719, claude-opus-5)
implement:ledger-csv   ██████████    28,191  (compiled 7,152, avail 7,424, out 9,856, claude-opus-5)
implement:registry     ██████████████████    49,217  (compiled 8,612, avail 8,884, out 20,467, claude-opus-5)
test                   ▏         0  (compiled 0, avail 8,517, out 0, none)
review                 █████████████████████    57,708  (compiled 6,620, avail 17,332, out 15,241, claude-opus-5)
```

### Long agent (control)
```
plan                   █████████████████████    57,836  (compiled 57,836, avail 57,836, out 25,433, claude-opus-5)
implement              ███████████████████████    62,779  (compiled 62,779, avail 62,779, out 2,256, claude-opus-5)
test                   ████████████████████████    65,710  (compiled 65,710, avail 65,710, out 766, claude-opus-5)
review                 ██████████████████████████████    81,355  (compiled 81,355, avail 81,355, out 12,774, claude-opus-5)
```

## Cumulative lifecycle tokens over time

### Geppetto

| Step | Active context | Cumulative tokens |
|---|---|---|
| plan | 35,330 | 108,674 |
| implement:ledger-csv | 28,191 | 300,455 |
| implement:registry | 49,217 | 1,052,760 |
| test | 0 | 1,052,760 |
| review | 57,708 | 1,518,970 |

### Long agent

| Step | Active context | Cumulative tokens |
|---|---|---|
| plan | 57,836 | 638,895 |
| implement | 62,779 | 885,471 |
| test | 65,710 | 1,015,934 |
| review | 81,355 | 1,844,456 |

## Agent / model distribution

### Geppetto
- planning-architect-01 @ claude-opus-5: 1 call(s)
- implementation-engineer-03 @ claude-opus-5: 1 call(s)
- implementation-engineer-02 @ claude-opus-5: 1 call(s)
- test-runner @ none: 1 call(s)
- independent-reviewer-04 @ claude-opus-5: 1 call(s)

### Long agent
- monolith @ claude-opus-5: 4 call(s)

## Routing decisions (governed)

| Node | Requirements | Selected | Reasons |
|---|---|---|---|
| plan | {"complexity":"medium","reasoning":"high","independence":false} | opus (high) | complexity=medium, reasoning=high → strongest tier |
| implement:registry | {"complexity":"high","reasoning":"high","independence":false} | opus (high) | complexity=high, reasoning=high → strongest tier |
| implement:ledger-csv | {"complexity":"high","reasoning":"high","independence":false} | opus (high) | complexity=high, reasoning=high → strongest tier |
| review | {"complexity":"medium","reasoning":"high","independence":true} | opus (high) | complexity=medium, reasoning=high → strongest tier |

## Compaction events (governed)

| Node | Trigger | Pre | Post | Ratio | L2 ref |
|---|---|---|---|---|---|
| plan | agent handoff (large output) | 1,939 | 130 | 14.92× | h1 |
| implement:ledger-csv | agent handoff (large output) | 946 | 130 | 7.28× | h2 |
| implement:registry | agent handoff (large output) | 1,334 | 130 | 10.26× | h3 |
| test | large tool output | 874 | 144 | 6.07× | h4 |
| review | large tool output | 8,323 | 475 | 17.52× | h5 |
| review | agent handoff (large output) | 1,677 | 130 | 12.9× | h6 |

## Compiled context packets (governed)

- **plan**: 4,123 tokens injected of 4,123 available (0 items left out) — task:406, handoff:56, hsc:constraint+decision+fact:233, file:package.json:130, file:src/cli.ts:896, file:src/ledger.ts:625, file:src/trace.ts:317, file:src/types.ts:1351, file:tsconfig.json:108
- **implement:registry**: 8,612 tokens injected of 8,884 available (0 items left out) — task:406, handoff:1392, hsc:constraint+decision+artifact:1278, output:plan:593, file:src/cli.ts:896, file:src/factory.ts:1486, file:src/ledger.ts:625, file:src/trace.ts:317, file:src/types.ts:1618
- **implement:ledger-csv**: 7,152 tokens injected of 7,424 available (0 items left out) — task:406, handoff:1393, hsc:constraint+decision+artifact:1278, output:plan:593, file:src/ledger.ts:625, file:src/types.ts:2857
- **review**: 6,620 tokens injected of 17,332 available (0 items left out) — task:406, handoff:2255, hsc:constraint+decision+assumption:2247, output:test:154, output:implement:registry:583, output:implement:ledger-csv:484, diff:491

## Quality

### Geppetto

- [x] file exists: src/registry.ts
- [x] file exists: src/ledger-csv.ts
- [x] file exists: tests/registry.test.ts
- [x] file exists: tests/ledger-csv.test.ts
- [x] src/cli.ts matches /registry/
- [x] all tests pass (existing + new) (exit 0, pass 41 fail 0)
- [x] repo typechecks (exit 0)

Blind review (claude-haiku-4-5-20251001, saw only "Artifact B"): score 8.3
- Both required files (src/registry.ts, src/ledger-csv.ts) and both test files exist, matching acceptance-criteria file-exists checks.
- CLI wiring for `registry --runs <dir> [--out registry.json]` is implemented cleanly, reuses SpecialistRegistry.findRunDirs and prints reg.table(); USAGE string updated. Matches spec.
- SpecialistRegistry correctly derives success rate strictly from node.completed vs node.failed trace events joined by node_id, and invocation/cost/token stats from ledger rows joined by agent_id — matches the spec's join semantics.
- Promotion thresholds (>=3 invocations, >=0.8 success rate) are implemented as static constants and used consistently in candidates(); there is no code path that writes back to agents.json or mutates agent definitions — satisfies the 'suggestions only, never auto-promote' constraint.
- save()/load() round-trip is implemented and tested, including continuing to ingest more runs after a load — good coverage of a tricky feature.
- Idempotent ingestion (ingestedSet keyed by resolved path) prevents double-counting when the same run directory is ingested twice; covered by a dedicated test.
- findRunDirs correctly stops descending once it finds agents.json in a directory (avoiding false positives from nested workspace/agents.json), which is tested directly.
- ledger-csv.ts uses a `satisfies readonly (keyof ContextLedgerEntry)[]` constraint plus a compile-time `Exclude<...> -> never` check to guard that LEDGER_COLUMNS exactly matches the ContextLedgerEntry key set in both directions (no missing, no extra keys) — a nice defensive compile-time guard given the 'additive exports only' constraint on types.ts.
- csvEscape correctly implements RFC 4180 quoting for commas, quotes, and newlines/CRLF, doubling embedded quotes; tests include a round-trip through a hand-rolled minimal CSV parser, which is a strong verification approach beyond simple string matching.
- Minor fragility: the ledger-csv test asserting 'header covers every ContextLedgerEntry key exactly once, in declaration order' depends on the fixture object literal's key order matching the real interface's declaration order in types.ts, which isn't visible in this diff — if wrong, both the constant and the test would be self-consistently wrong without being caught.
- Minor semantic inconsistency: RoleStats.runs is populated both from agents.json entries (every run where the role appears, regardless of actual invocations) and from ledger rows, meaning 'runs' can include runs with zero recorded invocations for that role — not harmful to correctness of success_rate/candidates, but slightly blurs the meaning of the 'runs' field.
- roleByNode is a last-write-wins map keyed by node_id; if a workflow ever reused the same node_id for agents of different roles across attempts, trace-based success attribution could mis-assign — unlikely given typical orchestrator semantics but not defensively guarded or commented on.
- Test suite is notably thorough: covers aggregation math, threshold edge cases (exactly-2 invocations, 50% success with many invocations), malformed JSONL tolerance, missing agents.json error path, table rendering, and an end-to-end integration test against a real Orchestrator run — good test quality and confidence.
- Cannot directly execute `node --test` or `tsc --noEmit` in this review to empirically confirm the acceptance-criteria commands pass; assessment is based on careful static reading of the diff only.
- Code style is consistent with described constraints (erasable-syntax TypeScript, no enums/parameter properties, no new dependencies, Node built-ins only) and diffs appear minimal/additive as required.

### Long agent

- [x] file exists: src/registry.ts
- [x] file exists: src/ledger-csv.ts
- [x] file exists: tests/registry.test.ts
- [x] file exists: tests/ledger-csv.test.ts
- [x] src/cli.ts matches /registry/
- [x] all tests pass (existing + new) (exit 0, pass 44 fail 0)
- [x] repo typechecks (exit 0)

Blind review (claude-sonnet-5, saw only "Artifact A"): score 8.5
- Both required files (src/registry.ts, src/ledger-csv.ts) and both test files exist; cli.ts is wired with a `registry --runs <dir> [--out registry.json]` subcommand, satisfying the file/pattern acceptance checks.
- registry.ts correctly separates invocation counting (from ledger rows) from node outcome counting (from node.completed/node.failed trace events), matching the spec's success-rate definition; node.started and other event types are correctly ignored.
- Promotion thresholds (>=3 invocations, >=0.8 success rate) are enforced as documented constants and boundary cases (exactly 3/0.8, 2 invocations, 0.75 success) are covered by dedicated tests.
- The registry never mutates agent definitions (read-only fs access via readFileSync only) and there is no auto-promotion API - candidates() only returns suggestions with a human-readable reason string; a test explicitly asserts no `promote` method exists and that agents.json is untouched after ingestion.
- save()/load() round-trip is implemented via toJSON()/fromJSON() and re-derives success_rate/means from the persisted totals rather than persisting derived-only values, which is a sound design for reload correctness; tests verify round-trip equality and correct de-duplication of previously-ingested run ids.
- ledger-csv.ts uses a hand-maintained LEDGER_COLUMNS tuple paired with a compile-time exhaustiveness check (Exclude<keyof ContextLedgerEntry, ...> extends never) so the code fails to typecheck if types.ts's ContextLedgerEntry gains/renames a field without updating the column list - a nice defensive technique.
- CSV escaping follows RFC4180 (quote on comma/quote/CRLF, double inner quotes) and is verified both by direct assertions and by a hand-rolled round-trip parser in tests, including a real ledger.jsonl produced by an actual Orchestrator run.
- Diff is additive-only as required: no changes to orchestrator.ts, ledger.ts, or types.ts; cli.ts changes are minimal (one new option, one new branch, one import, one USAGE line).
- No new runtime dependencies introduced; code relies only on node:fs, node:path built-ins, consistent with the Node 24 built-ins constraint.
- Minor: RunAgent is typed as `Pick<AgentDefinition, ...> & Partial<AgentDefinition>`, which is a slightly redundant/confusing way to express 'these three fields required, rest optional' (Pick's required fields already dominate the intersection) - works but could be clearer, e.g. a dedicated interface.
- Minor: roleByNode mapping is last-write-wins per run when multiple agents share the same node_id (e.g., retries with a different agent), which could misattribute node-level outcomes to the wrong role in that edge case; not covered by a test and not called out as a known limitation in comments.
- Minor: CLI's `registry` command silently defaults --runs to "runs" and does not validate that the resolved root exists before calling ingestRoot; behavior for a nonexistent root is handled gracefully via findRunDirs' existsSync guard and is tested, so this is only a documentation nitpick.
- Test suite is large and thorough (unit-level aggregation, trace-derived success rate, boundary conditions, persistence, CLI subprocess invocation, integration with a real Orchestrator run, and negative/edge cases like missing agents.json), which meaningfully exercises the acceptance criteria beyond superficial happy-path checks.
- Cannot execute `node --test` or `tsc --noEmit` in this review to empirically confirm the acceptance commands pass; assessment is based on careful static reading of the diff and cross-referencing with the described existing types/orchestrator behavior, which appears internally consistent.

## Measurement notes

- Token counts: some rows are heuristic estimates (chars/4) — see `tokens_estimated` in the ledgers. Compiled/available packet sizes are always chars/4 estimates.
- Active context = input + cache_read + cache_write of the largest API round-trip inside an invocation. Lifecycle tokens sum every round-trip, so cached prefixes are counted each time they are re-read (that is what the provider bills and what the model attends to).
- The control's per-turn "available" and "compiled" context are equal by construction: a monolithic session injects everything it has.
- Blind review labels (A/B) were assigned randomly per experiment; the evaluator never saw the mode.
