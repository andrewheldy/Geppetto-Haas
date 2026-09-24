# Decisions
<!-- Decisions still in force, one "## " section each. Supersedes: lines are explicit relationships. -->

## D-001: Markdown + Git is the source of truth
Status: accepted · Date: 2026-09-24
Canonical state is human-readable Markdown in `.geppetto/context/`, versioned with Git. Any future graph, search index or embedding is derived from it, rebuildable, and never authoritative.

## D-002: Orchestration rig moved to lab
Status: accepted · Date: 2026-09-24
Supersedes: the pre-V0.1 "governed agent harness" framing (docs/archive/)
Geppetto V0.1 is a context/state layer beside existing agents. The planner/router/orchestrator/runtime code moved to `src/lab/` unchanged so Experiment 001 stays reproducible.

## D-003: Deterministic selection before smarter retrieval
Status: accepted · Date: 2026-09-24
Context selection is deterministic keyword/tag/path scoring with a token budget. Graph distance, embeddings or recency weighting may replace `select.ts` later, only when measured to help.
