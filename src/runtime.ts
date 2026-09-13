import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CommandResult, InvocationRequest, InvocationResult, RuntimeAdapter, TokenUsage } from "./types.ts";
import { activeContext, estimateCost, estimateTokens, usageFromEstimate } from "./tokens.ts";

// ---------------------------------------------------------------------------
// Mock runtime: deterministic, scriptable. Used by tests and dry runs.
// ---------------------------------------------------------------------------
export interface MockScenario {
  /** verdicts returned by successive review invocations */
  review_verdicts?: Array<"pass" | "fail">;
  /** node ids whose first invocation asks for context before doing work */
  need_context_on?: string[];
  /** node id → number of times it errors before succeeding */
  fail_times?: Record<string, number>;
  /** files written (relative to cwd) when an implement/patch node runs */
  write_on_implement?: Record<string, string>;
  /** scripted command results; default exit 0 */
  commands?: Record<string, Partial<CommandResult>>;
  output_tokens?: number;
  /** simulated wall time per invocation */
  delay_ms?: number;
}

export class MockRuntime implements RuntimeAdapter {
  readonly name = "mock";
  readonly scenario: MockScenario;
  readonly invocations: InvocationRequest[] = [];
  private reviews = 0;
  private asked = new Set<string>();
  private failures: Record<string, number> = {};
  private sessions = new Map<string, number>(); // session_id → accumulated context tokens
  constructor(scenario: MockScenario = {}) { this.scenario = scenario; }

