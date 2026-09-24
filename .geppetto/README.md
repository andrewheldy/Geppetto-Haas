# .geppetto — project state for coding agents

Managed by Geppetto (see the Geppetto README). Plain Markdown; edit with any editor, review with Git.

| Directory | Information type | Meaning | In Git? |
|---|---|---|---|
| `context/` | **canonical state** | What this project accepts as true. Edit intentionally; agents never write here directly. | yes |
| `runs/` | **episodic memory** | What happened in past agent runs. Evidence, may be stale, not truth. | yes |
| `candidates/` | **candidate state** | Proposed changes to `context/`, awaiting `geppetto reconcile`. | yes |
| `generated/` | **working context** (derived) | Per-task context and handoff templates. Disposable. | no |

Files in `context/` with `include: always` in their frontmatter are always given to agents; keep them short.
Other sections are selected per task by relevance. Optional lines inside a section help selection:
`Tags: adapters, cli` and `Paths: src/adapters.ts`.
