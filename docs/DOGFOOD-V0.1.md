# Dogfood record — Geppetto V0.1 on itself (2026-09-24)

The agent was Claude Code (Opus 5.5). A single session implemented V0.1 and then ran it on this repository. All numbers below are from actual command output; token counts are Geppetto's chars/4 estimates.

## 1. Initialise and write canonical state

```bash
node src/cli.ts init
#  created: README.md, .gitignore, context/project.md, context/constraints.md, context/architecture.md, context/decisions.md
#  detected: Package `geppetto` · Node.js + TypeScript (engines.node >=24) · Test / Typecheck commands
#  no agent instruction files detected
```

Canonical state was then written by hand, as a human would: 5 constraints, 7 architecture sections, 3 decisions and the project purpose. That is 17 sections, about 1,260 tokens. The content restates the V0.1 implementation brief. It was not produced by a candidate, so it has had no separate human review; see "Limitations".

## 2. Task 1 — "Improve adapter detection"

```bash
node src/cli.ts task "Improve adapter detection"
#  working context → .geppetto/generated/context.md  (~1619 / 2000 tokens)
#  canonical: 7 always + 4 relevant of 17 sections · history: 0 run(s)
```

The selected context was the 7 always-included sections (constraints and project), plus Architecture › Adapters (matched on heading, tags, body and path), Context compiler, State store and Lab. The last three were noise, pulled in only because their `Paths:` had uncommitted changes. The top repository signal was `src/adapters.ts`.

**Work done.** Detection moved from 2 hard-coded files to the `AGENT_FILES` table. It now covers 9 instruction files, 3 rules directories and 3 config markers, each with a kind and the adapter the agent already reads. `init` imports only instruction files; `status` shows kind and wiring. Tests were added for detection being read-only, rules directories and import scope.

**Compiler defects found by dogfooding** (fixed in the same task, with tests):
1. `stripComments` deleted HTML comments quoted inside inline code, so the Adapters section rendered the managed-block markers as empty backticks.
2. Every uncommitted file under a section's `Paths:` added +1, so a dirty tree flooded the context. Uncommitted changes now add at most +1 per section. Re-running the same task: **~1619 → ~1284 tokens, 4 → 2 relevant sections**, Adapters still ranked first.

## 3. Capture → candidates, canonical unchanged

```bash
node src/cli.ts capture .geppetto/generated/handoff-improve-adapter-detection.md
#  run recorded (episodic) → .geppetto/runs/r-0001-improve-adapter-detection.md
#  candidates (pending, NOT canonical) → c-0001 … c-0004
```

| Candidate | Op | Target |
|---|---|---|
| c-0001 Document the agent detection table | replace | `architecture.md#adapters` |
| c-0002 Rules-directory agents need Geppetto-owned files | add | `architecture.md` (## Rules-directory agents) |
| c-0003 Record compiler signal weights | replace | `architecture.md#context-compiler` |
| c-0004 Detection never parses agent file contents | add | `decisions.md` (## D-004) |

Isolation check: `shasum -c` over `.geppetto/context/*.md` passed for all 4 files, and the canonical fingerprint was `1e9b6246c8a0` both before and after.

## 4. Reconcile — disposable fixture, explicit test approval

**In this repository all four candidates are still pending.** No human has reviewed them, and the session did not approve project knowledge on anyone's behalf. To demonstrate promotion, the repository was copied to a throwaway fixture in `$TMPDIR` (a fresh Git repo), and approvals there used `--by fixture-test`:

```text
$ geppetto reconcile approve c-0001 --by fixture-test   → approved; architecture.md updated
$ geppetto reconcile approve c-0002 --by fixture-test   → approved; architecture.md updated
# a human then edits architecture.md#context-compiler by hand
$ geppetto reconcile approve c-0003 --by fixture-test
geppetto: c-0003: STALE — architecture.md#context-compiler changed since this proposal was made (base 08bda4bee233, now 99ed76d81197). …   (exit 1, nothing written)
$ geppetto reconcile reject c-0003 …                     → rejected; canonical state unchanged
# edit c-0004's wording on disk
$ geppetto reconcile show c-0004                          → c-0004 [pending, edited since proposal] …
$ geppetto reconcile defer c-0004 …                       → deferred; canonical state unchanged
```

`git diff --stat .geppetto/context` in the fixture showed only `architecture.md` changed: the two approved sections plus the human's own edit. `decisions.md` was untouched (c-0004 deferred) and the Context-compiler text was not replaced (c-0003 rejected).

## 5. Task 2 — "Add a Cursor adapter": continuity

```bash
geppetto task "Add a Cursor adapter"
```

| | Fixture (c-0001, c-0002 approved) | This repo (all pending) |
|---|---|---|
| Size | ~1704 / 2000 tokens | ~1780 / 2000 tokens |
| Accepted state includes | Adapters (with the detection table), **Rules-directory agents** | Adapters (old text), Lab |
| Knowledge from task 1 appears as | canonical: "write one Geppetto-owned `.cursor/rules/geppetto.mdc` … removing the adapter deletes that file" | only as titles under "Pending proposals (NOT accepted)" |
| Task 1 run | "Historical evidence (not accepted truth)" | same |

The second task's agent gets the accepted design rule for Cursor from task 1 with no access to task 1's conversation. That rule came through a handoff, a candidate and a review. Task 2 was prepared but not implemented.

## 6. Destroy derived output

In the fixture: `geppetto clean` removed `.geppetto/generated/`. All 9 canonical, run and candidate files passed `shasum -c`. Running `geppetto task "Add a Cursor adapter"` again produced context **byte-identical** to the pre-clean output (`cmp`).

## Limitations seen

- Selection is lexical. The "Lab" section matched an adapter task through the phrase "runtime adapters" plus uncommitted changes. The task-1 discoveries (compiler bugs) were shown to the Cursor task because they mention adapters and markers. That is relevant evidence, but loosely.
- Canonical seed content was written by the implementing agent from the user's brief, directly rather than through candidates. It should be reviewed like any other change (`git diff .geppetto/context`).
- The four live candidates need a human decision: `geppetto reconcile`.
- No measurement of agent performance was made; see [EVALUATION.md](EVALUATION.md).
