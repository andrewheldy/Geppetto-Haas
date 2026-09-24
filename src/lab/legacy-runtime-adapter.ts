import type { ExecutionTrace, HarnessManifest, HSCContext, RuntimeAdapter, TaskSpec } from "./legacy-types.ts";

export class MockRuntimeAdapter implements RuntimeAdapter {
  async execute(
    harness: HarnessManifest,
    task: TaskSpec,
    context: HSCContext
  ): Promise<ExecutionTrace> {
    const started = Date.now();

    return {
      runId: `${task.id}-${harness.id}`,
      runtime: "mock",
      startedAt: new Date(started).toISOString(),
      completedAt: new Date().toISOString(),
      events: [
        {
          type: "mock_execution",
          topology: harness.topology,
          agents: harness.agents.map((a) => a.id),
          contextSummary: {
            facts: context.facts.length,
            constraints: context.constraints.length,
          },
        },
      ],
      metrics: {
        modelCalls: 0,
        toolCalls: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        wallClockMs: Date.now() - started,
      },
      finalResult: {
        status: "mock",
        message: "Replace MockRuntimeAdapter with RufloRuntimeAdapter after contracts pass.",
      },
    };
  }
}

// Runtime-specific implementation belongs here, not in core domain types.
export class RufloRuntimeAdapter implements RuntimeAdapter {
  async execute(
    _harness: HarnessManifest,
    _task: TaskSpec,
    _context: HSCContext
  ): Promise<ExecutionTrace> {
    throw new Error("Not implemented: translate HarnessManifest to Ruflo runtime primitives.");
  }
}
