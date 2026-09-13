import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AcceptanceCheck, CriterionResult, EvaluationResult, ExecutionMode, RuntimeAdapter, Task } from "./types.ts";

export function parseTestCounts(out: string): { passed?: number; failed?: number } {
  const p = /(?:#|ℹ) pass (\d+)/.exec(out), f = /(?:#|ℹ) fail (\d+)/.exec(out);
  if (p || f) return { passed: p ? +p[1] : 0, failed: f ? +f[1] : 0 };
  const m = /(\d+) passing(?:.*?(\d+) failing)?/s.exec(out);
  if (m) return { passed: +m[1], failed: m[2] ? +m[2] : 0 };
  return {};
}

/** Deterministic acceptance evaluation. Same checks for every mode. */
export async function evaluateAcceptance(task: Task, workspace: string, runtime: RuntimeAdapter, meta: { workflow_id: string; mode: ExecutionMode; retries: number; review_findings: number }): Promise<EvaluationResult> {
  const criteria: CriterionResult[] = [];
  const errors: string[] = [];
  let tests: { passed?: number; failed?: number } = {};
  for (const c of task.acceptance_criteria) criteria.push(await check(c, workspace, runtime, (t) => (tests = { ...tests, ...t }), errors));
  const passed = criteria.filter((c) => c.passed).length;
  return { workflow_id: meta.workflow_id, mode: meta.mode, criteria, criteria_passed: passed, criteria_total: criteria.length,
    tests_passed: tests.passed, tests_failed: tests.failed, errors, review_findings: meta.review_findings, retries: meta.retries };
}

async function check(c: AcceptanceCheck, ws: string, rt: RuntimeAdapter, onTests: (t: { passed?: number; failed?: number }) => void, errors: string[]): Promise<CriterionResult> {
  if (c.type === "file_exists") return { criterion: c.description ?? `file exists: ${c.path}`, passed: existsSync(join(ws, c.path)) };
  if (c.type === "file_contains") {
    const p = join(ws, c.path);
    const ok = existsSync(p) && new RegExp(c.pattern).test(readFileSync(p, "utf8"));
    return { criterion: c.description ?? `${c.path} matches /${c.pattern}/`, passed: ok };
  }
  if (c.type === "command") {
    const r = await rt.runCommand(c.cmd, ws);
    const counts = parseTestCounts(r.stdout + r.stderr);
    if (counts.passed !== undefined) onTests(counts);
    if (r.exit_code !== 0) errors.push(`${c.cmd} exited ${r.exit_code}: ${(r.stderr || r.stdout).slice(-400)}`);
    return { criterion: c.description ?? `command passes: ${c.cmd}`, passed: r.exit_code === 0, detail: `exit ${r.exit_code}` + (counts.passed !== undefined ? `, pass ${counts.passed} fail ${counts.failed}` : "") };
  }
  return { criterion: c.description, passed: false, detail: "manual criterion not auto-evaluated" };
}

export const BLIND_REVIEW_SCHEMA = {
  type: "object",
  properties: { score: { type: "number", minimum: 0, maximum: 10 }, findings: { type: "array", items: { type: "string" } }, summary: { type: "string" } },
  required: ["score", "findings", "summary"], additionalProperties: false,
};

/** Blind review: the evaluator sees an anonymized artifact label and the diff, never the execution mode. */
export async function blindReview(task: Task, diff: string, runtime: RuntimeAdapter, model: string, label: string, cwd: string): Promise<EvaluationResult["blind_review"]> {
  const req = {
    invocation_id: `blind-${randomUUID().slice(0, 8)}`, agent_id: "blind-evaluator", node_id: "evaluation", model, effort: "medium" as const,
    system_prompt: "You are a strict, independent code reviewer. You do not know how the artifact was produced. Score 0-10 for correctness, completeness against the acceptance criteria, test quality, and code quality. List concrete findings.",
    prompt: `# Artifact ${label}\n\n## Objective\n${task.objective}\n\n## Constraints\n${task.constraints.map((c) => `- ${c}`).join("\n")}\n\n## Acceptance criteria\n${task.acceptance_criteria.map((c) => `- ${c.type === "manual" ? c.description : JSON.stringify(c)}`).join("\n")}\n\n## Diff\n\`\`\`diff\n${diff.slice(0, 60000)}\n\`\`\``,
    tools: [], cwd, max_turns: 1, json_schema: BLIND_REVIEW_SCHEMA,
  };
  const r = await runtime.invoke(req);
  const s = (r.structured ?? {}) as { score?: number; findings?: string[] };
  return { score: typeof s.score === "number" ? s.score : -1, findings: s.findings ?? [], model: r.model, label };
}
