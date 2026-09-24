# Architecture
<!--
One "## " section per component or concept. Selected per task by relevance.
Optional lines help selection and future graph derivation:
Tags: adapters, cli
Paths: src/adapters.ts
-->

## Product loop
Tags: hsc, loop
canonical state → context compiler → working context → coding agent → handoff → run record (episodic) + candidates → `geppetto reconcile` → canonical state. HSC (Hybrid-State-Context) names these boundaries; it is not a separate framework.

## State store and file formats
Tags: state, storage, markdown
Paths: src/state.ts, src/markdown.ts
Everything is Markdown with a small frontmatter subset (`key: value`, `key: [a, b]`). Canonical files are split on `## ` headings; a section's stable id is `file.md#github-style-anchor`. Optional `Tags:` and `Paths:` lines in a section are explicit relationships used by selection (and later derivable into a graph). Files with `include: always` frontmatter are always given to agents. Derived output lives only in `.geppetto/generated/` (gitignored).

## Context compiler
Tags: context, compiler, selection, budget
Paths: src/select.ts, src/render.ts, src/compile.ts, src/repo.ts
Selection (`select.ts`, pure, deterministic keyword/tag/path scoring) is separate from rendering (`render.ts`). `compile.ts` loads state, selects, renders and enforces the token budget (default 2000, chars/4 estimate) by dropping lowest-priority optional items. Always-included sections are never dropped; overflow is reported. Git signals come from `repo.ts`.

## Capture and candidates
Tags: capture, handoff, candidates
Paths: src/capture.ts
An agent fills a handoff (Summary, Discoveries, Failed approaches, Files changed, Proposed changes). `geppetto capture` validates everything first, then writes one run record and one candidate per proposal (`op: add|replace|remove`, `target: file.md[#anchor]`, `base:` hash of the target section at proposal time).

## Reconciliation
Tags: reconcile, approve, stale, conflict
Paths: src/reconcile.ts
The only writer of canonical state. Approve checks for STALE (target changed since `base`) and CONFLICT (heading already exists) and refuses rather than overwriting. Reject and defer only change the candidate's review fields. Editing a candidate never changes its status.

## Adapters
Tags: adapters, agents, claude, codex, cursor, opencode
Paths: src/adapters.ts
Adapters are renderers. Generic output is `.geppetto/generated/context.md`, readable by any agent. `claude` adds a managed block importing it into CLAUDE.md; `agents` adds a managed block pointing to it in AGENTS.md. Blocks are delimited by `<!-- geppetto:begin ... -->` / `<!-- geppetto:end -->` and removable byte-for-byte. `detectAgents` finds existing agent instruction files (read-only).

## Lab (experiment rig)
Tags: lab, experiment, orchestration
Paths: src/lab/, tests/lab/, docs/EXPERIMENT-001.md
The pre-V0.1 governed-orchestration experiment (planner, router, orchestrator, runtime adapters). Kept for reproducibility of Experiment 001 via `geppetto lab`; not part of the core loop.
