// End-to-end: real headless Claude Code sessions with the Geppetto plugin loaded via --plugin-dir.
// Each scenario has the main model call the Agent tool for real; we read back three independent records:
//   1. Geppetto's own decision (GEPPETTO_DECISIONS_FILE),
//   2. the model the subagent's turn reported running on (turn.complete usage.model, captured in that record),
//   3. Claude Code's per-model token accounting (`modelUsage` in --output-format json).
// Costs real tokens and needs an authenticated `claude`; not part of `npm test`. Run: npm run e2e
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PLUGIN = resolve(import.meta.dirname, "../../plugins/geppetto");
const OUT = resolve(import.meta.dirname, "../../docs/results/e2e-claude-code.json");
const DELEGATE = (task: string, extra = "") =>
  `Use the Agent tool exactly once to delegate the task below to a subagent. Do not set the model, effort, or subagent_type parameters${extra}. ` +
  `Set run_in_background to false. After it returns, reply with a one-line summary of its answer.\n\nTask for the subagent: ${task}`;

type Scenario = { name: string; mode: "off" | "observe" | "route"; main: string; prompt: string; files?: Record<string, string>; expect: (r: Result) => string[] };
type Decision = { seq: number; action: string; kind: string; alias?: string; delegate: boolean; applied: { model?: string; agent?: string; denied?: string }; agent: string; observedModel?: string; spawnedModel?: string; reason: string; requested: { model?: string } };
type Result = { decisions: Decision[]; modelUsage: Record<string, { outputTokens: number }>; workspace: string; text: string; stderr: string; costUsd: number };

const out = (r: Result, model: string) => r.modelUsage[model]?.outputTokens ?? 0;
// Claude Code itself spends a few haiku tokens per session (titles, summaries); a subagent's work is far above that.
const RAN = 150;

const SCENARIOS: Scenario[] = [
  {
    name: "explore → Explore agent on haiku", mode: "route", main: "sonnet",
    files: { "a.md": "the ledger is appended here\n", "b.md": "nothing\n", "src/c.ts": "// ledger writer\nexport {}\n" },
    prompt: DELEGATE("Find every file in this directory tree that mentions the word ledger and report the file paths."),
    expect: (r) => [
      check(r.decisions[0]?.kind === "explore", "classified explore"),
      check(r.decisions[0]?.applied.model === "haiku" && r.decisions[0]?.applied.agent === "Explore", "applied haiku + Explore"),
      check(r.decisions[0]?.observedModel === "claude-haiku-5-5", `subagent ran on haiku (saw ${r.decisions[0]?.observedModel})`),
      check(out(r, "claude-haiku-5-5") > RAN, `modelUsage shows haiku work (${out(r, "claude-haiku-5-5")} output tokens)`),
    ],
  },
  {
    name: "implementation → sonnet", mode: "route", main: "haiku",
    prompt: DELEGATE("Implement a function slugify(text) in slug.js that lowercases, trims, and replaces runs of non-alphanumeric characters with single hyphens; export it with module.exports. Create the file."),
    expect: (r) => [
      check(r.decisions[0]?.kind === "implement" && r.decisions[0]?.applied.model === "sonnet", "classified implement, applied sonnet"),
      check(r.decisions[0]?.observedModel === "claude-sonnet-5-5", `subagent ran on sonnet (saw ${r.decisions[0]?.observedModel})`),
      check(out(r, "claude-sonnet-5-5") > RAN, `modelUsage shows sonnet work (${out(r, "claude-sonnet-5-5")})`),
      check(existsSync(join(r.workspace, "slug.js")), "slug.js was written"),
    ],
  },
  {
    name: "architecture → opus", mode: "route", main: "haiku",
    prompt: DELEGATE("Design the architecture for a multi-region event ingestion service: compare two options and their trade-offs, and recommend one. Answer in under 150 words; do not read or write files."),
    expect: (r) => [
      check(r.decisions[0]?.kind === "architecture" && r.decisions[0]?.applied.model === "opus", "classified architecture, applied opus"),
      check(r.decisions[0]?.observedModel === "claude-opus-5-5", `subagent ran on opus (saw ${r.decisions[0]?.observedModel})`),
      check(out(r, "claude-opus-5-5") > RAN, `modelUsage shows opus work (${out(r, "claude-opus-5-5")})`),
    ],
  },
  {
    name: "trivial → refused, done inline", mode: "route", main: "sonnet",
    files: { "README.md": "Messages you recieve are logged.\n" },
    prompt: DELEGATE("Fix the typo in README.md: 'recieve' should be 'receive'."),
    expect: (r) => [
      check(r.decisions[0]?.kind === "trivial" && !!r.decisions[0]?.applied.denied, "first delegation refused as trivial"),
      check(readFileSync(join(r.workspace, "README.md"), "utf8").includes("receive"), "typo fixed anyway"),
    ],
  },
  {
    name: "explicit model kept", mode: "route", main: "sonnet",
    prompt: DELEGATE("Design the architecture for a multi-region event ingestion service and list two trade-offs. Answer in under 100 words; do not read or write files.", ", except set model to \"haiku\""),
    expect: (r) => [
      check(r.decisions[0]?.action === "keep" && r.decisions[0]?.requested.model === "haiku", "decision keep (explicit haiku)"),
      check(!r.decisions[0]?.applied.model, "nothing applied"),
      check(r.decisions[0]?.observedModel === "claude-haiku-5-5", `subagent ran on haiku, not opus (saw ${r.decisions[0]?.observedModel})`),
    ],
  },
  {
    name: "observe mode changes nothing", mode: "observe", main: "sonnet",
    files: { "a.md": "ledger\n" },
    prompt: DELEGATE("Find every file in this directory that mentions the word ledger and report the file paths."),
    expect: (r) => [
      check(r.decisions[0]?.alias === "haiku" && Object.keys(r.decisions[0]?.applied ?? {}).length === 0, "would route to haiku, applied nothing"),
      check(r.decisions[0]?.observedModel === "claude-sonnet-5-5", `subagent inherited sonnet (saw ${r.decisions[0]?.observedModel})`),
    ],
  },
  {
    name: "off mode is native", mode: "off", main: "sonnet",
    files: { "a.md": "ledger\n" },
    prompt: DELEGATE("Find every file in this directory that mentions the word ledger and report the file paths."),
    expect: (r) => [
      check(r.decisions.length === 0, "no decisions recorded"),
      check(out(r, "claude-sonnet-5-5") > RAN && out(r, "claude-haiku-5-5") < RAN, "subagent ran on the inherited model"),
    ],
  },
];

