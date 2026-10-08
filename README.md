# Geppetto-Haas

Suspend your AI agents inside a task-aware harness that manages context, memory, tools, and state—preserving continuity as work moves across agents and between organizations.

## What Geppetto is

Geppetto is a small, local project-state layer for developers who already use AI coding agents. It keeps what your project **accepts as true** (purpose, architecture, constraints, decisions) as plain Markdown in Git. For each task it compiles a **short, task-specific working context** that any agent can read. After the task it records what happened and what the agent *proposes* to change about that knowledge, and it lets a human approve, reject, edit or defer each proposal. The next task, in any agent, starts from the updated accepted state. It doesn't need the previous agent's chat history.

The coding agent is replaceable. The project's accepted knowledge persists.

## What Geppetto is not

It is not a coding agent and not a replacement for Claude Code, Codex, OpenCode, Cursor or Gemini CLI. It is also not an IDE, an autonomous software engineer, a model provider or gateway, or an orchestration framework. Geppetto never runs a model, calls an API or executes agent tools. Your agent keeps its own runtime, tools and sandbox. Geppetto only prepares the context it reads and records the handoff it writes.

## Install

Requirements: Node.js ≥ 24 (it runs the TypeScript sources directly) and Git. There are no runtime dependencies, accounts, API keys, databases or services.

```bash
git clone <this repo> geppetto && cd geppetto
npm install -g .          # puts `geppetto` on your PATH (or: npm link)

cd ~/code/my-project
geppetto init
```

Without a global install, `node /path/to/geppetto/src/cli.ts <command>` works the same.

## Workflow

```bash
geppetto init                                   # creates .geppetto/; never touches CLAUDE.md, AGENTS.md, ...
$EDITOR .geppetto/context/*.md                  # write down what the project accepts as true (canonical state)

geppetto task "Improve adapter detection"       # → .geppetto/generated/context.md (+ a handoff template)
# point your agent at the context, any way you like:
#   - Claude Code: `geppetto adapter install claude` once; CLAUDE.md then imports the current context
#   - Codex / OpenCode: `geppetto adapter install agents` once; AGENTS.md then points to it
#   - anything else: `geppetto task "..." --print | <agent>` or just tell it to read the file
# ...the agent does the work, then fills in the handoff template the context names...

geppetto capture .geppetto/generated/handoff-improve-adapter-detection.md
#   → .geppetto/runs/r-0001-….md          (what happened: episodic, evidence only)
#   → .geppetto/candidates/c-0001-….md    (proposed knowledge changes: pending, NOT canonical)

geppetto reconcile                              # review; approve / reject / defer / edit each candidate
geppetto task "Add a Cursor adapter"            # the next task starts from the updated accepted state

geppetto status                                 # everything at a glance
geppetto clean                                  # delete derived output; canonical state is untouched
```

`geppetto reconcile` is interactive on a terminal. In scripts, use `geppetto reconcile approve|reject|defer|show|edit <id> [--by name] [--note text]`.

## Four kinds of information, kept apart

| Where | Type | What it is | Git |
|---|---|---|---|
| `.geppetto/context/*.md` | **Canonical state** | What the project currently accepts as true. Changed only by a human editing it or by approving a candidate. | tracked |
| `.geppetto/runs/*.md` | **Episodic memory** | What happened in each captured run: summary, discoveries, failed approaches. Evidence that may be stale; never presented as truth. | tracked |
| `.geppetto/candidates/*.md` | **Candidate state** | Proposed changes to canonical state, with provenance (run, task, target, base hash) and review status. | tracked |
| `.geppetto/generated/` | **Working context** (derived) | The per-task context and handoff templates. Disposable and rebuilt on demand. | ignored |

The compiled context keeps these apart too. Accepted state appears under "Accepted project state", past runs under "Historical evidence (not accepted truth; may be stale)", and pending candidates only by title under "Pending proposals (NOT accepted)".

## Architecture

```text
 .geppetto/context (canonical, Markdown + Git)       .geppetto/runs (episodic)     repo signals (git)
                 │                                          │                           │
                 └──────────────► select.ts ◄───────────────┴───────────────────────────┘
                                  (deterministic, budgeted)
                                      │
                                  render.ts  → .geppetto/generated/context.md  (working context)
                                      │            └─ adapters: CLAUDE.md import / AGENTS.md pointer (managed blocks)
                                      ▼
                          your coding agent does the task
                                      │ fills handoff
                                  capture.ts → runs/ (episodic)  +  candidates/ (pending)
                                      │
                                reconcile.ts  — human approves; stale/conflict checks
                                      ▼
                           .geppetto/context (canonical)
```

