import { test } from "node:test";
import assert from "node:assert/strict";
import { HSCManager } from "../src/hsc.ts";
import { task } from "./helpers.ts";

test("candidate state is not injectable until promoted; rejection preserves the entry", () => {
  const h = HSCManager.fromTask("w", task());
  const e = h.add({ kind: "decision", content: "use JSONL", producer: "agent-1" });
  assert.equal(e.status, "candidate");
  assert.ok(!h.slice().some((x) => x.id === e.id));
  h.promote([e.id], "validated");
  assert.ok(h.slice({ kinds: ["decision"] }).some((x) => x.id === e.id));
  h.reject([e.id], "later invalidated");
  assert.equal(h.get(e.id).status, "rejected");
  assert.ok(h.state.entries.some((x) => x.id === e.id), "rejected entries are kept, not deleted");
});

test("supersede links provenance; conflicts become contested and resolve by evidence", () => {
  const h = new HSCManager("w", "o");
  const a = h.add({ kind: "fact", key: "port", content: "port is 8080", status: "accepted", producer: "x" });
  const b = h.add({ kind: "fact", key: "port", content: "port is 9090", status: "accepted", producer: "y", evidence_refs: ["h1"] });
  const conflicts = h.detectConflicts();
  assert.equal(conflicts.length, 1);
  assert.equal(h.get(a.id).status, "contested");
  const win = h.resolve(a, b);
  assert.equal(win?.id, b.id);
  assert.equal(h.get(a.id).status, "superseded");
  assert.equal(h.get(a.id).superseded_by, b.id);
  const c = h.add({ kind: "fact", key: "port", content: "port is 7070", status: "accepted", producer: "z", supersedes: b.id });
  assert.equal(h.get(b.id).superseded_by, c.id);
});

test("volatile entries decay to stale after 4 node executions; durable ones do not", () => {
  const h = new HSCManager("w", "o");
  const v = h.add({ kind: "assumption", content: "cache is warm", status: "tentative", producer: "a" });
  const d = h.add({ kind: "constraint", content: "no deps", status: "accepted", producer: "user" });
  h.nodeIndex = 4;
  const stale = h.decay();
  assert.deepEqual(stale.map((e) => e.id), [v.id]);
  assert.equal(h.get(d.id).status, "accepted");
  assert.ok(!h.slice().some((e) => e.id === v.id));
});

test("slice honours token budget and ranks accepted first", () => {
  const h = new HSCManager("w", "o");
  h.add({ kind: "question", content: "q".repeat(400), status: "active", producer: "a" });
  const acc = h.add({ kind: "decision", content: "small decision", status: "accepted", producer: "a" });
  const s = h.slice({ max_tokens: 20 });
  assert.deepEqual(s.map((e) => e.id), [acc.id]);
});
