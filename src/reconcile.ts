import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { assertSectionContent, GeppettoError, hash, parseFrontmatter, serializeFrontmatter, slugify, splitSections } from "./markdown.ts";
import { loadCandidates, parseCandidate, today, writeAtomic, type Candidate, type Layout } from "./state.ts";

/**
 * RECONCILIATION: the only path from candidate state into canonical state.
 * approve  → checks the target is unchanged since the proposal (stale) and not already present (conflict), then writes canonical.
 * reject / defer → only the candidate's review fields change; canonical is untouched.
 * Editing a candidate file changes what would be applied, never its status.
 */
export interface Review { by: string; note?: string; now?: Date }

export function findCandidate(L: Layout, id: string): Candidate {
  const c = loadCandidates(L).find((x) => x.id === id || x.file === id || x.file.startsWith(`${id}-`));
  if (!c) throw new GeppettoError(`no candidate ${id} in .geppetto/candidates/`);
  return c;
}

/** Why approving this candidate would be unsafe right now, or undefined if it can be applied. */
export function checkCandidate(L: Layout, c: Candidate): string | undefined {
  try { plan(L, c); return undefined; } catch (e) { if (e instanceof GeppettoError) return e.message; throw e; }
}

function targetPath(L: Layout, c: Candidate): { file: string; anchor: string; path: string } {
  const [file, anchor = ""] = c.target.split("#");
  const path = resolve(L.context, file);
  if (!file.endsWith(".md") || !path.startsWith(L.context + sep) || file.includes("/")) throw new GeppettoError(`${c.id}: target ${c.target} is not a file in .geppetto/context/`);
  return { file, anchor, path };
}

/** Compute the new canonical file text for a candidate without writing anything. */
function plan(L: Layout, c: Candidate): { path: string; text: string } {
  if (!["add", "replace", "remove"].includes(c.op)) throw new GeppettoError(`${c.id}: unknown op ${JSON.stringify(c.op)}`);
  const { file, anchor, path } = targetPath(L, c);
  if (c.op !== "remove") {
    if (!c.content.trim()) throw new GeppettoError(`${c.id}: "## Proposed content" is missing or empty`);
    assertSectionContent(c.content, c.id);
  }
  const heading = c.heading.trim();
  const exists = existsSync(path);
  const text = exists ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : `# ${file.replace(/\.md$/, "").replace(/[-_]/g, " ").replace(/^\w/, (x) => x.toUpperCase())}\n`;
  const { body } = parseFrontmatter(text, `context/${file}`);
  const fm = text.slice(0, text.length - body.length);
  const s = splitSections(body);
  const block = (h: string) => [`## ${h}`, "", c.content.trim(), ""];

  if (c.op === "add") {
    if (!heading || anchor) throw new GeppettoError(`${c.id}: add needs a file target and a heading`);
    const clash = s.sections.find((x) => x.slug === slugify(heading));
    if (clash) throw new GeppettoError(`${c.id}: CONFLICT — ${file}#${clash.slug} already exists in canonical state (added after this proposal?). Reject it, or edit it into a replace.`);
    const lines = [...s.lines];
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return { path, text: fm + [...lines, "", ...block(heading)].join("\n") };
  }

  const sec = s.sections.find((x) => x.slug === anchor);
  if (!sec) throw new GeppettoError(`${c.id}: STALE — target ${c.target} no longer exists in canonical state`);
  if (hash(sec.body) !== String(c.data.base)) {
    throw new GeppettoError(`${c.id}: STALE — ${c.target} changed since this proposal was made (base ${c.data.base}, now ${hash(sec.body)}). Review the current section, then reject this candidate or re-propose.`);
  }
  const lines = [...s.lines];
  lines.splice(sec.start, sec.end - sec.start, ...(c.op === "replace" ? block(heading || sec.heading) : []));
  return { path, text: fm + lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n") };
}

function setReview(c: Candidate, status: Candidate["status"], r: Review, extra: Record<string, string> = {}): void {
  const text = readFileSync(c.path, "utf8");
  const { data, body } = parseFrontmatter(text, c.file);
  const next = { ...data, status, reviewed_by: r.by, reviewed: today(r.now), ...(r.note ? { review_note: r.note } : {}), ...extra };
  const out = serializeFrontmatter(next, body);
  parseCandidate(c.path, out); // never write a candidate we could not read back
  writeAtomic(c.path, out);
}

const reviewable = (c: Candidate) => {
  if (c.status !== "pending" && c.status !== "deferred") throw new GeppettoError(`${c.id} is already ${c.status}`);
};

export function approve(L: Layout, id: string, r: Review): { candidate: Candidate; file: string } {
  const c = findCandidate(L, id);
  reviewable(c);
  const p = plan(L, c);
  writeAtomic(p.path, p.text);
  setReview(c, "approved", r, { applied: hash(p.text), ...(c.edited ? { edited_before_approval: "true" } : {}) });
  return { candidate: c, file: p.path.slice(L.root.length + 1) };
}

export function reject(L: Layout, id: string, r: Review): Candidate {
  const c = findCandidate(L, id); reviewable(c); setReview(c, "rejected", r); return c;
}

export function defer(L: Layout, id: string, r: Review): Candidate {
  const c = findCandidate(L, id);
  if (c.status !== "pending") throw new GeppettoError(`${c.id} is ${c.status}; only pending candidates can be deferred`);
  setReview(c, "deferred", r); return c;
}

/** Human-readable view of one candidate, including what the target currently says. */
export function describe(L: Layout, c: Candidate): string {
  const problem = c.status === "pending" || c.status === "deferred" ? checkCandidate(L, c) : undefined;
  const out = [`${c.id} [${c.status}${c.edited ? ", edited since proposal" : ""}] ${c.op} → ${c.target}${c.heading && c.op === "add" ? ` (## ${c.heading})` : ""}`,
    `  title: ${c.title}`, `  from: ${c.data.run ?? "?"} · task: ${c.data.task ?? "?"}`, `  file: .geppetto/candidates/${c.file}`];
  if (c.why) out.push(`  why: ${c.why}`);
  if (problem) out.push(`  !! ${problem}`);
  if (c.op !== "add") {
    const { path, anchor } = targetPath(L, c);
    const cur = existsSync(path) ? splitSections(parseFrontmatter(readFileSync(path, "utf8")).body).sections.find((x) => x.slug === anchor) : undefined;
    out.push("  --- current canonical ---", indent(cur ? cur.body : "(absent)"));
  }
  if (c.op !== "remove") out.push("  +++ proposed +++", indent(c.content));
  return out.join("\n");
}

const indent = (s: string) => s.split("\n").map((l) => `  | ${l}`).join("\n");
export const candidatePath = (L: Layout, c: Candidate) => join(L.candidates, c.file);
