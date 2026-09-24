# Geppetto V0.1 — Architecture

This document describes the V0.1 code as it exists. For usage, see the [README](../README.md).

## The loop

```text
canonical state ──► context compiler ──► working context ──► coding agent (theirs, unchanged)
      ▲                (select → render → budget)                     │
      │                                                               ▼ handoff (Markdown)
reconciliation ◄── candidate state ◄──────────── capture ──► episodic run record
 (human review)
```

HSC (Hybrid-State-Context) names these boundaries: canonical → selection → working context → execution → episodic result → candidate → reconciliation → canonical. It is a model, not a runtime. In the code it is simply "which directory a fact lives in, and which module may write there".

| Boundary | Module | Writes |
|---|---|---|
| canonical → working context | `compile.ts` = `select.ts` + `render.ts` (+ `repo.ts` for Git signals) | `generated/` only |
| execution | the user's agent | the user's code, plus a handoff file |
| execution → episodic + candidate | `capture.ts` | `runs/`, `candidates/` |
| candidate → canonical | `reconcile.ts` | `context/` (the **only** writer), candidate review fields |
| bootstrap | `init.ts` | missing files under `.geppetto/` only; import candidates |
| agent wiring | `adapters.ts` | one delimited block in `CLAUDE.md` / `AGENTS.md` |

About 1,250 lines of TypeScript with no runtime dependencies. `markdown.ts` holds the frontmatter/section primitives and `state.ts` holds the layout and loaders.

## Source of truth vs derived

```text
            .geppetto/context/*.md  +  Git history          ← SOURCE OF TRUTH (canonical)
            .geppetto/runs/, candidates/                    ← authoritative for what they are (history, proposals), never for project truth
                         │
                         ▼  derived, disposable, rebuildable
            .geppetto/generated/  (working context, handoff templates)
            [future] graph / search index / embeddings      ← not built
```

`geppetto clean` deletes all derived output. Tests assert that canonical, episodic and candidate files are byte-identical afterwards and that regenerated context is byte-identical to the original. A future `geppetto rebuild-index` would write under `generated/` or another ignored directory and would never be read back as truth.

## Formats

All state is Markdown with a deliberately small frontmatter subset (`key: value`, `key: [a, b]`, `#` comment lines). It is readable in any editor, on GitHub, and in Obsidian. No Obsidian-only syntax is required.

**Canonical files** (`context/*.md`). Each file is split on `## ` headings, ignoring code fences and HTML comments. A section's id is `file.md#anchor` with GitHub-style anchors, so the id doubles as a portable Markdown link. Text before the first `##` is the file's preamble and is selectable but not targetable. File frontmatter `include: always` marks every section as essential, and `tags: [...]` applies tags to every section. Optional in-section lines `Tags: a, b` and `Paths: src/x.ts` are explicit relationships. HTML comments hold editing guidance and are never shown to agents.

**Run records** (`runs/r-NNNN-slug.md`). Frontmatter has `id`, `task`, `date`, `outcome`, `agent` and `candidates`. The body is the captured handoff with comments stripped.

**Candidates** (`candidates/c-NNNN-slug.md`). Frontmatter:
- `id`, `status` (pending | approved | rejected | deferred)
- `op` (add | replace | remove), `target` (`file.md` for add, `file.md#anchor` otherwise), `heading`
- `base`: hash of the target section when proposed, or `absent`
- `content_hash`, used to detect edits
- `run`, `task`, `created`, and after review `reviewed_by`, `reviewed`, `review_note`, `applied`

The body has `# Title`, `## Why`, and `## Proposed content`. Everything after the content heading is the content, verbatim.

## Context compiler

**Selection** (`select.ts`) is pure and deterministic. For each task term (lowercased word of at least 3 characters, minus stop-words, stemmed to 6 characters), a section scores heading ×3, tags ×2 and body ×1. A section `Paths:` entry named in the task adds +4 each. Uncommitted changes under a section's paths add +1 once, so a dirty tree cannot flood the context (a dogfood finding). The threshold is 2. The budget (default 2,000 estimated tokens, `--budget`) is spent in priority order:

1. `include: always` sections. These are never dropped. If they alone exceed the budget, they are still included and the output carries a **Budget warning**.
2. Relevant canonical sections, highest score first, up to 10.
3. Relevant run records, up to 3, labelled as historical evidence.
4. Titles of relevant pending or deferred candidates, up to 3, labelled NOT accepted. Their content is never shown.

Repository signals (paths named in the task, paths matching task terms, uncommitted changes) are capped by count. Anything relevant that didn't fit is listed under "Not included" with its source path.

**Rendering** (`render.ts`) produces Markdown with a source path on every item and no timestamps, so identical state gives byte-identical output. `fitToBudget` re-renders while the output exceeds the budget, dropping the lowest-priority optional item each time. Replacing retrieval (graph distance, embeddings, recency) means replacing `select.ts` behind the same `Selection` shape.

