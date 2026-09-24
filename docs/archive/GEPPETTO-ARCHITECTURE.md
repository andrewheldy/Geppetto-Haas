# Geppetto MVP — Architecture (as built)

Geppetto is a model-agnostic, governed agent harness. This document describes what exists in `src/` today, not an aspiration.
Everything under `src/` was built **pre-Geppetto (bootstrap)** by a conventional single agent session. See `docs/EXPERIMENT-001.md` for what is governed.

## Pipeline

```
Task ──► HSC (L1, from task) ──► Planner ──► Graph ──► [per node]
   Context Governor ─ handoff ─► Context Compiler ─► L0 packet
   Capability analysis ─► Agent Factory (prompt + tool resolver) ─► Model Router
   RuntimeAdapter.invoke ─► (need_context? ─► Governor.rehydrate ─► re-invoke)
   raw output ─► L2 (history) + compaction ─► candidate HSC entries ─► validate ─► promote / reject
   ledger row + trace events ─► next ready node(s)
```

| Concern | Module | Notes |
|---|---|---|
| Contracts | `src/types.ts` | Task, Graph/GraphNode, HSCState/Entry, CapabilitySpec, AgentDefinition, ContextPacket, ModelRoute, TraceEvent, ContextLedgerEntry, EvaluationResult, WorkflowSummary. Runtime-neutral. |
| Planner | `src/planner.ts` | Deterministic template: PLAN → IMPLEMENT (fan-out per subtask) → TEST (deterministic join) → REVIEW (independent) → [PATCH → TEST → REVIEW]×N → HUMAN GATE. `expandLoop` and `replan` mutate the graph at runtime; both bounded. |
| Orchestrator | `src/orchestrator.ts` | Ready-set scheduler (sequential, parallel batches via `Promise.all`, joins, conditions), retries with model escalation, replanning, budgets, candidate→promoted state, per-node ledger rows, every trace event. |
| HSC (L1) | `src/hsc.ts` | Structured entries with kind/status/confidence/ttl/provenance. Candidate by default; promotion, rejection, supersession, deterministic decay, keyed conflict detection and evidence-based resolution. Never deletes. |
| Historical store (L2) | `src/history.ts` | Append-only JSONL; keyword search; never auto-injected. |
| Context Governor | `src/governor.ts` | Admission (relevance + budget), classification-based compaction (raw kept in L2), rehydration (smallest slice, traced), decay/conflict pass, handoff packets. Separate from the orchestrator by design. |
| Context Compiler | `src/compiler.ts` | Node requirements → task / HSC slice / prior node outputs / files / history → measured packet (`tokens`, `available_tokens`, `discarded_tokens`, per-section provenance). |
| Agent Factory | `src/factory.ts` | Capability analysis → role, modular prompt, least-privilege tools, ephemeral lifecycle. Output contract is a JSON schema (summary, verdict, findings, decisions, assumptions, questions, files_changed, need_context). |
| Router | `src/router.ts` | Deterministic rules with recorded reasons; escalation on retry; caps/overrides for cheap dry-runs. |
| Runtime | `src/runtime.ts` | `RuntimeAdapter` interface. `MockRuntime` (scriptable, simulates session accumulation). `ClaudeCliRuntime` runs `claude -p --output-format json` per invocation and reads provider-reported usage, per-round-trip usage and cost. Control mode reuses one session via `--resume`. |
| Evaluator | `src/evaluator.ts` | Deterministic acceptance checks (files, commands, test counts) shared by both modes; blind LLM review sees only "Artifact A/B" + diff. |
| Control | `src/control.ts` | MODE B: one agent, one accumulating session, same phases as user turns, same tools, no HSC/compilation/isolation. |
| Experiment | `src/experiment.ts` | Isolated workspace per mode (repo copy + git baseline), runs modes, evaluates, computes comparison metrics, writes `report.md`. |
| Report | `src/report.ts` | Markdown: headline table, derived metrics, context bars per step, cumulative tokens, routing/compaction/retrieval/replan tables, quality. |
| Telemetry | `src/trace.ts`, `src/ledger.ts`, `src/tokens.ts` | JSONL trace with correlation ids; context ledger per invocation; chars/4 estimator + list-price cost table (provider numbers override when present). |

## Three-tier context model

- **L0** — the compiled packet handed to one agent (`ContextPacket`). Disposable; rebuilt per node.
- **L1** — HSC canonical state (`hsc.json`). Continuity across nodes/agents/models.
- **L2** — historical store (`history.jsonl`): raw outputs, tool outputs, failures, superseded entries. Searchable, never auto-injected.

## Invariants (enforced in code, not prose)

- State ≠ transcript: HSC entries are structured; the transcript lives in L2.
- Agent output ≠ canonical truth: entries enter as `candidate`; `state.promoted` / `state.rejected` is traced.
- Compaction ≠ deletion: `ContextGovernor.compact` appends the raw source to L2 before summarizing.
- Routing ≠ guessing: every `model.routed` event lists candidates, the selection and reasons.
- Independent review: review/plan/diagnose nodes never receive write tools (`resolveTools`).
- Loops are bounded: `loop_policy.max_iterations`, `retry_policy.max_retries`, ≤2 replans, task budgets (usd/tokens/seconds).
- Runtime is replaceable: nothing outside `src/runtime.ts` knows about the Claude CLI.

## Artifacts per run

```
runs/<experiment>/<mode>/
  workspace/        isolated repo copy the agents edit (git baseline commit)
  trace.jsonl       every event with experiment→workflow→graph→node→agent→invocation ids
  ledger.jsonl      one row per invocation (context accounting)
  history.jsonl     L2
  hsc.json          L1 (governed only)
  graph.json        final graph incl. expanded loops/replans (governed only)
  agents.json       every JIT specialist created (governed only)
  invocations/      raw runtime request/response per call (claude runtime)
  evaluation.json   deterministic + blind evaluation
  diff.patch        what the agents changed
  summary.json
runs/<experiment>/report.md, summary.json, task.json
```

## Deliberately not built (yet)

Learned routing, vector retrieval, a graph database, a dashboard, registered-specialist promotion (interface only via `lifecycle`), Ruflo adapter (the `RuntimeAdapter` seam is where it goes).
