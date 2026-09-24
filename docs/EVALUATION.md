# Does Geppetto help? — evaluation plan (not yet run)

V0.1 shows that the loop works. It has **not** measured whether agents do better with it. There is no evidence yet for token savings, quality gains or fewer file reads, and none is claimed.

## Question

For the same repository and task sequence, does an agent with Geppetto context do better than the same agent with only the repository's normal instructions?

- **A:** normal repository instructions (CLAUDE.md / AGENTS.md as the team has them)
- **B:** A + `geppetto task "<task>"` context, with human-reconciled state carried from earlier tasks

## Design (lightweight)

- **Tasks.** Pick 6–10 real tasks in pairs, where the second task depends on something learned in the first: a constraint discovered, an interface changed, an approach that failed. Continuity is where Geppetto should matter; single isolated tasks mostly test the agent.
- **Setup.** Run both arms from the same commit, with the same agent, model and effort, each in a fresh session with no chat history. In arm B, the human reconciles candidates between tasks exactly as a user would.
- **Per task, record:**
  - correctness: the acceptance checks pass
  - constraint violations and stale assumptions, as judged by a reviewer blind to the arm
  - repeated questions the agent asked that were answered in state
  - file reads before the first edit, from the agent transcript
  - time to the first useful edit
  - total input tokens as reported by the provider, including the size of the Geppetto context itself
- **Continuity check.** On the second task of each pair, did the agent act on the knowledge from the first task without being told?

## What would change the design

- If B wins on continuity but not on isolated tasks, the value is in reconciliation, not in the compiler.
- If B's context is ignored (reads and violations are unchanged), look at rendering and placement before selection.
- If always-included sections dominate the budget, the canonical files are too long, not the budget too small.

The `src/lab/` rig from Experiment 001 already measures provider-reported tokens per invocation and could be reused for the token column. Build nothing new until a manual pass with 2–3 task pairs shows a signal worth measuring precisely.
