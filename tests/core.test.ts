import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BEGIN, detectAgents, END, installAdapter, removeAdapter } from "../src/adapters.ts";
import { capture, parseHandoff } from "../src/capture.ts";
import { init } from "../src/init.ts";
import { GeppettoError, parseFrontmatter, serializeFrontmatter, splitSections, stripComments } from "../src/markdown.ts";
import { approve, checkCandidate, defer, findCandidate, reject } from "../src/reconcile.ts";
import { compileContext } from "../src/compile.ts";
import { layout, loadCandidates, loadCanonical, loadRuns, type Layout } from "../src/state.ts";
import { estimateTokens } from "../src/tokens.ts";
import { fixtureRepo, handoff, read, snapshot, write } from "./fixture.ts";

function setup(files: Record<string, string> = {}): Layout {
  const root = fixtureRepo(files);
  init(root);
  return layout(root);
}

const compile = (L: Layout, task: string, budgetTokens = 2000) => compileContext(L, task, { budgetTokens, handoff: "h.md" });

test("frontmatter round-trips and malformed frontmatter fails loudly", () => {
  const text = serializeFrontmatter({ id: "c-1", task: "fix: the #1 bug", tags: ["a", "b"], empty: "" }, "# T\n");
  assert.deepEqual(parseFrontmatter(text).data, { id: "c-1", task: "fix: the #1 bug", tags: ["a", "b"], empty: "" });
  assert.throws(() => parseFrontmatter("---\nid: x\n# never closed\n"), GeppettoError);
  assert.throws(() => parseFrontmatter("---\nnot a pair\n---\n"), GeppettoError);
});

test("sections ignore ## inside code fences and HTML comments", () => {
  const s = splitSections("# F\n<!--\n## Example\n-->\n## Real\n```\n## not a heading\n```\n## Real\nx\n");
  assert.deepEqual(s.sections.map((x) => x.slug), ["real", "real-1"]);
});

test("init creates the four stores, preserves user files, and is idempotent", () => {
  const root = fixtureRepo({ "AGENTS.md": "# Agents\n\nRun npm test.\n", ".cursor/rules/x.mdc": "rule" });
  const before = { claude: read(root, "CLAUDE.md"), agents: read(root, "AGENTS.md"), cursor: read(root, ".cursor/rules/x.mdc") };
  const r1 = init(root);
  const L = layout(root);
  for (const d of [L.context, L.runs, L.candidates, L.generated]) assert.ok(existsSync(d), d);
  assert.equal(r1.imports.length, 2, "CLAUDE.md and AGENTS.md proposed as candidates");
  assert.equal(loadCanonical(L).sections.some((s) => s.body.includes("Use tabs")), false, "imports are not canonical");
  write(root, ".geppetto/context/constraints.md", "---\ninclude: always\n---\n# Constraints\n\n## Mine\nhand-written\n");
  const state = snapshot(L.dir);
  const r2 = init(root);
  assert.deepEqual(snapshot(L.dir), state, "re-init changes nothing");
  assert.equal(r2.created.length, 0);
  assert.deepEqual(r2.skippedImports.sort(), ["AGENTS.md", "CLAUDE.md"]);
  assert.deepEqual({ claude: read(root, "CLAUDE.md"), agents: read(root, "AGENTS.md"), cursor: read(root, ".cursor/rules/x.mdc") }, before);
  assert.equal(read(root, ".geppetto/.gitignore").trim(), "generated/");
});

test("canonical state loads with stable ids, always-flags, tags and paths", () => {
  const L = setup();
  write(L.root, ".geppetto/context/architecture.md", "# Architecture\n<!-- guidance -->\n\n## Adapter layer\nTags: adapters\nPaths: src/adapters.ts\nRenderers only.\n");
  const s = loadCanonical(L).sections.find((x) => x.id === "architecture.md#adapter-layer")!;
  assert.deepEqual([s.always, s.tags, s.paths, s.body.includes("guidance")], [false, ["adapters"], ["src/adapters.ts"], false]);
  assert.ok(loadCanonical(L).sections.filter((x) => x.file === "project.md").every((x) => x.always));
});