function check(ok: boolean, what: string): string { return `${ok ? "PASS" : "FAIL"} ${what}`; }

function run(s: Scenario): Promise<Result> {
  const workspace = mkdtempSync(join(tmpdir(), "geppetto-e2e-"));
  for (const [f, text] of Object.entries(s.files ?? {})) { mkdirSync(join(workspace, f, ".."), { recursive: true }); writeFileSync(join(workspace, f), text); }
  const decisionsFile = join(workspace, ".geppetto-decisions.json");
  const env: NodeJS.ProcessEnv = { ...process.env, GEPPETTO_MODE: s.mode, GEPPETTO_DECISIONS_FILE: decisionsFile };
  // A nested session must not report into the session that launched it.
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_REMOTE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_TEE_SDK_STDOUT", "CLAUDE_CODE_SUBAGENT_MODEL"]) delete env[k];
  const args = ["-p", s.prompt, "--model", s.main, "--plugin-dir", PLUGIN, "--output-format", "json", "--max-turns", "12",
    "--allowedTools", "Agent,Read,Glob,Grep,Write,Edit,Bash(ls:*),Bash(grep:*)"];
  return new Promise((done) => {
    const p = spawn("claude", args, { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d)); p.stderr.on("data", (d) => (stderr += d));
    p.on("close", () => {
      let j: { modelUsage?: Result["modelUsage"]; result?: string; total_cost_usd?: number } = {};
      try { j = JSON.parse(stdout); } catch { stderr += `\n(unparsed stdout) ${stdout.slice(0, 400)}`; }
      const decisions = existsSync(decisionsFile) ? JSON.parse(readFileSync(decisionsFile, "utf8")) : [];
      done({ decisions, modelUsage: j.modelUsage ?? {}, workspace, text: j.result ?? "", stderr, costUsd: j.total_cost_usd ?? 0 });
    });
  });
}

const only = process.argv[2];
const chosen = SCENARIOS.filter((s) => !only || s.name.includes(only));
const results = await Promise.all(chosen.map(async (s) => ({ s, r: await run(s) })));
let failed = 0;
const report = results.map(({ s, r }) => {
  const checks = s.expect(r);
  failed += checks.filter((c) => c.startsWith("FAIL")).length;
  console.log(`\n## ${s.name} (mode ${s.mode}, main ${s.main}, $${r.costUsd.toFixed(3)})`);
  for (const c of checks) console.log(`  ${c}`);
  for (const d of r.decisions) console.log(`  decision #${d.seq}: ${d.action} ${d.kind} → ${d.agent} ${JSON.stringify(d.applied)} ran on ${d.observedModel ?? "-"} · ${d.reason}`);
  console.log(`  modelUsage: ${Object.entries(r.modelUsage).map(([m, u]) => `${m}=${u.outputTokens}`).join(", ")}`);
  if (r.stderr.trim()) console.log(`  stderr: ${r.stderr.trim().slice(0, 300)}`);
  return { scenario: s.name, mode: s.mode, main: s.main, checks, decisions: r.decisions, modelUsage: r.modelUsage, costUsd: r.costUsd };
});
if (!only) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), plugin: "geppetto 0.1.0", results: report }, null, 2));
console.log(`\n${failed ? `${failed} check(s) FAILED` : "all checks passed"}`);
process.exitCode = failed ? 1 : 0;
