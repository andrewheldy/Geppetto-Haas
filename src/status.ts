import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS, detectAgents, type Detected } from "./adapters.ts";
import { parseFrontmatter, slugify, str } from "./markdown.ts";
import { checkCandidate } from "./reconcile.ts";
import { gitStatusOf, isGitRepo } from "./repo.ts";
import { loadCandidates, loadCanonical, loadRuns, type Candidate, type Layout } from "./state.ts";
import { estimateTokens } from "./tokens.ts";

const targetKey = (c: Candidate) => (c.op === "add" ? `${c.target}#${slugify(c.heading)}` : c.target);

/** Plain-text overview of all four information types. */
export function status(L: Layout): string {
  const warnings: string[] = [];
  const canon = loadCanonical(L);
  const runs = loadRuns(L, warnings);
  const cands = loadCandidates(L, warnings);
  const out: string[] = [`Geppetto — ${L.root}`, ""];

  const tokens = canon.sections.reduce((a, s) => a + estimateTokens(s.body), 0);
  out.push(`Canonical state  .geppetto/context/  ${canon.files.length} files · ${canon.sections.length} sections · ~${tokens} tokens · fingerprint ${canon.fingerprint}`);
  for (const f of canon.files) out.push(`  ${f.name.padEnd(22)} ${String(f.sections).padStart(3)} sections${f.always ? "  (always included)" : ""}`);
  if (isGitRepo(L.root)) {
    const dirty = gitStatusOf(L.root, ".geppetto/context");
    out.push(dirty.length ? `  git: ${dirty.length} uncommitted change(s) — review with \`git diff .geppetto/context\`` : "  git: committed");
  } else out.push("  git: not a Git repository — canonical state is not versioned");

  out.push("", `Episodic memory  .geppetto/runs/  ${runs.length} run record(s)`);
  for (const r of runs.slice(-5).reverse()) out.push(`  ${r.id}  ${r.date}  ${r.outcome.padEnd(8)} ${r.task}`);

  const by = (s: string) => cands.filter((c) => c.status === s);
  out.push("", `Candidate state  .geppetto/candidates/  ${by("pending").length} pending · ${by("deferred").length} deferred · ${by("approved").length} approved · ${by("rejected").length} rejected`);
  const open = cands.filter((c) => c.status === "pending" || c.status === "deferred");
  for (const c of open) {
    const problem = checkCandidate(L, c);
    const rivals = open.filter((o) => o !== c && targetKey(o) === targetKey(c)).map((o) => o.id);
    out.push(`  ${c.id} [${c.status}] ${c.op} → ${targetKey(c)}  "${c.title}"${c.edited ? " (edited)" : ""}`);
    if (problem) out.push(`      !! ${problem}`);
    if (rivals.length) out.push(`      !! also targeted by ${rivals.join(", ")} — approving one will make the others stale or conflicting`);
  }
  if (open.length) out.push("  Review with `geppetto reconcile`.");

  out.push("", "Working context  .geppetto/generated/  (derived, disposable)");
  const gen = existsSync(L.generated) ? readdirSync(L.generated).filter((f) => f.endsWith(".md")).sort() : [];
  if (!gen.length) out.push("  none — run `geppetto task \"...\"`");
  for (const f of gen) {
    const text = readFileSync(join(L.generated, f), "utf8");
    const task = f === "context.md" ? /^# Working context: (.*)$/m.exec(text)?.[1] : str(safe(() => parseFrontmatter(text).data.task));
    out.push(`  ${f.padEnd(40)} ~${estimateTokens(text)} tokens${task ? `  task: ${task}` : ""}`);
  }

  const agents = detectAgents(L.root);
  out.push("", "Agent instruction files");
  if (!agents.length) out.push("  none detected — generic Markdown handoff works with any agent; `geppetto adapter install claude|agents` to wire one up");
  for (const a of agents) out.push(`  ${a.path.padEnd(34)} ${a.agent} [${a.kind}${a.files !== undefined ? `, ${a.files} entries` : ""}]${hint(a, agents)}`);

  if (warnings.length) out.push("", "Warnings", ...warnings.map((w) => `  ${w}`));
  return out.join("\n");
}

/** How Geppetto context reaches this agent: an installed block, the adapter to install, or nothing yet (generic file only). */
function hint(a: Detected, all: Detected[]): string {
  if (a.managed) return " · Geppetto block installed";
  if (!a.adapter) return "";
  const file = ADAPTERS.find((x) => x.id === a.adapter)!.file;
  if (a.kind === "config") return all.some((x) => x.path === file && x.managed) ? ` · reads ${file} (Geppetto block installed)` : ` · reads ${file} → \`geppetto adapter install ${a.adapter}\``;
  return ` · not wired → \`geppetto adapter install ${a.adapter}\``;
}

function safe<T>(f: () => T): T | undefined { try { return f(); } catch { return undefined; } }