test("working context is bounded, deterministic, and never drops essential constraints silently", () => {
  const L = setup();
  const many = Array.from({ length: 30 }, (_, i) => `## Adapter note ${i}\nadapter detection detail ${"lorem ipsum ".repeat(40)}\n`).join("\n");
  write(L.root, ".geppetto/context/architecture.md", `# Architecture\n\n${many}`);
  const a = compile(L, "Improve adapter detection", 1200);
  assert.ok(estimateTokens(a.md) <= 1200, `rendered ${estimateTokens(a.md)} tokens`);
  assert.ok(a.sel.omitted.length > 0 && a.md.includes("Relevant but over budget"));
  assert.equal(a.md, compile(L, "Improve adapter detection", 1200).md, "same inputs → identical output");

  write(L.root, ".geppetto/context/constraints.md", `---\ninclude: always\n---\n# Constraints\n\n## Huge rule\n${"must hold ".repeat(600)}\n`);
  const b = compile(L, "Improve adapter detection", 1000);
  assert.ok(b.md.includes("## Huge rule") || b.md.includes("› Huge rule"), "essential section kept");
  assert.ok(b.md.includes("Budget warning"), "overflow surfaced");
});

test("adapter blocks preserve user content byte-for-byte and are removable", () => {
  const L = setup();
  const original = read(L.root, "CLAUDE.md");
  installAdapter(L.root, "claude");
  const installed = read(L.root, "CLAUDE.md");
  assert.ok(installed.startsWith(original.trimEnd()) && installed.includes(BEGIN) && installed.includes("@.geppetto/generated/context.md"));
  assert.equal(installAdapter(L.root, "claude").action, "unchanged");
  removeAdapter(L.root, "claude");
  assert.equal(read(L.root, "CLAUDE.md"), original);
  installAdapter(L.root, "agents");
  assert.equal(removeAdapter(L.root, "agents").action, "deleted", "a file Geppetto created is removed again");
  write(L.root, "AGENTS.md", `mine\n${BEGIN}\nno end marker\n`);
  assert.throws(() => installAdapter(L.root, "agents"), /malformed/);
  assert.equal(read(L.root, "AGENTS.md"), `mine\n${BEGIN}\nno end marker\n`);
  void END;
});

const ADD = "### Proposal: Detection lives in adapters.ts\n- op: add\n- target: architecture.md\n- heading: Agent detection\n- why: learned in run\n\nDetection is read-only; see `src/adapters.ts`.\n";

test("capture writes episodic + candidate state and leaves canonical untouched", () => {
  const L = setup();
  const before = snapshot(L.context);
  const r = capture(L, handoff("Improve adapter detection", ADD));
  assert.deepEqual(snapshot(L.context), before);
  assert.equal(loadRuns(L)[0].task, "Improve adapter detection");
  const c = findCandidate(L, "c-0002");
  assert.equal(c.status, "pending");
  assert.equal(c.data.run, "r-0001");
  assert.ok(r.candidates[0].startsWith("candidates/c-0002-"));
});

