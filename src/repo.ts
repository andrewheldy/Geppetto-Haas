import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Raw repository facts the selector may use. Gathered here so selection itself stays pure and testable. */
export interface RepoFacts { files: string[]; changed: string[]; git: boolean }

const git = (root: string, args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

export function isGitRepo(root: string): boolean {
  try { return git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true"; } catch { return false; }
}

export function repoFacts(root: string): RepoFacts {
  if (isGitRepo(root)) {
    const files = git(root, ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
    const changed = git(root, ["status", "--porcelain"]).split("\n").filter(Boolean).map((l) => l.slice(3).split(" -> ").pop()!.replace(/^"|"$/g, ""));
    return { files: [...new Set(files)].sort(), changed: changed.sort(), git: true };
  }
  return { files: walk(root), changed: [], git: false };
}

function walk(root: string, rel = "", out: string[] = []): string[] {
  for (const name of readdirSync(join(root, rel)).sort()) {
    if (out.length >= 5000) break;
    if (name.startsWith(".") || name === "node_modules") continue;
    const p = rel ? `${rel}/${name}` : name;
    if (statSync(join(root, p)).isDirectory()) walk(root, p, out); else out.push(p);
  }
  return out;
}

/** Tokens in the task text that name an existing file or directory. */
export function mentionedPaths(root: string, task: string): string[] {
  const cands = task.match(/[\w@.-]*[\w-]\/[\w./@-]*|[\w-]+\.[a-z]{1,5}\b/gi) ?? [];
  return [...new Set(cands.map((c) => c.replace(/[.,:;]+$/, "")).filter((c) => !c.startsWith(".geppetto") && existsSync(join(root, c))))].sort();
}

export function gitStatusOf(root: string, rel: string): string[] {
  try { return git(root, ["status", "--porcelain", "--", rel]).split("\n").filter(Boolean); } catch { return []; }
}
