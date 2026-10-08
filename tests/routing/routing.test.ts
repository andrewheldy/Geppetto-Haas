import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_POLICY as P, PolicyError, classifyTask, extractContextRefs, parseClassification, resolvePolicy, route, routeWithClassifier,
  type AgentOption, type Classifier, type RoutingInput, type TaskKind,
} from "../../plugins/geppetto/core/index.ts";

const AGENTS: AgentOption[] = [
  { id: "general-purpose" }, { id: "Plan", readOnly: true }, { id: "Explore", readOnly: true },
  { id: "my-reviewer", model: "opus" },
];
const r = (task: string, extra: Partial<RoutingInput> = {}) => route({ task, resolvedAgent: "general-purpose", availableAgents: AGENTS, ...extra }, P);

// ---- The six required scenarios ----

test("1. trivial task stays with the current agent", () => {
  const d = r("Fix the typo in README.md: 'recieve' should be 'receive'.", { currentAgent: "main" });
  assert.equal(d.classification.kind, "trivial");
  assert.equal(d.delegate, false);
  assert.match(d.reason, /keep inline/);
  assert.equal(d.maxTurns, P.kinds.trivial.maxTurns);
});

test("2. simple exploration routes to a lightweight model (and the read-only Explore agent when none was asked for)", () => {
  const d = r("Find every place in the codebase where the ledger is written to and report file paths with line numbers.");
  assert.equal(d.action, "route");
  assert.equal(d.alias, "haiku");
  assert.equal(d.model, "claude-haiku-5-5");
  assert.equal(d.apply.agent, "Explore");
  // an explicitly requested agent is never swapped
  assert.equal(r("Find every place where the ledger is written.", { requestedAgent: "general-purpose" }).apply.agent, undefined);
});

test("3. normal implementation routes to Sonnet", () => {
  const d = r("Implement a --json flag for `geppetto status` that prints the same information as JSON. Add it in src/status.ts.");
  assert.equal(d.classification.kind, "implement");
  assert.equal(d.alias, "sonnet");
  assert.deepEqual(d.apply, { model: "claude-sonnet-5-5" });
  assert.ok(d.contextRefs.includes("src/status.ts"));
});

test("4. complex architecture routes to Opus", () => {
  const d = r("Design the architecture for multi-agent handoff across organizations: trust model and the trade-offs of push vs pull.");
  assert.equal(d.classification.kind, "architecture");
  assert.equal(d.alias, "opus");
  assert.equal(d.fallback.strategy, "none", "fable is not authorized, so opus is the top");
  // high-complexity debugging also earns opus
  assert.equal(r("There is an intermittent race condition in the orchestrator tests. Find the root cause.").alias, "opus");
});

test("5. failed execution escalates only with evidence", () => {
  const task = "Implement pagination for the items endpoint in src/api/items.ts.";
  assert.equal(r(task).alias, "sonnet");
  const noEvidence = r(task, { attempts: [{ model: "sonnet", kind: "capability" }] });
  assert.equal(noEvidence.alias, "sonnet");
  assert.match(noEvidence.trace.join("\n"), /no evidence/);
  const interrupted = r(task, { attempts: [{ model: "sonnet", kind: "interrupted", evidence: "user pressed esc" }] });
  assert.equal(interrupted.alias, "sonnet", "an interruption is not evidence a stronger model helps");
  const infra = r(task, { attempts: [{ model: "sonnet", kind: "infra", evidence: "529 overloaded" }] });
  assert.equal(infra.alias, "sonnet");
  const failed = r(task, { attempts: [{ model: "claude-sonnet-5-5", kind: "test_failure", evidence: "items.test.ts: expected next_cursor" }] });
  assert.equal(failed.alias, "opus");
  assert.match(failed.reason, /escalated on evidence/);
  const atTop = r(task, { attempts: [{ model: "opus", kind: "capability", evidence: "could not complete" }] });
  assert.equal(atTop.alias, "opus", "never escalates past maxTier without authorization");
  assert.match(atTop.trace.join("\n"), /strongest permitted tier/);
  const authorized = route({ task, attempts: [{ model: "opus", kind: "capability", evidence: "could not complete" }] }, resolvePolicy({ authorized: ["fable"] }));
  assert.equal(authorized.alias, "fable", "fable only when explicitly authorized");
});

