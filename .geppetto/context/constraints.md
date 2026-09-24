---
include: always
---
# Constraints
<!-- Rules every agent must follow. Always included in working context, so keep each one short. -->

## Canonical state changes only through review
Agents never write `.geppetto/context/` directly. Knowledge changes go in a handoff's "Proposed changes" and become canonical only via `geppetto reconcile approve`.

## Keep the four information types separate
Canonical (`context/`), episodic (`runs/`), candidate (`candidates/`) and working context (`generated/`) must stay distinct in code, files and rendered output. Never present pending candidates or run history as accepted truth.

## Never overwrite user-owned agent configuration
CLAUDE.md, AGENTS.md, Cursor/OpenCode/Gemini config and similar files are the user's. Geppetto may only add or remove a clearly delimited managed block, or write files it owns.

## Local, zero-dependency core
The core loop runs locally with Node ≥ 24 and the standard library only: no accounts, API keys, databases, Docker, hosted services, embeddings or vector stores.

## Not an agent runtime
Do not add orchestration, model routing, agent execution or workflow engines to the core. The old orchestration rig lives in `src/lab/` and stays off the core path.
