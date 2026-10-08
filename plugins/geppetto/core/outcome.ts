// Turning how an agent run ended into failure evidence (or none). Escalation reads only what this returns.
import type { FailedAttempt, FailureKind } from "./types.ts";

export interface RunOutcome {
  /** How the run ended: answered, interrupted, refused, or an API error. */
  reason: "answer" | "aborted" | "refusal" | "error";
  /** The agent's final text. */
  answer: string;
  /** True when the run hit its turn/tool budget. */
  budgetExhausted?: boolean;
}

const TEST_FAIL = /^.*\b(tests? (are |were |still )?fail(ing|ed|s)?|\d+ (failing|failed)|FAIL(ED)?\b|AssertionError|not ok \d+).*$/im;
const CANNOT = /^.*\b(I (was|am) (unable|not able) to|I could(n'?t| not)|I can(not|'?t) (complete|finish|determine|find|fix|reproduce)|did not (succeed|manage)|gave up|unable to (complete|finish|fix|determine|reproduce)|blocked by)\b.*$/im;

/** Failure evidence from a run's end, or undefined for a run that succeeded as far as the text shows. */
export function classifyOutcome(o: RunOutcome): { kind: FailureKind; evidence: string } | undefined {
  if (o.budgetExhausted) return { kind: "budget_exhausted", evidence: "turn budget reached before the agent finished" };
  if (o.reason === "aborted") return { kind: "interrupted", evidence: "run interrupted" };
  if (o.reason === "refusal") return { kind: "refusal", evidence: "model refused" };
  if (o.reason === "error") return { kind: "infra", evidence: "run ended on an API error" };
  const test = TEST_FAIL.exec(o.answer)?.[0];
  if (test) return { kind: "test_failure", evidence: test.trim().slice(0, 200) };
  const cannot = CANNOT.exec(o.answer)?.[0];
  return cannot ? { kind: "capability", evidence: cannot.trim().slice(0, 200) } : undefined;
}

export function toAttempt(model: string, agent: string, o: RunOutcome): FailedAttempt | undefined {
  const f = classifyOutcome(o);
  return f ? { model, agent, kind: f.kind, evidence: f.evidence } : undefined;
}