test("6. unsupported routing falls back safely (changes nothing)", () => {
  for (const d of [
    r("Implement a cache layer.", { unsupported: "fork inherits the parent model" }),
    r("Hello."),                                                       // unknown kind
    r("Implement a cache layer.", { resolvedAgent: "acme:deployer" }), // agent the policy does not know
  ]) {
    assert.equal(d.action, "native");
    assert.deepEqual(d.apply, {});
    assert.equal(d.fallback.strategy, "native");
  }
});

// ---- Safety: explicit choices, pins and permissions ----

test("explicit model, user default and agent pins are never overridden", () => {
  const explicit = r("Find where tokens are validated.", { requestedModel: "opus" });
  assert.equal(explicit.action, "keep"); assert.deepEqual(explicit.apply, {}); assert.equal(explicit.model, "claude-opus-5-5");
  const userDefault = r("Find where tokens are validated.", { userDefaultModel: "sonnet" });
  assert.equal(userDefault.action, "keep"); assert.deepEqual(userDefault.apply, {});
  const pinned = r("Review the diff on this branch.", { resolvedAgent: "my-reviewer", requestedAgent: "my-reviewer" });
  assert.equal(pinned.action, "keep"); assert.match(pinned.reason, /pins model "opus"/); assert.deepEqual(pinned.apply, {});
});

test("routing narrows to read-only agents, never widens away from one", () => {
  const fromExplore = r("Implement a cache layer for the API.", { resolvedAgent: "Explore", requestedAgent: "Explore" });
  assert.equal(fromExplore.apply.agent, undefined);
  assert.equal(fromExplore.agent, "Explore");
});

test("high risk never routes below the policy's floor", () => {
  const d = r("Find where the payment webhook secret is read.", { risk: "high" });
  assert.equal(d.alias, "sonnet");
});

test("cheapest tier needs a clear win; competing signals route one tier up", () => {
  const d = r("Run the full pytest suite and tell me which tests fail, if any. Don't fix anything yet.");
  assert.notEqual(d.alias, "haiku");
  assert.match(d.trace.join("\n"), /clear win/);
});

test("model ids come from the policy, so a version change is one line of config", () => {
  const p = resolvePolicy({ models: { sonnet: { id: "claude-sonnet-6-0" } } });
  assert.equal(route({ task: "Implement a --json flag for the status command." }, p).model, "claude-sonnet-6-0");
});

test("policy validation rejects bad ids, unknown keys and dangling aliases", () => {
  assert.throws(() => resolvePolicy({ models: { sonnet: { id: "gpt-4" } } }), PolicyError);
  assert.throws(() => resolvePolicy({ bogus: 1 }), /unknown key "bogus"/);
  assert.throws(() => resolvePolicy({ kinds: { explore: { tier: "nano" } } }), /not a model alias/);
  assert.throws(() => resolvePolicy({ authorized: ["nano"] }), /authorized/);
  assert.equal(resolvePolicy(undefined), P);
});

test("unavailable models are never selected", () => {
  const d = route({ task: "Find where the ledger is written." }, P);
  assert.equal(d.alias, "haiku");
  const noHaiku = route({ task: "Find where the ledger is written.", availableModels: ["sonnet", "opus"] }, P);
  assert.equal(noHaiku.alias, "sonnet");
});

test("every decision is explainable: a reason, a trace and the policy version", () => {
  for (const t of ["Fix the typo.", "Find the config loader.", "Implement retries.", "Design the architecture of X.", "Hello."]) {
    const d = r(t);
    assert.ok(d.reason.length > 10, t); assert.ok(d.trace.length >= 1, t); assert.equal(d.policyVersion, P.version);
  }
});

// ---- Classifier: optional, cost-gated, schema-validated ----

function fake(answer: unknown): Classifier & { calls: number } {
  return { name: "fake", calls: 0, async classify() { this.calls++; if (answer instanceof Error) throw answer; return answer; } };
}
const withClassifier = resolvePolicy({ classifier: { enabled: true } });
const AMBIGUOUS = "Take a look at the payments module and sort out whatever is going on with the reconciliation numbers at month end; the finance team has been asking about it for weeks and nobody has had time to dig into it properly.";

