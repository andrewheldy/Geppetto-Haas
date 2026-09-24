---
include: always
---

# Project

## Purpose
<!-- One short paragraph: what this project is and who it is for. This file is always given to agents — keep it short. -->
Geppetto is a thin, local, portable project-state layer for developers who use existing coding agents (Claude Code, Codex, OpenCode, Cursor, Gemini CLI, ...). It keeps accepted project knowledge as Markdown in Git, compiles a small task-specific working context for whichever agent does the work, captures what happened, and lets a human reconcile proposed knowledge changes. It is not a coding agent, runtime, orchestrator or model gateway.

## Stack and commands
<!-- Detected by geppetto init; correct as needed. -->
- Package: `geppetto` — Geppetto: portable project state and task context for the coding agents you already use.
- Runtime: Node.js + TypeScript (engines.node >=24)
- Test: `npm run test` → `node --test tests/*.test.ts tests/lab/*.test.ts`
- Typecheck: `npm run typecheck` → `tsc --noEmit -p tsconfig.json`
