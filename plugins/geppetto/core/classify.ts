// Deterministic task classification: typed regex rules, no model call. Every match is recorded as a signal.
import type { Classification, Level, TaskKind } from "./types.ts";

type Rule = { kind: TaskKind; weight: number; re: RegExp; tag: string };

const WRITE_VERBS = "implement|add|create|write|build|modify|change|update|refactor|fix|patch|edit|delete|remove|migrate|rename|replace|introduce|wire up|port|make";
// "don't change anything", "without modifying" — negated writes are a read-only signal, not write intent.
const NEGATED_WRITE = new RegExp(`\\b(don'?t|do not|never|without|no need to|not)\\s+(\\w+\\s+){0,2}(${WRITE_VERBS}|touch|modify|modifying|changing|editing)\\w*`, "gi");
const WRITE = new RegExp(`\\b(${WRITE_VERBS})\\b`, "i");
// An imperative write verb opening a sentence is the strongest generic implementation signal.
const IMPERATIVE = new RegExp(`(^|[.!?:]\\s+|\\bplease\\s+)(${WRITE_VERBS}|extend|support)\\b`, "i");

const RULES: Rule[] = [
  // trivial: one bounded mechanical step
  { kind: "trivial", weight: 3, re: /\b(typo|spelling( mistake)?|misspell\w*|bump (the )?version|one[- ]line(r)?|trivial|trailing (newline|whitespace)|missing semicolon)\b/i, tag: "trivial-edit" },
  { kind: "trivial", weight: 2, re: /\b(print|echo|show|output) (me )?(the )?(contents?|value|version)\b|\bwhat (is|does) the value\b|\bcount (the )?(lines|files)\b/i, tag: "trivial-read" },
  { kind: "trivial", weight: 2, re: /\b(rename (the )?(variable|function|constant|file)|add a (code |doc )?comment|fix (the )?(indentation|formatting|import order))\b/i, tag: "trivial-mechanical" },

  // explore: read-only search, survey and explanation of existing code
  { kind: "explore", weight: 3, re: /\b(find|search|locate|look for|grep|scan)\b/i, tag: "search-verb" },
  { kind: "explore", weight: 3, re: /\bwhere (is|are|does|do)\b|\bwhich (files?|modules?|functions?|classes?|places?)\b|\bwhat does\b|\bhow does\b/i, tag: "where-question" },
  { kind: "explore", weight: 2, re: /\b(list|enumerate|map out|survey|inventory|summari[sz]e|explore|walk (me )?through|trace|understand|overview|read through|look (through|into|around)|check (whether|if)|tell me (where|whether|which|how|what))\b/i, tag: "survey-verb" },
  { kind: "explore", weight: 2, re: /\b(read[- ]only|report (back|which|where|what)|don'?t change anything|do not (modify|edit|change))\b/i, tag: "read-only" },

  // test
  { kind: "test", weight: 3, re: /\b((write|add|extend|improve|create) (some |more |a few )?(unit |integration |e2e |end-to-end |regression |snapshot )?tests?|test coverage|run (the )?(test suite|tests)|tests? for|no tests)\b/i, tag: "test-verb" },
  { kind: "test", weight: 2, re: /\b(vitest|jest|pytest|mocha|node:test|playwright|cypress|test cases?|(unit|integration|e2e) tests?|fixtures?)\b/i, tag: "test-noun" },

  // implement
  { kind: "implement", weight: 2, re: /\b(implement|add (a |an |the )?(new )?(feature|endpoint|command|flag|option|function|method|component|field|support|pagination|parameter|column|route)|build|create (a |an |the )?\w+|integrate|wire up|port\b)/i, tag: "build-verb" },
  { kind: "implement", weight: 2, re: IMPERATIVE, tag: "imperative-write" },
  { kind: "implement", weight: 1, re: /\b(modify|change|update|edit|refactor|extend|support|introduce|convert)\b/i, tag: "change-verb" },

  // review
  { kind: "review", weight: 3, re: /\b(code review|review (the |this |my |our )?(pr|pull request|diff|changes?|code|patch|branch|commit|implementation)|audit|security review|safe to (merge|ship|deploy)|before (we |i )?(merge|ship)|look over (the |this )?(pr|pull request|#\d+|diff|changes)|critical(ly)? review|review)\b/i, tag: "review-verb" },

  // debug
  { kind: "debug", weight: 3, re: /\b(debug|root[- ]cause|stack ?trace|traceback|segfault|crash(es|ed|ing)?|regression|flaky|leak(s|ing)?|hang(s|ing)?|reproduce|goes wrong|figure out why|investigate why|track down|deadlock|race condition)\b/i, tag: "debug-verb" },
  { kind: "debug", weight: 2, re: /\b(fails?|failing|failure|broken|error|exception|doesn'?t work|not working|why does|silently|wrong (result|output|value)|incorrect(ly)?|unexpected(ly)?)\b/i, tag: "failure-noun" },

  // architecture
  { kind: "architecture", weight: 3, re: /\b(architect(ure|ural)?|system design|design (a|the|an) (new )?(system|service|architecture|protocol|schema|api)|(sketch|propose|draft) a design|design (for|of)|trade-?offs?|adr|migration (plan|strategy)|re-?architect\w*|roadmap|how should we (structure|design|split|organi[sz]e|architect)|compare .{0,40}\b(options|approaches|alternatives))\b/i, tag: "design-verb" },
  { kind: "architecture", weight: 2, re: /\b(scalab(le|ility)|distributed|cross-cutting|long[- ]horizon|multi-(service|tenant|region)|boundar(y|ies) between|isolation model|trust model)\b/i, tag: "design-scope" },
];

const HIGH = /\b(complex|intricate|across (the )?(whole |entire )?(codebase|repo|services)|multiple (services|modules|packages)|end[- ]to[- ]end|race condition|deadlock|memory leak|leak|concurrency|non-?deterministic|intermittent|heisenbug|security[- ]critical|production incident|large[- ]scale|without bound)\b/i;
const LOW = /\b(simple|small|quick|tiny|single (file|function)|one (file|function)|straightforward|minor)\b/i;

const CAPS: Partial<Record<TaskKind, string[]>> = {
  explore: ["code_search"], test: ["test_generation"], implement: ["implementation"], review: ["code_review"],
  debug: ["debugging", "root_cause_analysis"], architecture: ["architecture", "tradeoff_analysis"], trivial: ["mechanical_edit"],
};

/** Strip what names things rather than says things: URLs, paths, file names and code spans. "ARCHITECTURE.md" is not a design task. */
function prose(text: string): string {
  return text
    .replace(/\bhttps?:\/\/\S+/g, " ")
    .replace(/`[^`]*`/g, " CODE ")
    .replace(/(?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]*/g, " PATH ")
    .replace(/\b[\w@-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|md|json|ya?ml|toml|sql|sh|css|html|lock)\b/gi, " FILE ");
}

/** Classify a task from its text alone. Confidence reflects how clearly one kind wins. */
export function classifyTask(task: string, description = ""): Classification {
  const raw = `${description}\n${task}`;
  const negated = prose(raw).match(NEGATED_WRITE) ?? [];
  const text = prose(raw).replace(NEGATED_WRITE, " READONLY ");
  const score = new Map<TaskKind, number>();
  const signals: string[] = [];
  const add = (k: TaskKind, w: number) => score.set(k, (score.get(k) ?? 0) + w);
  const writes = WRITE.test(text);
  for (const r of RULES) {
    if (!r.re.test(text)) continue;
    if (r.kind === "explore" && writes && r.tag !== "read-only") continue; // a search that edits is not exploration
    add(r.kind, r.weight);
    signals.push(`${r.kind}:${r.tag}`);
  }
  if (negated.length) { add("explore", 2); signals.push("explore:negated-write"); }
  if (writes) signals.push("write-intent");

  // Precedence between overlapping kinds.
  const s = (k: TaskKind) => score.get(k) ?? 0;
  const demote = (k: TaskKind, to: number, why: string) => { if (s(k) > to) { score.set(k, to); signals.push(`${k}<${why}`); } };
  if (s("debug") >= 3) { demote("explore", 1, "debug"); if (!/\b(implement|add (a |the )?new)\b/i.test(text)) demote("implement", 1, "debug"); }
  if (s("review") >= 3) { demote("debug", 2, "review"); demote("explore", 2, "review"); demote("implement", 1, "review"); }
  if (s("architecture") >= 3) { demote("implement", 1, "architecture"); demote("explore", 2, "architecture"); }
  if (s("test") >= 3) demote("implement", 1, "test");
  // Trivial only when short and nothing heavier fired strongly.
  if (raw.length > 400 || HIGH.test(text)) score.set("trivial", 0);
  if (s("trivial") >= 2) { demote("implement", 1, "trivial"); demote("explore", 1, "trivial"); }

  const ranked = [...score.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const [top, second] = [ranked[0], ranked[1]];
  let complexity: Level = HIGH.test(text) || raw.length > 3_000 ? "high" : LOW.test(text) || (raw.length < 160 && !writes) ? "low" : "medium";
  const scores = Object.fromEntries(ranked) as Classification["scores"];
  if (!top) return { kind: "unknown", complexity, capabilities: [], confidence: 0, signals, scores, source: "rules" };
  const kind = top[0];
  if (kind === "architecture") complexity = "high";
  if (kind === "trivial") complexity = "low";
  const margin = top[1] - (second?.[1] ?? 0);
  const confidence = round(Math.min(0.95, 0.35 + 0.1 * top[1] + 0.1 * margin));
  return { kind, complexity, capabilities: CAPS[kind] ?? [], confidence, signals, scores, source: "rules" };
}

function round(n: number): number { return Math.round(n * 100) / 100; }
