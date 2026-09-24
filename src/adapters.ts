import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { GeppettoError } from "./markdown.ts";
import { writeAtomic } from "./state.ts";

/**
 * Adapters are RENDERERS: they point an existing coding agent at Geppetto's generated working context.
 * They never become a source of truth, and they only ever write inside a delimited managed block,
 * so user-authored instructions are preserved and `geppetto adapter remove` restores the original file.
 */
export const CONTEXT_FILE = ".geppetto/generated/context.md";
export const BEGIN = "<!-- geppetto:begin — managed by Geppetto; remove with `geppetto adapter remove`. Content outside this block is yours and is never modified. -->";
export const END = "<!-- geppetto:end -->";
const BEGIN_RE = /<!-- geppetto:begin\b[^>]*-->/;

export interface Adapter { id: string; agent: string; file: string; block: string }

export const ADAPTERS: Adapter[] = [
  { id: "claude", agent: "Claude Code", file: "CLAUDE.md",
    block: `## Geppetto working context\n\nCompiled for the current task from accepted project state (\`geppetto task "..."\`). When done, fill the handoff it names and run \`geppetto capture\`.\n\n@${CONTEXT_FILE}` },
  { id: "agents", agent: "AGENTS.md agents (Codex, OpenCode, ...)", file: "AGENTS.md",
    block: `## Geppetto working context\n\nBefore starting a task, read \`${CONTEXT_FILE}\` — context compiled for the current task from accepted project state (\`geppetto task "..."\`). When done, fill the handoff it names and run \`geppetto capture\`.` },
];

/**
 * Known agent instruction files, rules directories and config markers, by project-relative path.
 * `instructions` files can be imported (as candidates) by `geppetto init`; `rules-dir` and `config` are reported only.
 * `servedBy` names the Geppetto adapter whose file that agent already reads.
 */
export interface AgentFile { path: string; agent: string; kind: "instructions" | "rules-dir" | "config"; servedBy?: string }
export const AGENT_FILES: AgentFile[] = [
  { path: "CLAUDE.md", agent: "Claude Code", kind: "instructions", servedBy: "claude" },
  { path: ".claude/CLAUDE.md", agent: "Claude Code", kind: "instructions" },
  { path: "CLAUDE.local.md", agent: "Claude Code (personal, usually gitignored)", kind: "instructions" },
  { path: "AGENTS.md", agent: "AGENTS.md agents (Codex, OpenCode, ...)", kind: "instructions", servedBy: "agents" },
  { path: "GEMINI.md", agent: "Gemini CLI", kind: "instructions" },
  { path: ".github/copilot-instructions.md", agent: "GitHub Copilot", kind: "instructions" },
  { path: ".cursorrules", agent: "Cursor (legacy rules file)", kind: "instructions" },
  { path: ".windsurfrules", agent: "Windsurf", kind: "instructions" },
  { path: ".clinerules", agent: "Cline", kind: "instructions" },
  { path: ".cursor/rules", agent: "Cursor", kind: "rules-dir" },
  { path: ".windsurf/rules", agent: "Windsurf", kind: "rules-dir" },
  { path: ".github/instructions", agent: "GitHub Copilot (path-specific)", kind: "rules-dir" },
  { path: "opencode.json", agent: "OpenCode", kind: "config", servedBy: "agents" },
  { path: ".opencode", agent: "OpenCode", kind: "config", servedBy: "agents" },
  { path: ".gemini", agent: "Gemini CLI", kind: "config" },
];

export interface Detected { agent: string; path: string; kind: AgentFile["kind"]; adapter?: string; managed: boolean; files?: number }

/** Existing agent instruction files. Read-only. A path that exists as a directory is reported as a rules directory. */
export function detectAgents(root: string): Detected[] {
  const out: Detected[] = [];
  for (const a of AGENT_FILES) {
    const p = join(root, a.path);
    if (!existsSync(p)) continue;
    const dir = statSync(p).isDirectory();
    if (a.kind === "instructions" && dir) { // e.g. .clinerules can be a file or a folder of rules
      out.push({ agent: a.agent, path: a.path, kind: "rules-dir", managed: false, files: readdirSync(p).length });
    } else if (dir) {
      out.push({ agent: a.agent, path: a.path, kind: a.kind, adapter: a.servedBy, managed: false, files: readdirSync(p).length });
    } else {
      out.push({ agent: a.agent, path: a.path, kind: a.kind, adapter: a.servedBy, managed: a.kind === "instructions" && BEGIN_RE.test(readFileSync(p, "utf8")) });
    }
  }
  return out;
}

function adapter(id: string): Adapter {
  const a = ADAPTERS.find((x) => x.id === id);
  if (!a) throw new GeppettoError(`unknown adapter ${JSON.stringify(id)}; available: ${ADAPTERS.map((x) => x.id).join(", ")}`);
  return a;
}

/** Locate the managed block. Malformed markers (begin without end, duplicates) are an error — never guess. */
function blockRange(text: string, file: string): [number, number] | undefined {
  const b = text.search(BEGIN_RE);
  const e = text.indexOf(END);
  if (b < 0 && e < 0) return undefined;
  if (b < 0 || e < 0 || e < b) throw new GeppettoError(`${file}: malformed Geppetto managed block (unmatched begin/end marker); fix it by hand`);
  if (text.slice(b + 1).search(BEGIN_RE) >= 0 || text.indexOf(END, e + 1) >= 0) throw new GeppettoError(`${file}: more than one Geppetto managed block; fix it by hand`);
  return [b, e + END.length];
}

export function installAdapter(root: string, id: string): { file: string; action: "created" | "updated" | "unchanged" } {
  const a = adapter(id);
  const path = join(root, a.file);
  const existed = existsSync(path);
  const text = existed ? readFileSync(path, "utf8") : "";
  const managed = `${BEGIN}\n${a.block}\n${END}`;
  const r = blockRange(text, a.file);
  const next = r ? text.slice(0, r[0]) + managed + text.slice(r[1]) : (text.trimEnd() ? text.trimEnd() + "\n\n" : "") + managed + "\n";
  if (next === text) return { file: a.file, action: "unchanged" };
  writeAtomic(path, next);
  return { file: a.file, action: existed ? "updated" : "created" };
}

/** Remove only the managed block. A file left empty contained nothing of the user's, so it is deleted. */
export function removeAdapter(root: string, id: string): { file: string; action: "removed" | "deleted" | "absent" } {
  const a = adapter(id);
  const path = join(root, a.file);
  if (!existsSync(path)) return { file: a.file, action: "absent" };
  const text = readFileSync(path, "utf8");
  const r = blockRange(text, a.file);
  if (!r) return { file: a.file, action: "absent" };
  const next = (text.slice(0, r[0]).trimEnd() + "\n" + text.slice(r[1]).replace(/^\n+/, "\n")).replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
  if (!next.trim()) { rmSync(path); return { file: a.file, action: "deleted" }; }
  writeAtomic(path, next.trimEnd() + "\n");
  return { file: a.file, action: "removed" };
}
