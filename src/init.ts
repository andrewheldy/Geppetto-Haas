import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectAgents, type Detected } from "./adapters.ts";
import { writeCandidate } from "./capture.ts";
import { serializeFrontmatter, str } from "./markdown.ts";
import { layout, loadCandidates, writeAtomic, type Layout } from "./state.ts";

export interface InitReport { root: string; created: string[]; kept: string[]; agents: Detected[]; imports: string[]; skippedImports: string[]; facts: string[] }

const README = `# .geppetto — project state for coding agents

Managed by Geppetto (see the Geppetto README). Plain Markdown; edit with any editor, review with Git.

| Directory | Information type | Meaning | In Git? |
|---|---|---|---|
| \`context/\` | **canonical state** | What this project accepts as true. Edit intentionally; agents never write here directly. | yes |
| \`runs/\` | **episodic memory** | What happened in past agent runs. Evidence, may be stale, not truth. | yes |
| \`candidates/\` | **candidate state** | Proposed changes to \`context/\`, awaiting \`geppetto reconcile\`. | yes |
| \`generated/\` | **working context** (derived) | Per-task context and handoff templates. Disposable. | no |

Files in \`context/\` with \`include: always\` in their frontmatter are always given to agents; keep them short.
Other sections are selected per task by relevance. Optional lines inside a section help selection:
\`Tags: adapters, cli\` and \`Paths: src/adapters.ts\`.
`;

const TEMPLATES: Record<string, (facts: string[]) => string> = {
  "project.md": (facts) => serializeFrontmatter({ include: "always" }, `# Project

## Purpose
<!-- One short paragraph: what this project is and who it is for. This file is always given to agents — keep it short. -->

## Stack and commands
<!-- Detected by geppetto init; correct as needed. -->
${facts.length ? facts.map((f) => `- ${f}`).join("\n") : "<!-- nothing detected -->"}
`),
  "constraints.md": () => serializeFrontmatter({ include: "always" }, `# Constraints
<!--
Rules every agent must follow. Always included in working context, so keep each one short.
One "## " section per constraint, e.g.

## No new runtime dependencies
Use the Node standard library only.
-->
`),
  "architecture.md": () => `# Architecture
<!--
One "## " section per component or concept. Selected per task by relevance.
Optional lines help selection and future graph derivation:
Tags: adapters, cli
Paths: src/adapters.ts
-->
`,
  "decisions.md": () => `# Decisions
<!--
Decisions still in force, one "## " section each, e.g.

## D-001: Markdown + Git is the source of truth
Status: accepted · Date: 2026-01-01
Supersedes: (none)
Why and consequences in a few lines.
-->
`,
};

function detectFacts(root: string): string[] {
  const facts: string[] = [];
  const has = (f: string) => existsSync(join(root, f));
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      if (pkg.name) facts.push(`Package: \`${pkg.name}\`${pkg.description ? ` — ${pkg.description}` : ""}`);
      facts.push(`Runtime: Node.js${has("tsconfig.json") ? " + TypeScript" : ""}${pkg.engines?.node ? ` (engines.node ${pkg.engines.node})` : ""}`);
      for (const s of ["test", "typecheck", "lint", "build"]) if (pkg.scripts?.[s]) facts.push(`${s[0].toUpperCase() + s.slice(1)}: \`npm run ${s}\` → \`${pkg.scripts[s]}\``);
    } catch { facts.push("package.json present but not valid JSON"); }
  }
  for (const [f, what] of [["pyproject.toml", "Python (pyproject.toml)"], ["Cargo.toml", "Rust (Cargo.toml)"], ["go.mod", "Go (go.mod)"], ["Makefile", "Makefile present"]] as const) if (has(f)) facts.push(what);
  return facts;
}

/** Strip Geppetto's own managed block and demote headings so imported text fits inside one canonical section. */
function importable(text: string): string {
  let fence = false;
  return text.replace(/<!-- geppetto:begin\b[\s\S]*?<!-- geppetto:end -->/g, "").split("\n").map((l) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    return !fence && /^#{1,4} /.test(l) ? "##" + l : l;
  }).join("\n").trim();
}

/**
 * Idempotent bootstrap. Creates only what is missing; never overwrites existing state or agent instruction files.
 * Existing agent instructions are imported as CANDIDATES (not canonical) because they may be stale or conflicting.
 */
export function init(root: string, opts: { now?: Date } = {}): InitReport {
  const L: Layout = layout(root);
  const created: string[] = []; const kept: string[] = [];
  for (const d of [L.context, L.runs, L.candidates, L.generated]) mkdirSync(d, { recursive: true });
  const facts = detectFacts(root);
  const files: Record<string, string> = { "README.md": README, ".gitignore": "generated/\n" };
  for (const [name, t] of Object.entries(TEMPLATES)) files[`context/${name}`] = t(facts);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(L.dir, rel);
    if (existsSync(p)) kept.push(rel); else { writeAtomic(p, content); created.push(rel); }
  }

  const agents = detectAgents(root);
  const existing = loadCandidates(L);
  const imports: string[] = []; const skippedImports: string[] = [];
  for (const a of agents.filter((x) => x.kind === "instructions")) {
    if (existing.some((c) => str(c.data.source) === a.path)) { skippedImports.push(a.path); continue; }
    const content = importable(readFileSync(join(root, a.path), "utf8"));
    if (!content) continue;
    imports.push(writeCandidate(L, { title: `Import existing instructions from ${a.path}`, op: "add", target: "conventions.md", heading: `From ${a.path}`,
      why: `Found by geppetto init. These instructions were written for ${a.agent} and may be stale or conflict with other state. Approve, edit down to durable facts, or reject. ${a.path} itself is left untouched.`,
      content, base: "absent", extra: { source: a.path } }, opts.now));
  }
  return { root, created, kept, agents, imports, skippedImports, facts };
}
