import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fixtureRepo, handoff, ok, read, run, snapshot, write } from "./fixture.ts";

/**
 * The V0.1 acceptance loop through the real CLI on a disposable repo:
 * init → task → (agent works) → capture → candidate ≠ canonical → reconcile → task 2 sees accepted knowledge → clean.
 * Approval here is explicit test approval (`--by fixture-test`) on a throwaway fixture.
 */
test("full loop: accepted knowledge from task 1 reaches task 2 without any chat history", () => {
  const root = fixtureRepo();
  const claudeBefore = read(root, "CLAUDE.md");

  const init = ok(root, "init");
  assert.match(init, /proposed as candidates, NOT canonical/);
  assert.equal(read(root, "CLAUDE.md"), claudeBefore);
  write(root, ".geppetto/context/constraints.md", "---\ninclude: always\n---\n# Constraints\n\n## Adapters never edit user text\nOnly delimited managed blocks.\n");

  const t1 = ok(root, "task", "Improve adapter detection", "--print");
  assert.match(t1, /^# Working context: Improve adapter detection/);
  assert.match(t1, /Adapters never edit user text/, "always-included constraint present");
  assert.ok(existsSync(join(root, ".geppetto/generated/context.md")));
  const handoffPath = ".geppetto/generated/handoff-improve-adapter-detection.md";
  assert.match(read(root, handoffPath), /task: Improve adapter detection/);

  // the "agent" does the work and fills in the handoff
  write(root, "src/adapters.ts", "export const adapters = ['claude', 'agents', 'cursor'];\n");
  write(root, handoffPath, handoff("Improve adapter detection",
    "### Proposal: Cursor rules location\n- op: add\n- target: architecture.md\n- heading: Cursor adapter surface\n- why: needed by any future Cursor adapter\n\n" +
    "Cursor reads project rules from `.cursor/rules/*.mdc`; a Geppetto-owned file there needs no managed block.\nTags: adapters, cursor\n\n" +
    "### Proposal: Rename everything\n- op: add\n- target: decisions.md\n- heading: D-2 Rename adapters to plugins\n\nCall adapters plugins.\n"));

  const canonBefore = snapshot(join(root, ".geppetto/context"));
  const cap = ok(root, "capture", handoffPath);
  assert.match(cap, /run recorded \(episodic\)/);
  assert.match(cap, /candidates \(pending, NOT canonical\)/);
  assert.deepEqual(snapshot(join(root, ".geppetto/context")), canonBefore, "candidate generation did not modify canonical state");

  // before approval, task 2 sees the proposal only as a pending, unaccepted title
  const pre = ok(root, "task", "Add a Cursor adapter", "--print");
  assert.match(pre, /Pending proposals \(NOT accepted/);
  assert.doesNotMatch(pre, /\.cursor\/rules\/\*\.mdc/);

  assert.match(ok(root, "reconcile"), /c-0002 \[pending\] add → architecture\.md/);
  assert.match(ok(root, "reconcile", "approve", "c-0002", "--by", "fixture-test"), /canonical .*architecture\.md updated/);
  assert.match(ok(root, "reconcile", "reject", "c-0003", "--by", "fixture-test", "--note", "no"), /canonical state unchanged/);
  assert.match(ok(root, "reconcile", "defer", "c-0001", "--by", "fixture-test"), /deferred/);
  assert.match(read(root, ".geppetto/context/architecture.md"), /## Cursor adapter surface/);
  assert.doesNotMatch(read(root, ".geppetto/context/decisions.md"), /plugins/);
  assert.equal(run(root, "reconcile", "approve", "c-0002").code, 1, "cannot approve twice");

  const t2 = ok(root, "task", "Add a Cursor adapter", "--print");
  const accepted = t2.slice(t2.indexOf("## Accepted project state"), t2.indexOf("## Historical evidence"));
  assert.match(accepted, /Cursor adapter surface/);
  assert.match(accepted, /\.cursor\/rules\/\*\.mdc/, "accepted knowledge from task 1 is in task 2's canonical context");
  assert.match(t2, /## Historical evidence[\s\S]*r-0001/, "task 1 appears only as labelled history");
  assert.doesNotMatch(t2, /plugins/, "rejected proposal never appears");

  assert.match(ok(root, "status"), /1 pending|0 pending/);

  // destroy derived output; canonical, episodic and candidate state survive
  const state = snapshot(join(root, ".geppetto"));
  const contextBefore = read(root, ".geppetto/generated/context.md");
  ok(root, "clean");
  assert.equal(existsSync(join(root, ".geppetto/generated")), false);
  const after = snapshot(join(root, ".geppetto"));
  for (const [p, c] of Object.entries(state)) if (!p.startsWith("generated/")) assert.equal(after[p], c, p);
  assert.match(ok(root, "task", "Add a Cursor adapter", "--print"), /Cursor adapter surface/, "context regenerates from canonical state");
  assert.equal(read(root, ".geppetto/generated/context.md"), contextBefore, "regenerated context is byte-identical");
});

test("CLI fails safely: no .geppetto, bad budget, malformed handoff, unknown candidate", () => {
  const root = fixtureRepo();
  assert.match(run(root, "task", "x").err, /run `geppetto init` first/);
  ok(root, "init");
  assert.equal(run(root, "task", "x", "--budget", "5").code, 1);
  write(root, "bad.md", "---\ntask: x\n---\n# Handoff\n\n## Summary\n\n## Proposed changes\n");
  const state = snapshot(join(root, ".geppetto"));
  const r = run(root, "capture", "bad.md");
  assert.equal(r.code, 1);
  assert.match(r.err, /Summary.*missing or empty/);
  assert.equal(run(root, "reconcile", "approve", "c-0404").code, 1);
  assert.deepEqual(snapshot(join(root, ".geppetto")), state);
});

test("adapter install/remove through the CLI round-trips CLAUDE.md", () => {
  const root = fixtureRepo();
  ok(root, "init");
  const before = read(root, "CLAUDE.md");
  ok(root, "adapter", "install", "claude");
  assert.match(ok(root, "status"), /CLAUDE\.md\s+Claude Code \[instructions\] · Geppetto block installed/);
  ok(root, "adapter", "remove", "claude");
  assert.equal(read(root, "CLAUDE.md"), before);
});
