import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { HSCManager } from "../src/hsc.ts";
import { HistoricalStore } from "../src/history.ts";
import { Tracer } from "../src/trace.ts";
import { ContextGovernor } from "../src/governor.ts";
import { node } from "../src/planner.ts";
import { tmp } from "./helpers.ts";

function gov() {
  const d = tmp();
  const hsc = new HSCManager("w", "o");
  const hist = new HistoricalStore(join(d, "h.jsonl"));
  const tr = new Tracer(join(d, "t.jsonl"), { workflow_id: "w", mode: "governed" });
  return { g: new ContextGovernor(hsc, hist, tr), hsc, hist, tr };
}

test("compaction keeps signal lines, stores raw in L2, and reports sizes", () => {
  const { g, hist, tr } = gov();
  const raw = ["Running tests", ...Array.from({ length: 200 }, (_, i) => `noise line ${i} lorem ipsum`), "src/widget.ts created", "# pass 3", "# fail 1", "Error: expected 2 got 3", "done"].join("\n");
  const n = node({ node_id: "test", objective: "", node_type: "test" });
  const c = g.compact(raw, { node_id: n.node_id, trigger: "large tool output", type: "tool_output" });
  assert.ok(c.post_tokens < c.pre_tokens / 5);
  assert.match(c.summary, /# fail 1/);
  assert.match(c.summary, /src\/widget.ts created/);
  assert.equal(hist.get(c.history_ref)?.content, raw, "original preserved verbatim");
  assert.equal(tr.count("context.compacted"), 1);
  assert.ok(c.classification.dropped > 150);
});

test("rehydration retrieves the smallest slice from HSC + L2 with provenance and is traced", () => {
  const { g, hsc, hist, tr } = gov();
  hsc.add({ kind: "decision", content: "ledger format is JSONL not CSV", status: "accepted", producer: "a" });
  hist.append({ type: "agent_output", node_id: "plan", tags: ["plan"], content: "We chose JSONL for the ledger because it appends cheaply." });
  hist.append({ type: "agent_output", node_id: "x", tags: ["x"], content: "unrelated content about widgets" });
  const r = g.rehydrate("ledger format JSONL", node({ node_id: "implement", objective: "", node_type: "implement" }));
  assert.ok(r.sources.length >= 2);
  assert.match(r.text, /JSONL/);
  assert.ok(!r.text.includes("widgets"));
  assert.equal(g.retrievals, 1);
  assert.equal(tr.count("context.retrieved"), 1);
});

test("admission fits a token budget and prefers relevant items", () => {
  const { g } = gov();
  const n = node({ node_id: "review", objective: "", node_type: "review", required_capabilities: ["code_review"] });
  const items = [
    { name: "big", text: "x".repeat(4000), tags: ["file"], provenance: [], priority: 60 },
    { name: "relevant", text: "y".repeat(400), tags: ["code_review"], provenance: [], priority: 60 },
    { name: "task", text: "z".repeat(100), tags: ["task"], provenance: [], priority: 100 },
  ];
  const { admitted, discarded } = g.admit(items, n, 300);
  assert.deepEqual(admitted.map((i) => i.name), ["task", "relevant"]);
  assert.deepEqual(discarded.map((i) => i.name), ["big"]);
});

test("govern() decays and reconciles conflicts, escalating ties", () => {
  const { g, hsc, tr } = gov();
  hsc.add({ kind: "fact", key: "k", content: "A", status: "accepted", producer: "x", confidence: 0.5 });
  hsc.add({ kind: "fact", key: "k", content: "B", status: "accepted", producer: "y", confidence: 0.5 });
  const r = g.govern(1);
  assert.equal(r.conflicts, 1); assert.equal(r.escalated, 1);
  assert.equal(tr.count("state.conflict"), 1);
});
