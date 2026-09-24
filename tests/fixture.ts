import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CLI = resolve(import.meta.dirname, "../src/cli.ts");

/** A throwaway Git repository with user-authored agent config, for tests that must never touch the real project. */
export function fixtureRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "geppetto-test-"));
  const all: Record<string, string> = {
    "package.json": JSON.stringify({ name: "demo", description: "demo project", scripts: { test: "node --test" } }),
    "CLAUDE.md": "# House rules\n\nUse tabs.\n",
    "src/adapters.ts": "export const adapters = [];\n",
    ...files,
  };
  for (const [p, c] of Object.entries(all)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: root });
  return root;
}

export function run(cwd: string, ...args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, USER: "tester" } });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

export function ok(cwd: string, ...args: string[]): string {
  const r = run(cwd, ...args);
  if (r.code !== 0) throw new Error(`geppetto ${args.join(" ")} failed (${r.code}): ${r.err || r.out}`);
  return r.out;
}

/** Snapshot of every file under a directory (path → content), for byte-level "unchanged" assertions. */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r); else out[r] = readFileSync(join(d, e.name), "utf8");
    }
  };
  walk(dir, "");
  return out;
}

export const read = (root: string, p: string) => readFileSync(join(root, p), "utf8");
export const write = (root: string, p: string, c: string) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); };

export function handoff(task: string, proposals: string, extra = ""): string {
  return `---\ntask: ${task}\nagent: test-agent\noutcome: success\n---\n# Handoff\n\n## Summary\n\nDid the thing for: ${task}.\n\n## Discoveries\n\n- ${extra || "nothing surprising"}\n\n## Failed approaches\n\n- tried regex parsing of CLAUDE.md; too brittle\n\n## Files changed\n\n- src/adapters.ts\n\n## Proposed changes\n\n${proposals}`;
}