  async invoke(req: InvocationRequest): Promise<InvocationResult> {
    this.invocations.push(req);
    if (this.scenario.delay_ms) await new Promise((r) => setTimeout(r, this.scenario.delay_ms));
    const started = Date.now();
    const fresh = estimateTokens(req.system_prompt) + estimateTokens(req.prompt);
    // control-mode accumulation: a resumed session re-reads everything it has seen so far
    let prior = 0;
    const session = req.session_id ?? randomUUID();
    if (req.resume && req.session_id) prior = this.sessions.get(req.session_id) ?? 0;
    const outTokens = this.scenario.output_tokens ?? 300;
    const usage: TokenUsage = { input: fresh, output: outTokens, cache_read: prior, cache_write: 0, total: fresh + prior + outTokens, estimated: true };
    this.sessions.set(session, prior + fresh + outTokens);

    const base = { invocation_id: req.invocation_id, usage, iterations: [usage], cost_usd: estimateCost(req.model, usage), cost_estimated: true, duration_ms: Date.now() - started, model: req.model, session_id: session, num_turns: 1 };
    const nodeKey = req.node_id.replace(/#\d+$/, "");
    const failLeft = (this.scenario.fail_times?.[nodeKey] ?? 0) - (this.failures[nodeKey] ?? 0);
    if (failLeft > 0) { this.failures[nodeKey] = (this.failures[nodeKey] ?? 0) + 1; return { ...base, output_text: "", error: `mock failure ${this.failures[nodeKey]} for ${nodeKey}` }; }

    const kind = req.node_id.split(/[:#]/)[0];
    let structured: Record<string, unknown>;
    if (this.scenario.need_context_on?.includes(nodeKey) && !this.asked.has(nodeKey)) {
      this.asked.add(nodeKey);
      structured = { summary: "", verdict: "n/a", findings: [], decisions: [], assumptions: [], questions: [], files_changed: [], need_context: [`prior decision about ${nodeKey}`] };
    } else if (kind === "review") {
      const verdict = this.scenario.review_verdicts?.[this.reviews++] ?? "pass";
      structured = { summary: `Mock review: ${verdict}.`, verdict, findings: verdict === "fail" ? ["mock finding: tests/x.test.ts missing edge case"] : [], decisions: [], assumptions: [], questions: [], files_changed: [], need_context: [] };
    } else if (kind === "implement" || kind === "patch") {
      const files = Object.keys(this.scenario.write_on_implement ?? {});
      for (const [p, c] of Object.entries(this.scenario.write_on_implement ?? {})) { mkdirSync(join(req.cwd, p, ".."), { recursive: true }); writeFileSync(join(req.cwd, p), c); }
      structured = { summary: `Mock ${kind} of ${req.node_id} complete.`, verdict: "n/a", findings: [], decisions: [`use module pattern for ${req.node_id}`], assumptions: ["node 24 available"], questions: [], files_changed: files, need_context: [] };
    } else {
      structured = { summary: `Mock ${kind} output for ${req.node_id}.`, verdict: "n/a", findings: [], decisions: kind === "plan" ? ["implement in src/, tests in tests/"] : [], assumptions: [], questions: kind === "plan" ? ["is a CLI flag needed?"] : [], files_changed: [], need_context: [] };
    }
    const text = `Mock output for ${req.node_id}\n` + "x".repeat(Math.max(0, outTokens * 4 - 40)) + "\n" + JSON.stringify(structured);
    return { ...base, output_text: text, structured };
  }

  async runCommand(cmd: string, _cwd: string): Promise<CommandResult> {
    const s = this.scenario.commands?.[cmd] ?? {};
    return { cmd, exit_code: 0, stdout: `mock: ${cmd} ok\n# pass 3\n# fail 0`, stderr: "", duration_ms: 1, ...s };
  }
}

// ---------------------------------------------------------------------------
// Real runtime: Claude Code CLI in headless mode. Real usage/cost from the provider.
// ---------------------------------------------------------------------------
export interface ClaudeCliOptions { bin?: string; timeout_ms?: number; log_dir?: string; }

export class ClaudeCliRuntime implements RuntimeAdapter {
  readonly name = "claude-cli";
  readonly opts: ClaudeCliOptions;
  constructor(opts: ClaudeCliOptions = {}) { this.opts = opts; }

  async invoke(req: InvocationRequest): Promise<InvocationResult> {
    const args = ["--print", "--output-format", "json", "--model", req.model, "--max-turns", String(req.max_turns),
      "--safe-mode", "--strict-mcp-config", "--dangerously-skip-permissions", "--permission-prompts", "none",
      "--tools", req.tools.length ? req.tools.join(",") : "", "--effort", req.effort === "high" ? "high" : req.effort === "low" ? "low" : "medium"];
    if (req.max_usd) args.push("--max-budget-usd", String(req.max_usd));
    if (req.json_schema) args.push("--json-schema", JSON.stringify(req.json_schema));
    if (req.resume && req.session_id) args.push("--resume", req.session_id);
    else {
      args.push("--system-prompt", req.system_prompt);
      if (req.session_id) args.push("--session-id", req.session_id); else args.push("--no-session-persistence");
    }
    const started = Date.now();
    const { stdout, stderr, code, timedOut } = await run(this.opts.bin ?? "claude", args, req.cwd, req.prompt, this.opts.timeout_ms ?? 20 * 60_000);
    if (this.opts.log_dir) { mkdirSync(this.opts.log_dir, { recursive: true }); writeFileSync(join(this.opts.log_dir, `${req.invocation_id}.json`), JSON.stringify({ req: { ...req, system_prompt: req.system_prompt.slice(0, 2000) }, args, stdout, stderr, code }, null, 2)); }
    const duration_ms = Date.now() - started;
    let parsed: any;
    try { parsed = JSON.parse(stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? ""); } catch { /* fallthrough */ }
    const empty: TokenUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, estimated: false };
    if (!parsed) {
      return { invocation_id: req.invocation_id, output_text: stdout, usage: { ...usageFromEstimate(estimateTokens(req.system_prompt + req.prompt), 0) }, iterations: [], cost_usd: 0, cost_estimated: true, duration_ms, model: req.model, num_turns: 0,
        error: timedOut ? `timeout after ${duration_ms}ms` : `claude exited ${code}: ${(stderr || stdout).slice(-800)}` };
    }
    const u = parsed.usage ?? {};
    const usage: TokenUsage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, total: 0, estimated: false };
    usage.total = usage.input + usage.output + usage.cache_read + usage.cache_write;
    const iterations: TokenUsage[] = (u.iterations ?? []).map((it: any) => { const x = { input: it.input_tokens ?? 0, output: it.output_tokens ?? 0, cache_read: it.cache_read_input_tokens ?? 0, cache_write: it.cache_creation_input_tokens ?? 0, total: 0, estimated: false }; x.total = activeContext(x) + x.output; return x; });
    const modelUsed = Object.keys(parsed.modelUsage ?? {})[0] ?? req.model;
    let structured = parsed.structured_output as Record<string, unknown> | undefined;
    const text: string = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result ?? "");
    if (!structured && req.json_schema) { try { structured = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { /* not json */ } }
    const isErr = parsed.is_error || (parsed.subtype && parsed.subtype !== "success");
    return { invocation_id: req.invocation_id, output_text: text, structured, usage, iterations, cost_usd: parsed.total_cost_usd ?? estimateCost(modelUsed, usage), cost_estimated: parsed.total_cost_usd === undefined,
      duration_ms, model: modelUsed, session_id: parsed.session_id, num_turns: parsed.num_turns ?? 0, error: isErr ? `claude ${parsed.subtype}: ${text.slice(0, 500)}` : undefined };
  }

  async runCommand(cmd: string, cwd: string, timeoutMs = 10 * 60_000): Promise<CommandResult> {
    const started = Date.now();
    const r = await run("/bin/sh", ["-c", cmd], cwd, undefined, timeoutMs);
    return { cmd, exit_code: r.timedOut ? 124 : r.code, stdout: r.stdout, stderr: r.stderr, duration_ms: Date.now() - started };
  }
}

function run(bin: string, args: string[], cwd: string, stdin: string | undefined, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const env = { ...process.env }; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => { clearTimeout(t); resolve({ stdout, stderr, code: code ?? -1, timedOut }); });
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
  });
}

export function makeRuntime(name: string, opts: { scenario?: MockScenario; log_dir?: string } = {}): RuntimeAdapter {
  if (name === "mock") return new MockRuntime(opts.scenario);
  if (name === "claude") return new ClaudeCliRuntime({ log_dir: opts.log_dir });
  throw new Error(`unknown runtime ${name}`);
}
