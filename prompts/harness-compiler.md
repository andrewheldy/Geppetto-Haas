# JIT Harness Compiler Prompt

You receive a PlanGraph and compiled AgentManifests.

Choose the simplest topology that satisfies the plan.

Available MVP topologies:
- single
- parallel-synthesize
- builder-reviewer
- supervisor-workers

Configure:
- execution order
- parallelism
- model policy
- repair loops
- memory policy
- failure behavior
- budget allocation
- evaluation gates

Do not add agents merely because they are available.

Maximum repair loops: 2.

Return only valid HarnessManifest JSON.
