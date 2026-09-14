# Experiment 001 — Geppetto builds Geppetto

**Question.** For the same objective and comparable output quality, how much lifecycle context does a governed graph of specialists need compared with one competent long-running agent session?

**Answer from run 2 (n = 1 task, real runtime, opus-5 for every agent call):** Geppetto used **17.6% fewer lifecycle tokens**, **29% lower peak context** and **49% lower average context**, at **equal quality** (7/7 acceptance criteria both, 41 vs 44 tests passing, blind review 8.3 vs 8.5). It cost **7% more in dollars** and took **11% longer**. HSC maintenance cost 4% of the tokens it saved. No JIT retrievals were needed. Every number below comes from `docs/results/exp001-registry-run2/`.

Do not generalize from one task. The result is directionally consistent with the ~35% lifecycle-reduction hypothesis for peak/average context and below it for lifecycle tokens, on a 4-phase workflow. The smoke experiment (`exp000`, 4 turns, haiku, trivial task) went the other way: Geppetto used 13% *more* lifecycle tokens. Overhead dominates short workflows.

## Governance labels

| Part | Label | Meaning |
|---|---|---|
| Everything in `src/` | **bootstrap** | Written conventionally by one agent session before Geppetto could run. Its build was not measured as a Geppetto run. |
| `runs/exp001-registry-run2/governed` | **full** | Planned, routed, context-compiled, executed, reviewed and promoted by Geppetto. |
| `runs/exp001-registry-run2/control` | **control** | One accumulating `claude -p --resume` session, same task, same tools, same phases. |
| `runs/exp000-smoke-haiku` | full vs control | Trivial task, haiku, used to validate the rig end to end before spending on opus. |

## The task under test

`tasks/exp001-registry.json`: implement the specialist promotion registry (`src/registry.ts` + `registry` CLI command) and a ledger CSV exporter (`src/ledger-csv.ts`), each with tests, without modifying orchestrator/ledger/types. Two independent parts, so the planner fanned out two implement nodes in parallel and joined at the deterministic test node. Acceptance: 4 file-exists checks, `node --test`, `tsc --noEmit`, and a content check on `cli.ts`.

Both modes' workspaces pass all acceptance checks. Both produced working registries; the control wrote 3 more tests.

## Headline (run 2)

| Metric | Geppetto (governed) | Long agent (control) |
|---|---|---|
| Lifecycle model tokens (input+cache+output) | 1,518,970 | 1,844,456 |
| Lifecycle cache-read tokens | 1,310,713 | 1,656,098 |
| Lifecycle cache-write tokens | 154,890 | 147,061 |
| Lifecycle output tokens | 53,283 | 41,229 |
| Peak active context | 57,708 | 81,355 |
| Average active context (per invocation peak) | 34,089 | 66,920 |
| Cumulative context deliberately injected | 26,507 | 267,680 |
| Cost (provider-reported) | $3.57 | $3.33 |
| Duration | 540 s | 487 s |
| Model calls | 4 (+1 deterministic test node) | 4 turns |
| Retries / loops / replans | 0 / 0 / 0 | 0 / 0 / 0 |
| Retrievals / compactions | 0 / 5 | N/A |
| HSC overhead tokens | 13,285 | N/A |
| Acceptance criteria | 7/7 | 7/7 |
| Tests passing | 41 | 44 |
| Blind review (sonnet, saw only "Artifact B"/"Artifact A") | 8.3, 15 findings | 8.5, 14 findings |

Derived: context reduction 29.1% (peak), 49.1% (avg); lifecycle token reduction 17.6%; cost reduction −7.2%; duration reduction −10.7%; tokens saved 325,486; HSC overhead ÷ tokens saved 0.041; compaction ratio 13.3×; handoff efficiency 82.9% (compiled ÷ available per agent node).

## Where Geppetto saved context, exactly

Per agent invocation (governed). `compiled` is the packet Geppetto built; `tool` is what the agent then pulled in itself through Read/Grep; `peak` is the context at the last API round-trip.

| Node | compiled | of which HSC | runtime overhead | tool reads | peak | output | cost |
|---|---|---|---|---|---|---|---|
| plan | 4,123 | 289 | 3,028 | 27,918 | 35,330 | 7,719 | $0.56 |
| implement:ledger-csv | 7,152 | 2,671 | 6,795 | 13,969 | 28,191 | 9,856 | $0.57 |
| implement:registry | 8,612 | 2,670 | 6,795 | 33,535 | 49,217 | 20,467 | $1.31 |
| test (deterministic) | 0 | 0 | 0 | 874 | 0 | 0 | $0.00 |
| review | 6,620 | 4,502 | 3,028 | 47,772 | 57,708 | 15,241 | $1.14 |

Control, per turn (everything the session had seen is both available and injected):

| Turn | context at turn end | output | cost |
|---|---|---|---|
| plan | 57,836 | 25,433 | $1.49 |
| implement | 62,779 | 2,256 | $0.23 |
| test | 65,710 | 766 | $0.11 |
| review | 81,355 | 12,774 | $1.50 |

Observations:

1. **Every governed invocation started small and stayed below the control's smallest turn.** The largest governed context (review, 57.7k) equals the control's *first* turn. The control never got to shrink; the governed graph reset at every node.
2. **The compiled packet was a minority of what agents actually read.** Packets were 4k to 9k tokens; agents pulled another 14k to 48k through their own tools. The Context Governor controls injection, not curiosity. This is the main leak in L0 minimization and the first thing to instrument further (which files were read that were already in the packet, and which weren't offered).
3. **The reviewer was the biggest consumer** (47.8k tool reads) because the working-tree diff exceeded the compaction threshold and was compacted to a 491-token summary, so the reviewer re-read the files. Compaction saved packet tokens and then cost more tool tokens. The compaction ratio (13×) is real but was not free here.
4. **Parallel fan-out worked as designed.** Both implement nodes ran concurrently in the same workspace on disjoint files; the deterministic test node joined them; no conflicts.
5. **Zero JIT retrievals.** No agent reported missing context. Either the packets were sufficient or agents preferred reading files over asking; the ledger cannot tell these apart yet.
6. **Isolated review passed on the first pass** in the governed run, so no patch loop executed. The control's self-review also passed. The bounded loop, retry and replan paths were exercised only under the mock runtime in tests (`tests/orchestrator.test.ts`) and in the aborted run 1 (see below).

## Where Geppetto added overhead, exactly

1. **Cache economics favor the monolithic session.** The control paid cache-write once per turn and read the growing prefix back at 0.1× price. Geppetto started a fresh session per node, so every node paid cache-write for its packet plus the runtime's tool definitions (154,890 cache-write tokens vs 147,061). Fewer total tokens, but a worse price mix, plus 29% more output tokens (each specialist re-narrates its handoff). Net: −7.2% on cost despite +17.6% on tokens.
2. **HSC maintenance: 13,285 tokens** (packet HSC slices + candidate deltas), 4.1% of the tokens saved. Cheap at this scale. 76 entries were produced; 26 decisions, 5 artifacts, 2 evidence and 4 actions were promoted after validation; 20 volatile assumptions/questions decayed to `stale` before the workflow ended and were never injected again.
3. **Runtime overhead per invocation: 3,028 tokens (read-only tools) or 6,795 (full tools)**, measured by `geppetto calibrate`. Paid 4× by Geppetto and once by the control (then cached).
4. **Duration: +11%.** Parallel implement nodes helped, but the plan and review nodes are serial and each specialist re-orients from scratch.

## Quality as a control variable

Both artifacts pass the same deterministic checks. The blind reviewer (sonnet, labels randomized, mode unknown) scored them within 0.2 points and raised near-identical findings (last-write-wins `roleByNode`, `runs` semantics, inability to execute tests). The control wrote a slightly larger test suite. The governed run's specialists never saw each other's transcripts; the reviewer did not know who wrote the code. Specialization neither improved nor hurt quality on this task.

## Answers to the secondary questions

- **Did specialization improve or hurt quality?** Neither, measurably (8.3 vs 8.5, 7/7 vs 7/7).
- **Did maintaining HSC cost more than it saved?** No: 13k spent vs 325k saved.
- **Did agents frequently need information removed during compaction?** Yes, once and expensively: the compacted diff sent the reviewer back to the files (47.8k tool tokens). Nothing was retrieved through the rehydration protocol.
- **Which tasks benefited most from isolated context?** The implement nodes: 28k and 49k peak vs the control's 63k at the same phase, while producing equivalent code.
- **Which would have been more efficient in one continuous agent?** The short smoke task (`exp000`): −13% lifecycle tokens, −41% cost for Geppetto. Below roughly 4 phases the per-node cache-write and overhead exceed the savings.
- **At what workflow length does Geppetto break even?** Between 4 trivial turns (loses) and 4 substantive phases (wins 17.6%). More points needed; the rig can produce them.
- **Does orchestration reduce context growth or merely distribute it?** Both: peak fell 29%, calls stayed at 4, and total tokens fell 17.6%, so it is not just redistribution. But the specialists' own tool reads re-grew each context to 28k–58k, so the reduction is bounded by agent behavior, not by the compiler.

## Harness defects the experiment exposed (all fixed, all recorded)

- **Run 1 aborted.** The planner attached every task-level `file_exists` criterion to every parallel implement node, so the CSV node was "validated" against the registry file and retried spuriously (`docs/results/exp001-registry-run1-aborted/`). Fixed: criteria are scoped to the owning subtask; regression test added.
- **Model mislabeling.** Claude Code makes tiny haiku helper calls; the ledger initially reported the first `modelUsage` key. Fixed: primary model = largest output. Ledgers were rebuilt from the saved raw responses (`geppetto reevaluate`).
- **Overhead split.** The CLI reports one aggregate usage record per invocation, not per round-trip, so "first round-trip" was unmeasurable. Fixed: per-tool-set overhead is calibrated once (`docs/results/overhead-calibration.json`) and everything above packet + overhead is attributed to tool reads.
- **Control run 2 first attempt died on turn 2** when the provider's session limit was hit (`control-aborted-session-limit/`); the governed half had consumed the budget first. Rerun after reset. The runtime now treats limit messages as errors. Ordering is a confound to randomize in future runs.
- **Blind review needed 3 turns**, not 1, because structured output is a tool round-trip inside the CLI.
- **The control implemented during its plan turn** despite being told to plan only. Recorded, not corrected: it is the control's own competent behavior.

## Reproduce

```bash
node src/cli.ts calibrate
node src/cli.ts experiment --task tasks/exp001-registry.json --runtime claude --blind-model sonnet --id my-run
node src/cli.ts reevaluate --dir runs/my-run --blind-model sonnet
```

## Next three experiments

1. **Length sweep.** Same rig, tasks of 2, 4, 8 and 12 phases, to locate break-even and test the 35% hypothesis where it was proposed (>20 turns).
2. **Tool-read attribution.** Log which files each specialist reads and compare against its packet: were reads redundant with the packet, or were they the governor's omissions? This decides whether to grow packets or trust agents.
3. **Cache-aware routing.** Let the router keep a warm session for consecutive nodes of the same specialist type (e.g. patch after implement) and measure whether the cost gap closes without losing isolation for review.