## Reconciliation safety

- **Only `approve` writes canonical state.** It works from the candidate file as it is now, so edits are honoured, but editing never changes status. Approving an edited candidate records `edited_before_approval`.
- **Stale:** for replace/remove, if the target section's current hash ≠ `base`, approval is refused with both hashes. The candidate stays pending.
- **Conflict:** for add, if the heading already exists in the target file, approval is refused.
- **Containment:** targets must be plain `.md` files directly inside `context/`. `../` is refused both at capture and at approval.
- **Fail-safe input:** capture validates the whole handoff (frontmatter, required summary, op/target shape, no `#`/`##` in content, targets exist) before writing anything. Writes go through temp file + rename.
- **Status** runs the same checks and shows `!! STALE` / `!! CONFLICT`, plus candidates that target the same section.

Known gap: canonical and candidate files are written by two separate renames, not in one transaction.

## Adapters

Adapters render; they are never a source of truth. The generic adapter is the file `.geppetto/generated/context.md`, which any agent can read. `claude` adds a managed block to `CLAUDE.md` containing `@.geppetto/generated/context.md`, which Claude Code resolves as an import. `agents` adds a block to `AGENTS.md` telling Codex, OpenCode and other AGENTS.md readers to read that file. Blocks are delimited by begin/end markers. Malformed or duplicated markers make Geppetto refuse rather than guess.

Detection (`AGENT_FILES`) recognises 15 paths. There are 9 single instruction files, which `init` imports as candidates. There are 3 rules directories (Cursor, Windsurf, Copilot path instructions; Cline when `.clinerules` is a folder), which are reported only. There are 3 config markers (OpenCode, Gemini), which are reported, with the adapter they already read where known.

## Toward a derived graph (not built)

The formats already contain what a graph builder would need, so one could be derived later without changing the source of truth:

| Graph element | Derived from |
|---|---|
| Concept / component / constraint / decision nodes | canonical sections (`file.md#anchor`); the file says which kind |
| File nodes, `AFFECTS` / `IMPLEMENTS` edges | `Paths:` lines |
| `RELATED_TO` edges | shared `Tags:`; relative Markdown links between sections |
| `SUPERSEDES` edges | `Supersedes:` lines in decisions |
| Task / Run nodes, `MODIFIED_BY` edges | run frontmatter + `## Files changed` |
| `DISCOVERED_IN` edges, proposal provenance | candidate `run`, `task`, `target` |

## KEEP / SIMPLIFY / DEFER (the V0.1 reduction)

The repository previously held a governed multi-agent harness: planner, agent factory, model router, orchestrator, context governor, runtime adapters, evaluator and experiment runner. It was built to run Experiment 001.

- **KEEP:** Node 24 running TypeScript directly with zero runtime dependencies; `node:test`; `tokens.ts`; the HSC principles that proved useful. Those principles are that agent output is not canonical truth (candidate → review → promote), history is never auto-injected, provenance travels with state, and keyword retrieval comes first.
- **SIMPLIFY:** HSC as JSON entries with statuses, TTLs and decay became canonical Markdown sections reviewed by humans. The L2 JSONL history became Markdown run records. The per-node packet compiler became one task-level select → render → budget pipeline.
- **DEFER:** everything that runs agents was moved unchanged to `src/lab/` (tests in `tests/lab/`, still passing) and is reachable only through `geppetto lab`. That covers the planner, factory, router, orchestrator, governor, control runner, Claude CLI runtime, evaluator, experiment runner, ledger and report. The old planning docs moved to `docs/archive/`. No Interviewer code existed in this repository.

## Audit (V0.1)

1. Another agent runtime? No. The core never invokes a model or agent (the lab does, off the core path).
2. An orchestration framework? No. There are no graphs, schedulers or workflows in the core.
3. A model gateway? No.
4. A database? No. It is files and Git.
5. One-paragraph explanation? Yes; see "What Geppetto is" in the README.
6. Install in minutes? `npm install -g .` then `geppetto init`, verified in a throwaway prefix.
7. Keep your agent? Yes. The output is a Markdown file, and the adapters are optional blocks.
8–10. Canonical, candidate, episodic and working context separate? Yes: separate directories, separate types (`CanonicalSection`, `Candidate`, `RunRecord`, `Selection`), separately labelled output sections, and tests that assert each separation.
11. Inspect what Geppetto changed? Yes. Everything is Markdown in Git, and approvals print the file to `git diff`.
12. Geppetto uses Geppetto? Yes, for one full loop; see [DOGFOOD-V0.1.md](DOGFOOD-V0.1.md).
13. Derived output gone and state intact? Yes, tested.
14. The four types distinguishable in code and docs? Yes.
15. Obsidian-style graph derivable without a format change? Yes, per the table above.
16. Speculative infrastructure? The lab is the one large leftover. It was kept for reproducibility and is isolated from the core. The core adds nothing that is not exercised by the loop.
