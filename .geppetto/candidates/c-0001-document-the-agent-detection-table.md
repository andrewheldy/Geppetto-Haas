---
id: c-0001
status: pending
op: replace
target: "architecture.md#adapters"
heading: ""
base: ca31c7fdb87c
content_hash: 8598a31313bd
run: r-0001
task: Improve adapter detection
created: 2026-09-24
---

# Document the agent detection table

## Why

the Adapters section predates the detection table and says detection covers only "existing agent instruction files"

## Proposed content

Tags: adapters, agents, detection, claude, codex, cursor, opencode, gemini, copilot
Paths: src/adapters.ts
Adapters are renderers. Generic output is `.geppetto/generated/context.md`, readable by any agent. `claude` adds a managed block importing it into CLAUDE.md; `agents` adds a managed block pointing to it in AGENTS.md (read by Codex and OpenCode). Blocks are delimited by `<!-- geppetto:begin ... -->` / `<!-- geppetto:end -->` and removable byte-for-byte.
Detection is the `AGENT_FILES` table in `src/adapters.ts`: each entry has a path, an agent, a kind (`instructions` | `rules-dir` | `config`) and optionally `servedBy`, the adapter whose file that agent already reads. Detection is read-only. `init` imports only `instructions` files, as candidates.
