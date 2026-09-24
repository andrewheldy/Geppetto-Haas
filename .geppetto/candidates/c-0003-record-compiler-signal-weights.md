---
id: c-0003
status: pending
op: replace
target: "architecture.md#context-compiler"
heading: ""
base: 08bda4bee233
content_hash: 95a8c2a884cb
run: r-0001
task: Improve adapter detection
created: 2026-09-24
---

# Record compiler signal weights

## Why

the weights now matter for behaviour (a dirty tree no longer floods context) and should be stated where agents will see them

## Proposed content

Tags: context, compiler, selection, budget
Paths: src/select.ts, src/render.ts, src/compile.ts, src/repo.ts
Selection (`select.ts`, pure, deterministic) is separate from rendering (`render.ts`). Scores per task term: heading ×3, tags ×2, body ×1; a section path named in the task +4 each; uncommitted changes under a section path +1 once. Minimum score 2. `compile.ts` loads state, selects, renders and enforces the token budget (default 2000, chars/4 estimate) by dropping lowest-priority optional items. Always-included sections are never dropped; overflow is reported.