test("malformed handoffs fail without writing anything", () => {
  const L = setup();
  const before = snapshot(L.dir);
  const bad = [
    handoff("x", ADD).replace(/## Summary\n\nDid the thing for: x\./, "## Summary\n"),
    handoff("x", ADD.replace("- op: add", "- op: merge")),
    handoff("x", ADD.replace("target: architecture.md", "target: ../../etc/passwd.md")),
    handoff("x", ADD + "\n## Sneaky\nsplit\n"),
    handoff("x", ADD.replace("- op: add\n- target: architecture.md", "- op: replace\n- target: architecture.md#nope")),
    "---\ntask: x\noutcome: success\n# unterminated",
  ];
  for (const text of bad) assert.throws(() => capture(L, text), GeppettoError);
  assert.deepEqual(snapshot(L.dir), before);
  assert.equal(parseHandoff(handoff("x", "")).proposals.length, 0);
});

test("approve promotes; reject and defer leave canonical unchanged; edits still need approval", () => {
  const L = setup();
  const two = ADD + "\n### Proposal: Speculative idea\n- op: add\n- target: architecture.md\n- heading: Parse CLAUDE.md semantics\n\nUse an LLM to parse instruction files.\n"
    + "\n### Proposal: Later maybe\n- op: add\n- target: decisions.md\n- heading: D-9 Maybe\n\nNot sure yet.\n";
  capture(L, handoff("Improve adapter detection", two));
  const base = snapshot(L.context);

  reject(L, "c-0003", { by: "tester", note: "too speculative" });
  defer(L, "c-0004", { by: "tester" });
  assert.deepEqual(snapshot(L.context), base, "reject/defer do not touch canonical");
  assert.equal(findCandidate(L, "c-0003").status, "rejected");
  assert.equal(findCandidate(L, "c-0004").status, "deferred");
  assert.throws(() => approve(L, "c-0003", { by: "t" }), /already rejected/);

  const c = findCandidate(L, "c-0002");
  write(L.root, `.geppetto/candidates/${c.file}`, read(L.root, `.geppetto/candidates/${c.file}`).replace("Detection is read-only", "Detection is strictly read-only"));
  assert.equal(findCandidate(L, "c-0002").status, "pending", "editing does not approve");
  assert.equal(findCandidate(L, "c-0002").edited, true);
  assert.deepEqual(snapshot(L.context), base);

  approve(L, "c-0002", { by: "tester" });
  const arch = read(L.root, ".geppetto/context/architecture.md");
  assert.ok(arch.includes("## Agent detection\n\nDetection is strictly read-only"));
  assert.equal(findCandidate(L, "c-0002").data.edited_before_approval, "true");
  assert.equal(loadCanonical(L).sections.some((s) => s.body.includes("LLM to parse")), false, "rejected content never canonical");
  approve(L, "c-0004", { by: "tester" });
  assert.ok(read(L.root, ".geppetto/context/decisions.md").includes("## D-9 Maybe"), "deferred can be approved later");
});

test("stale and conflicting targets fail safely", () => {
  const L = setup();
  write(L.root, ".geppetto/context/architecture.md", "# Architecture\n\n## Adapters\nOld text.\n\n## Other\nKeep.\n");
  capture(L, handoff("t", "### Proposal: Update adapters\n- op: replace\n- target: architecture.md#adapters\n\nNew text.\n\n" + ADD));
  // a human edits the target section after the proposal was made
  write(L.root, ".geppetto/context/architecture.md", "# Architecture\n\n## Adapters\nHuman rewrote this.\n\n## Other\nKeep.\n\n## Agent detection\nAlready here.\n");
  const before = snapshot(L.context);
  assert.match(checkCandidate(L, findCandidate(L, "c-0002"))!, /STALE/);
  assert.throws(() => approve(L, "c-0002", { by: "t" }), /STALE/);
  assert.throws(() => approve(L, "c-0003", { by: "t" }), /CONFLICT/);
  assert.deepEqual(snapshot(L.context), before);
  assert.equal(findCandidate(L, "c-0002").status, "pending");
});

test("replace keeps the other sections and the heading; hand-crafted traversal targets are refused", () => {
  const L = setup();
  write(L.root, ".geppetto/context/architecture.md", "# Architecture\n\n## Adapters\nOld text.\n\n## Other\nKeep.\n");
  capture(L, handoff("t", "### Proposal: Update adapters\n- op: replace\n- target: architecture.md#adapters\n\nNew text.\n"));
  approve(L, "c-0002", { by: "t" });
  assert.equal(read(L.root, ".geppetto/context/architecture.md"), "# Architecture\n\n## Adapters\n\nNew text.\n\n## Other\nKeep.\n");
  write(L.root, ".geppetto/candidates/c-0099-evil.md", "---\nid: c-0099\nstatus: pending\nop: add\ntarget: ../README.md\nheading: pwned\nbase: absent\n---\n# Evil\n\n## Proposed content\n\nx\n");
  const before = read(L.root, ".geppetto/README.md");
  assert.throws(() => approve(L, "c-0099", { by: "t" }), /not a file in .geppetto\/context/);
  assert.equal(read(L.root, ".geppetto/README.md"), before);
});

test("the four information types stay distinguishable in working context", () => {
  const L = setup();
  write(L.root, ".geppetto/context/architecture.md", "# Architecture\n\n## Adapter layer\nAdapters are renderers.\n");
  capture(L, handoff("Improve adapter detection", ADD, "adapter detection missed .cursor rules"));
  const { md } = compile(L, "Improve adapter detection");
  const at = (s: string) => md.indexOf(s);
  assert.ok(at("## Accepted project state") < at("Adapters are renderers.") && at("Adapters are renderers.") < at("## Historical evidence"));
  assert.ok(md.includes("## Historical evidence (not accepted truth; may be stale)") && md.includes("Discovered: adapter detection missed .cursor rules"));
  assert.ok(md.includes("## Pending proposals (NOT accepted") && md.includes("c-0002 [pending]"));
  assert.equal(md.includes("Detection is read-only"), false, "pending content is never shown as state");
  assert.ok(!existsSync(join(L.root, "src/.geppetto")));
});

test("agent detection covers instruction files, rules directories and config markers, read-only", () => {
  const root = fixtureRepo({
    "AGENTS.md": "# Agents\n", "GEMINI.md": "Be brief.\n", ".github/copilot-instructions.md": "Prefer small PRs.\n",
    ".cursor/rules/style.mdc": "---\nalwaysApply: true\n---\nstyle", ".clinerules/one.md": "x", "opencode.json": "{}",
  });
  const before = snapshot(root);
  const found = detectAgents(root);
  const by = (p: string) => found.find((d) => d.path === p);
  assert.deepEqual(found.map((d) => d.path).sort(), [".clinerules", ".cursor/rules", ".github/copilot-instructions.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "opencode.json"]);
  assert.equal(by("CLAUDE.md")!.adapter, "claude");
  assert.deepEqual([by(".cursor/rules")!.kind, by(".cursor/rules")!.files], ["rules-dir", 1]);
  assert.equal(by(".clinerules")!.kind, "rules-dir", "a folder where a file is usual is treated as a rules dir");
  assert.deepEqual([by("opencode.json")!.kind, by("opencode.json")!.adapter], ["config", "agents"]);
  assert.deepEqual(snapshot(root), before, "detection writes nothing");
  const r = init(root);
  assert.deepEqual(r.imports.map((p) => p.replace(/^candidates\/c-\d+-/, "")).sort(),
    ["import-existing-instructions-from-agents-md.md", "import-existing-instructions-from-claude-md.md", "import-existing-instructions-from-gemini-md.md",
     "import-existing-instructions-from-github-copilot.md"], "only single instruction files are imported; dirs and config are reported");
});

test("comments quoted in inline code survive; a dirty tree adds at most +1 per section", () => {
  assert.equal(stripComments("Markers `<!-- a -->` and <!-- hidden --> text"), "Markers `<!-- a -->` and  text");
  const L = setup({ "src/a.ts": "", "src/b.ts": "", "src/c.ts": "" });
  write(L.root, ".geppetto/context/architecture.md", "# Architecture\n\n## Parser\nPaths: src/a.ts, src/b.ts, src/c.ts\nParses things.\n");
  for (const f of ["src/a.ts", "src/b.ts", "src/c.ts"]) write(L.root, f, "changed");
  assert.equal(compile(L, "Improve logging").sel.relevant.length, 0, "uncommitted changes alone do not make a section relevant");
  assert.equal(compile(L, "Fix src/a.ts parsing").sel.relevant[0]?.item.id, "architecture.md#parser");
});
