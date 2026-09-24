import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../src/lab/types.ts";

export function tmp(): string { return mkdtempSync(join(tmpdir(), "geppetto-")); }

export function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1", objective: "Implement a widget module with tests", kind: "software_build",
    constraints: ["no new dependencies"], acceptance_criteria: [{ type: "file_exists", path: "src/widget.ts" }, { type: "command", cmd: "npm test" }],
    context_files: ["src/a.ts"], test_command: "npm test", budget: { max_usd: 5 }, ...over,
  };
}

/** A tiny fake repo for workspaces. */
export function fakeRepo(): string {
  const d = tmp();
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "fake", scripts: { test: "echo ok" } }));
  return d;
}
