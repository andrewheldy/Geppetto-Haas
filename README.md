# Geppetto MVP — governed agent harness + Experiment 001

Geppetto is a model-agnostic harness that turns a task into an execution graph, builds specialists just in time, compiles the minimum context each one needs, keeps canonical state in HSC, and measures every token along the way. This repository is both the harness and its first experiment: **does governed, context-minimal multi-agent execution use less lifecycle context than one long-running agent, at equal quality?**

The hypothesis is not assumed. The system is instrumented so the traces answer it.

```
Task → HSC → Planner → Graph → [Capability analysis → Agent Factory → Context Compiler → Router → Runtime]
     → Evaluation → State promotion / rejection → Context Governor → next node → Result
```

## Quick start

```bash
npm install                     # typescript for typecheck only; zero runtime deps (Node ≥ 24)
npm test                        # 22 tests on the mock runtime
npm run typecheck

node src/cli.ts experiment --task tasks/smoke.json --runtime mock             # dry run, no model calls
node src/cli.ts run --task tasks/smoke.json --runtime claude --cap haiku      # governed run on the Claude CLI runtime
node src/cli.ts experiment --task tasks/exp001-registry.json --runtime claude --blind-model sonnet
node src/cli.ts report --dir runs/<experiment-id>
```

The real runtime is the Claude Code CLI in headless mode (`claude -p --output-format json`); it reports provider token usage and cost per call. No API key handling lives in this repo. Everything runtime-specific sits behind `RuntimeAdapter` in `src/runtime.ts`.

## What is here

- `src/` — the harness (see `docs/GEPPETTO-ARCHITECTURE.md` for the module map and invariants)
- `tests/` — behaviour tests: HSC promotion/conflict/decay, compaction, rehydration, planner loops/replans, router reasons, orchestrator scenarios, control accumulation, end-to-end experiment
- `tasks/` — task definitions (`smoke.json`, `exp001-registry.json`)
- `docs/EXPERIMENT-001.md` — protocol, metrics, governance labels, caveats
- `docs/RESULTS-001.md` — what the traces said (written after the run)
- `runs/` — run artifacts (symlinked to `runs.nosync/` so iCloud leaves them alone); experiment reports are copied into `docs/results/`
- `docs/ARCHITECTURE.md`, `docs/MVP-SPEC.md`, … — the original HeldyOS JIT planning documents this MVP grew out of; `src/legacy-*.ts` keep the earlier contracts

## Governance labels

The harness itself was written **pre-Geppetto (bootstrap)**. Only tasks executed through `node src/cli.ts experiment|run` are governed, and each run's `summary.json` says so (`governance: full | bootstrap`). Bootstrap work is never reported as a Geppetto measurement.