test("classifier is never called for trivial, confident or short tasks", async () => {
  const c = fake({ kind: "debug", complexity: "medium", confidence: 0.9 });
  for (const t of ["Fix the typo in README.md.", "Find every place where the ledger is written and list the files.", "Hello."]) {
    const d = await routeWithClassifier({ task: t }, withClassifier, c);
    assert.equal(d.classifierCalled, false, t);
  }
  assert.equal(c.calls, 0);
  const off = fake({ kind: "debug", complexity: "medium", confidence: 0.9 });
  assert.equal((await routeWithClassifier({ task: AMBIGUOUS }, P, off)).classifierCalled, false, "disabled by default");
  assert.equal(off.calls, 0);
});

test("classifier resolves an ambiguous task, and its bad or failed answers fall back to the rules", async () => {
  assert.equal(classifyTask(AMBIGUOUS).kind === "unknown" || classifyTask(AMBIGUOUS).confidence < 0.6, true);
  const good = fake('{"kind":"debug","complexity":"medium","confidence":0.8}');
  const d = await routeWithClassifier({ task: AMBIGUOUS }, withClassifier, good);
  assert.equal(good.calls, 1); assert.equal(d.classification.source, "classifier"); assert.equal(d.alias, "sonnet");
  const bad = await routeWithClassifier({ task: AMBIGUOUS }, withClassifier, fake({ kind: "vibes", complexity: "x", confidence: 2 }));
  assert.equal(bad.action, "native"); assert.match(bad.trace.join("\n"), /rejected/);
  const thrown = await routeWithClassifier({ task: AMBIGUOUS }, withClassifier, fake(new Error("timeout")));
  assert.equal(thrown.action, "native"); assert.match(thrown.trace.join("\n"), /classifier failed/);
  assert.equal(typeof parseClassification("no json here"), "string");
});

// ---- Measured behavior ----

function score(file: string) {
  const set = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as { kind: TaskKind; task: string }[];
  let ok = 0, routed = 0, under = 0;
  for (const c of set) {
    ok += +(classifyTask(c.task).kind === c.kind);
    const d = route({ task: c.task }, P);
    if (d.action !== "route" || c.kind === "unknown") continue;
    routed++;
    if (P.models[d.alias!]!.rank < P.models[P.kinds[c.kind].tier]!.rank) under++;
  }
  return { n: set.length, accuracy: ok / set.length, routed, under };
}

test("classification accuracy (in-sample corpus, held-out, and an independently written blind set)", () => {
  const corpus = score("./corpus.json"), heldout = score("./heldout.json"), blind = score("./blind.json");
  console.log(`# accuracy corpus=${corpus.accuracy.toFixed(2)} heldout=${heldout.accuracy.toFixed(2)} blind=${blind.accuracy.toFixed(2)}; underpowered blind=${blind.under}/${blind.routed}`);
  assert.ok(corpus.accuracy >= 0.95); assert.ok(heldout.accuracy >= 0.9);
  // The blind set was never tuned on (see docs/ROUTING.md); these are regression floors, not targets.
  assert.ok(blind.accuracy >= 0.6); assert.ok(blind.under <= 2);
});

test("delegation overhead: deterministic routing costs well under a millisecond and no model call", () => {
  const tasks = JSON.parse(readFileSync(new URL("./corpus.json", import.meta.url), "utf8")) as { task: string }[];
  const n = 2_000, t0 = performance.now();
  for (let i = 0; i < n; i++) r(tasks[i % tasks.length]!.task);
  const perDecision = (performance.now() - t0) / n;
  console.log(`# routing overhead ${(perDecision * 1000).toFixed(1)}µs per decision`);
  assert.ok(perDecision < 1, `${perDecision}ms`);
});

test("context refs are minimal: paths, URLs and code symbols named in the task, capped", () => {
  assert.deepEqual(extractContextRefs("Fix src/a.ts and lib/b.py:12, see https://x.dev/y. Call `run()`."), ["https://x.dev/y", "src/a.ts", "lib/b.py:12", "symbol:run()"]);
  assert.equal(extractContextRefs(Array.from({ length: 20 }, (_, i) => `f${i}.ts`).join(" "), 8).length, 8);
});
