---
id: c-0002
status: pending
op: add
target: architecture.md
heading: Rules-directory agents
base: absent
content_hash: 0e43f0c5803b
run: r-0001
task: Improve adapter detection
created: 2026-09-24
---

# Rules-directory agents need Geppetto-owned files, not managed blocks

## Why

any adapter for Cursor, Windsurf, Cline or Copilot path instructions must fit the "never overwrite user config" constraint

## Proposed content

Tags: adapters, cursor, windsurf, cline, copilot, rules
Paths: src/adapters.ts
Cursor (`.cursor/rules/*.mdc`), Windsurf (`.windsurf/rules/`), Cline (`.clinerules/`) and Copilot (`.github/instructions/*.instructions.md`) read a directory of rule files. An adapter for them should write one Geppetto-owned file in that directory (e.g. `.cursor/rules/geppetto.mdc`) instead of editing user rules; removing the adapter deletes that file. `init` must never import a Geppetto-owned rules file as a candidate.
