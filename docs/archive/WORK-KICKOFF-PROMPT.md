# Work / Coding Agent Kickoff Prompt

Recommended build agent:
- **Claude Code with Claude Opus 4.6 or current strongest coding/reasoning model — High effort**
- Alternative: **Codex with GPT-5.6 Sol — High effort**
- Use a cheaper fast model only for repetitive fixture generation after contracts are stable.

## Prompt

You are implementing the first executable MVP of the HeldyOS JIT Swarm experiment.

The repository contains the source-of-truth planning documents. Read in this order:

1. `README.md`
2. `docs/ADR-001-BOUNDARIES.md`
3. `docs/MVP-SPEC.md`
4. `docs/ARCHITECTURE.md`
5. `docs/SWARM-DESIGN.md`
6. `docs/BUILD-ORDER.md`
7. `docs/EXPERIMENT-PLAN.md`
8. schemas, prompts, examples, and existing TypeScript contracts

Your goal is not to build the full HeldyOS product.

Your goal is to produce the smallest executable experiment that compares:

A. a fixed static swarm
B. a task-specific JIT-compiled swarm

for the same benchmark task.

Non-negotiable architecture rules:

- HSC owns semantic state; runtime memory does not become canonical state.
- Ruflo must be behind `RuntimeAdapter`.
- No core domain type may depend on a Ruflo type.
- The planner outputs capability requirements, not named workers.
- The Agent Factory creates the narrowest viable worker manifests.
- Prompt composition is modular.
- The Harness Compiler selects the simplest viable topology.
- Agent tool access follows least privilege.
- Ephemeral workers are the default.
- No autonomous promotion to permanent agents in MVP.
- All plans, manifests, traces, and evaluations must be persisted for inspection.
- Both baseline and JIT runs must share the same task input and evaluator rubric.
- Evaluation must be blind to orchestration mode.

Implementation order:

1. Make the TypeScript contracts compile.
2. Add JSON-schema validation.
3. Implement a fully deterministic mock pipeline.
4. Add a CLI capable of running one benchmark in `static` or `jit` mode.
5. Persist run artifacts to `runs/<run-id>/`.
6. Add static orchestration using the runtime interface.
7. Implement the Ruflo adapter only after the mock pipeline passes.
8. Add JIT Planner → Agent Factory → Harness Compiler.
9. Add evaluator.
10. Add benchmark runner and comparison summary.
11. Add one failure-injection scenario.
12. Stop and report results before adding learning/promotion machinery.

Before writing production logic, produce:
- a concise implementation plan,
- the proposed directory tree,
- the contracts that need changing,
- any assumptions about Ruflo integration that need verification.

Then implement.

Do not redesign the architecture merely because another framework provides overlapping primitives. Treat the external runtime as replaceable infrastructure.

At the end, report:
- what works,
- what remains mocked,
- actual static vs JIT metrics from the first runnable test,
- architectural pressure points discovered,
- the next three highest-value experiments.
