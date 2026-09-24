import type { Candidate, CanonicalSection, RunRecord } from "./state.ts";
import type { RepoFacts } from "./repo.ts";
import { estimateTokens } from "./tokens.ts";

/**
 * Context SELECTION: decide what a task needs. Pure and deterministic — same inputs, same selection.
 * Rendering is separate (render.ts). Replace this module to change retrieval strategy (graph, embeddings, ...).
 *
 * Priority (budget is spent in this order):
 *   1. essential canonical sections (files with `include: always`) — never dropped; overflow is reported
 *   2. canonical sections relevant to the task, by score
 *   3. episodic run records relevant to the task (evidence, labelled as such)
 *   4. titles of relevant pending/deferred candidates (labelled NOT accepted)
 * Repository signals are capped by count, not budget.
 */
export interface SelectOptions { budgetTokens: number; maxSections: number; maxRuns: number; maxCandidates: number; maxFiles: number; minScore: number }
export const DEFAULTS: SelectOptions = { budgetTokens: 2000, maxSections: 10, maxRuns: 3, maxCandidates: 3, maxFiles: 8, minScore: 2 };
/** Tokens held back for the frame (headings, repo signals, footer) so the rendered total lands near the budget. */
export const FRAME_RESERVE = 350;

export interface Scored<T> { item: T; score: number; reasons: string[] }
export interface Selection {
  task: string;
  essential: CanonicalSection[];
  relevant: Scored<CanonicalSection>[];
  history: Scored<RunRecord>[];
  pending: Scored<Candidate>[];
  omitted: Array<{ ref: string; score: number; tokens: number }>;
  unmatched: number;
  repo: { mentioned: string[]; matching: string[]; changed: string[] };
  budget: { limit: number; selected: number; essentialOverflow: number };
}

const STOP = new Set(("the and for with from into that this these those then than when what which will would should could about above after " +
  "add adds added improve improves improved make makes update updates fix fixes new another some more less use using used implement support " +
  "task work does done have has not are was were can its our your their all any each per via onto also just only").split(" "));

/** Crude but deterministic normalisation: lowercase words ≥3 chars, stop-words dropped, stemmed to 6 chars. */
export function terms(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.slice(0, 6)))];
}
const termSet = (text: string) => new Set(terms(text));

function scoreText(q: string[], fields: Array<[string, number, string]>): { score: number; reasons: string[] } {
  let score = 0; const reasons: string[] = [];
  for (const [text, weight, label] of fields) {
    const set = termSet(text);
    const hits = q.filter((t) => set.has(t));
    if (hits.length) { score += hits.length * weight; reasons.push(`${label}: ${hits.join(", ")}`); }
  }
  return { score, reasons };
}

const pathHit = (a: string, b: string) => a === b || a.startsWith(b.replace(/\/?$/, "/")) || b.startsWith(a.replace(/\/?$/, "/"));

export const sectionTokens = (s: CanonicalSection) => estimateTokens(`### ${s.fileTitle} › ${s.heading}\n${s.body}\n`) + 30;
export const runTokens = (r: RunRecord) => estimateTokens(r.task + r.summary.slice(0, 400) + r.discoveries.slice(0, 4).join("\n") + r.failed.slice(0, 3).join("\n")) + 20;
export const candidateTokens = (c: Candidate) => estimateTokens(c.title + c.target) + 20;

export function select(task: string, input: { canonical: CanonicalSection[]; runs: RunRecord[]; candidates: Candidate[]; repo: RepoFacts; mentioned: string[] }, opts: Partial<SelectOptions> = {}): Selection {
  const o = { ...DEFAULTS, ...opts };
  const q = terms(task);
  const byScore = <T>(id: (x: T) => string) => (a: Scored<T>, b: Scored<T>) => b.score - a.score || id(a.item).localeCompare(id(b.item));

  const essential = input.canonical.filter((s) => s.always);
  let used = essential.reduce((a, s) => a + sectionTokens(s), 0);
  const room = o.budgetTokens - FRAME_RESERVE;
  const essentialOverflow = Math.max(0, used - room);
  const omitted: Selection["omitted"] = [];

  const scoredSections = input.canonical.filter((s) => !s.always).map((s) => {
    const r = scoreText(q, [[s.heading, 3, "heading"], [s.tags.join(" "), 2, "tags"], [s.body, 1, "body"]]);
    const named = s.paths.filter((p) => input.mentioned.some((m) => pathHit(m, p)));
    const changed = s.paths.filter((p) => input.repo.changed.some((c) => pathHit(c, p)));
    // Named paths are strong evidence; uncommitted changes are weak (+1 once) so a dirty tree cannot flood the context.
    if (named.length) { r.score += 4 * named.length; r.reasons.push(`path named in task: ${named.join(", ")}`); }
    else if (changed.length) { r.score += 1; r.reasons.push(`path has uncommitted changes: ${changed.join(", ")}`); }
    return { item: s, ...r };
  }).filter((x) => x.score >= o.minScore).sort(byScore((s) => s.id));

  const take = <T>(list: Scored<T>[], max: number, cost: (x: T) => number, ref: (x: T) => string): Scored<T>[] => {
    const kept: Scored<T>[] = [];
    for (const x of list) {
      const t = cost(x.item);
      if (kept.length < max && used + t <= room) { kept.push(x); used += t; } else omitted.push({ ref: ref(x.item), score: x.score, tokens: t });
    }
    return kept;
  };

  const relevant = take(scoredSections, o.maxSections, sectionTokens, (s) => s.id);

  const history = take(input.runs.map((r) => ({ item: r, ...scoreText(q, [[r.task, 3, "task"], [[r.summary, ...r.discoveries, ...r.failed].join(" "), 1, "record"]]) }))
    .filter((x) => x.score >= o.minScore).sort(byScore((r) => r.id)), o.maxRuns, runTokens, (r) => `runs/${r.file}`);

  const pending = take(input.candidates.filter((c) => c.status === "pending" || c.status === "deferred")
    .map((c) => ({ item: c, ...scoreText(q, [[c.title + " " + c.heading, 3, "title"], [c.content + " " + c.why, 1, "content"]]) }))
    .filter((x) => x.score >= o.minScore).sort(byScore((c) => c.id)), o.maxCandidates, candidateTokens, (c) => `candidates/${c.file}`);

  const noise = /(^|\/)(\.geppetto|node_modules|docs\/results|docs\/archive)\/|(package-lock\.json|\.lock)$/;
  const matching = input.repo.files.filter((f) => !noise.test(f) && !input.mentioned.includes(f))
    .map((f) => ({ f, n: q.filter((t) => termSet(f.replace(/[/._-]/g, " ")).has(t)).length }))
    .filter((x) => x.n > 0).sort((a, b) => b.n - a.n || a.f.localeCompare(b.f)).slice(0, o.maxFiles).map((x) => x.f);

  return {
    task, essential, relevant, history, pending, omitted,
    unmatched: input.canonical.length - essential.length - scoredSections.length,
    repo: { mentioned: input.mentioned, matching, changed: input.repo.changed.filter((c) => !c.startsWith(".geppetto/")).slice(0, 10) },
    budget: { limit: o.budgetTokens, selected: used, essentialOverflow },
  };
}