HSC (Hybrid-State-Context) is the name for these boundaries. It is not a separate framework or runtime. Details, file formats and design decisions are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### File formats in one glance

A canonical file is ordinary Markdown. Each `## ` section is one unit of knowledge, addressable as `file.md#github-style-anchor`, which works as a link on GitHub, in VS Code and in Obsidian. Optional lines inside a section declare relationships that selection uses:

```markdown
---
include: always          # optional: always give this file to agents (use for short constraints)
---
# Architecture

## Adapters
Tags: adapters, cursor
Paths: src/adapters.ts
Adapters are renderers ...
```

A handoff has sections for `## Summary`, `## Discoveries`, `## Failed approaches`, `## Files changed` and `## Proposed changes`. Each proposal is a block like this:

```markdown
### Proposal: Rules-directory agents need Geppetto-owned files
- op: add                       # add | replace | remove
- target: architecture.md       # replace/remove: architecture.md#anchor
- heading: Rules-directory agents
- why: one line

Section content (Markdown, no # or ## headings).
```

## Protecting your configuration

`init` only creates files under `.geppetto/`. Existing `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Copilot, Cursor, Windsurf, Cline and OpenCode files are detected read-only. Single instruction files are offered as *candidates* to import, so nothing enters canonical state unreviewed. `geppetto adapter install claude|agents` adds one block delimited by `<!-- geppetto:begin … -->` / `<!-- geppetto:end -->`. `geppetto adapter remove` deletes exactly that block and restores the file byte-for-byte; if Geppetto created the file, it is deleted. Removing Geppetto entirely means removing any installed adapter block and then `.geppetto/`.

## Claude Code routing mod

`plugins/geppetto` is a Claude Code mod that picks the model (and, for exploration, the read-only agent) for each subagent Claude Code spawns. It uses a deterministic, explainable policy: exploration goes to Haiku, implementation to Sonnet, architecture to Opus, and escalation happens only on failure evidence. Explicit choices, pinned agents and permissions are never overridden. It starts in observe mode and fails open to native behavior.

```
/plugin install geppetto --marketplace andrewheldy/geppetto-haas
```

The routing core (`plugins/geppetto/core`) is dependency-free TypeScript shared with the lab orchestrator's router. Install and usage: [plugins/geppetto/README.md](plugins/geppetto/README.md). Design and measured results: [docs/ROUTING.md](docs/ROUTING.md).

## V0.1 status

**Implemented and tested:** `init` (idempotent, detects 15 agent file locations, imports instruction files as candidates), `task` (deterministic selection, token budget with explicit overflow warning, generic Markdown output), `capture` (validated all-or-nothing), `reconcile` (approve/reject/defer/edit, stale and conflict refusal, path-traversal refusal), `status`, `clean`, and the `claude` and `agents` adapters. 40 tests: 17 for the core, including an end-to-end CLI loop, plus 23 for the lab.

**Partial:**
- Selection is keyword/tag/path overlap (6-character stems, a small stop-word list). It misses synonyms and can match loosely related sections.
- Token counts are chars/4 estimates.
- Rules-directory agents (Cursor, Windsurf, Cline, Copilot path instructions) are detected but get no native rendering yet. Point them at `.geppetto/generated/context.md`.
- Only one working context exists at a time (`generated/context.md` is the one the adapters reference).
- A proposal cannot target a file's preamble (text before the first `##`).

**Not built (ideas, not features):** derived indexes (graph, search, embeddings) and a `rebuild-index` command, semantic retrieval, transcript ingestion or agent hooks for automatic capture, and multi-user review. There is no measurement yet of whether Geppetto improves agent outcomes; see [docs/EVALUATION.md](docs/EVALUATION.md) for how that will be tested.

## Dogfooding

Geppetto V0.1 was developed partly with itself. The first real task ("Improve adapter detection") went through the full loop; see [docs/DOGFOOD-V0.1.md](docs/DOGFOOD-V0.1.md) for the actual commands, context sizes, candidates and continuity check. This repository's own `.geppetto/` is the live state from that run. Its candidates are still pending human review.

## The lab (Experiment 001)

Before V0.1, this repository was a governed multi-agent orchestration rig (planner, router, orchestrator, runtime adapters) built to test whether selective context reduces lifecycle tokens. It is preserved, unchanged in behaviour, under `src/lab/` and is reachable with `geppetto lab <command>`. It is not part of the Geppetto core loop. Results: [docs/EXPERIMENT-001.md](docs/EXPERIMENT-001.md). Superseded planning documents: [docs/archive/](docs/archive/).

## Development

```bash
npm test            # node:test — core (tests/*.test.ts) and lab (tests/lab/)
npm run typecheck   # needs `npm install` for typescript
```
