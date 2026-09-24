import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GeppettoError, hash, parseFrontmatter, sectionMeta, splitSections, str, stripComments, type Frontmatter } from "./markdown.ts";

/**
 * On-disk layout. Four information types, four places:
 *   context/     CANONICAL state — what the project accepts as true. Markdown, versioned in Git, edited intentionally.
 *   runs/        EPISODIC memory — what happened in past agent runs. Evidence, not truth.
 *   candidates/  CANDIDATE state — proposed changes to canonical state, awaiting human review.
 *   generated/   WORKING context and other derived output. Disposable; gitignored; rebuilt on demand.
 */
export const DIR = ".geppetto";
export interface Layout { root: string; dir: string; context: string; runs: string; candidates: string; generated: string }

export function layout(root: string): Layout {
  const dir = join(root, DIR);
  return { root, dir, context: join(dir, "context"), runs: join(dir, "runs"), candidates: join(dir, "candidates"), generated: join(dir, "generated") };
}

/** Nearest ancestor containing `.geppetto/`. */
export function findRoot(start: string): string | undefined {
  for (let d = resolve(start); ; d = dirname(d)) {
    if (existsSync(join(d, DIR, "context"))) return d;
    if (dirname(d) === d) return undefined;
  }
}

export function requireLayout(start: string): Layout {
  const root = findRoot(start);
  if (!root) throw new GeppettoError(`no ${DIR}/ found in ${start} or its parents; run \`geppetto init\` first`);
  return layout(root);
}

/** Write via temp file + rename so an interrupted write never leaves a half-written state file. */
export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

const mdFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : []);

// ---------------------------------------------------------------- canonical

export interface CanonicalSection {
  id: string;          // "architecture.md#adapters" — stable while the heading is unchanged
  file: string;        // "architecture.md"
  fileTitle: string;
  heading: string;
  slug: string;        // "" for a file's preamble (text before the first ## heading)
  body: string;        // guidance comments stripped
  raw: string;         // exact body, used for stale-target hashes
  hash: string;
  tags: string[];
  paths: string[];
  always: boolean;     // file frontmatter `include: always` — never dropped from working context
}

export interface Canonical { files: Array<{ name: string; title: string; always: boolean; sections: number }>; sections: CanonicalSection[]; fingerprint: string }

export function loadCanonical(L: Layout): Canonical {
  const files: Canonical["files"] = [];
  const sections: CanonicalSection[] = [];
  const fp: string[] = [];
  for (const name of mdFiles(L.context)) {
    const text = readFileSync(join(L.context, name), "utf8");
    fp.push(name + "\n" + text);
    const { data, body } = parseFrontmatter(text, `context/${name}`);
    const always = str(data.include) === "always";
    const s = splitSections(body);
    const title = s.title ?? name.replace(/\.md$/, "");
    const fileTags = Array.isArray(data.tags) ? data.tags.map((t) => t.toLowerCase()) : [];
    const push = (heading: string, slug: string, raw: string) => {
      const b = stripComments(raw);
      if (!b) return;
      const meta = sectionMeta(b);
      sections.push({ id: slug ? `${name}#${slug}` : name, file: name, fileTitle: title, heading, slug, body: b, raw, hash: hash(raw),
        tags: [...new Set([...fileTags, ...meta.tags])], paths: meta.paths, always });
    };
    push(title, "", s.preamble);
    for (const sec of s.sections) push(sec.heading, sec.slug, sec.body);
    files.push({ name, title, always, sections: s.sections.length });
  }
  return { files, sections, fingerprint: hash(fp.join("\n\0")) };
}

// ---------------------------------------------------------------- episodic

export interface RunRecord { id: string; file: string; task: string; date: string; outcome: string; agent: string; summary: string; discoveries: string[]; failed: string[]; filesChanged: string[] }

export function loadRuns(L: Layout, warnings: string[] = []): RunRecord[] {
  const out: RunRecord[] = [];
  for (const file of mdFiles(L.runs)) {
    try {
      const { data, body } = parseFrontmatter(readFileSync(join(L.runs, file), "utf8"), `runs/${file}`);
      const sec = sectionMap(body);
      out.push({ id: str(data.id) || file.replace(/\.md$/, ""), file, task: str(data.task), date: str(data.date), outcome: str(data.outcome), agent: str(data.agent),
        summary: sec.get("summary") ?? "", discoveries: bullets(sec.get("discoveries")), failed: bullets(sec.get("failed approaches")), filesChanged: bullets(sec.get("files changed")) });
    } catch (e) { warnings.push(`skipped unreadable run record runs/${file}: ${(e as Error).message}`); }
  }
  return out;
}

export function sectionMap(body: string): Map<string, string> {
  return new Map(splitSections(body).sections.map((s) => [s.heading.toLowerCase(), stripComments(s.body)]));
}
export const bullets = (s?: string) => (s ?? "").split("\n").map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter((l) => l && l !== "none" && l !== "-");

// ---------------------------------------------------------------- candidates

export type CandidateStatus = "pending" | "approved" | "rejected" | "deferred";
export type CandidateOp = "add" | "replace" | "remove";
export interface Candidate {
  id: string; file: string; path: string; data: Frontmatter;
  status: CandidateStatus; op: CandidateOp; target: string; heading: string;
  title: string; why: string; content: string; edited: boolean;
}

export const CONTENT_HEADING = "Proposed content";

export function parseCandidate(path: string, text: string): Candidate {
  const file = path.split("/").pop()!;
  const { data, body } = parseFrontmatter(text, `candidates/${file}`);
  const s = splitSections(body);
  const idx = s.sections.findIndex((x) => x.heading === CONTENT_HEADING);
  // Everything after "## Proposed content" is the content, verbatim.
  const content = idx >= 0 ? s.lines.slice(s.sections[idx].start + 1).join("\n").trim() : "";
  const why = stripComments(s.sections.find((x) => x.heading.toLowerCase() === "why")?.body ?? "");
  const status = str(data.status) as CandidateStatus;
  if (!["pending", "approved", "rejected", "deferred"].includes(status)) throw new GeppettoError(`candidates/${file}: unknown status ${JSON.stringify(status)}`);
  return { id: str(data.id), file, path, data, status, op: str(data.op) as CandidateOp, target: str(data.target), heading: str(data.heading),
    title: s.title ?? str(data.heading), why, content, edited: !!data.content_hash && hash(content) !== str(data.content_hash) };
}

export function loadCandidates(L: Layout, warnings: string[] = []): Candidate[] {
  const out: Candidate[] = [];
  for (const file of mdFiles(L.candidates)) {
    const p = join(L.candidates, file);
    try { out.push(parseCandidate(p, readFileSync(p, "utf8"))); } catch (e) { warnings.push((e as Error).message); }
  }
  return out;
}

/** Next sequential id (`r-0003`, `c-0012`) from existing file names; ids are never reused. */
export function nextId(dir: string, prefix: string): string {
  const n = existsSync(dir) ? readdirSync(dir).map((f) => new RegExp(`^${prefix}-(\\d+)`).exec(f)).filter(Boolean).map((m) => +m![1]) : [];
  return `${prefix}-${String(Math.max(0, ...n) + 1).padStart(4, "0")}`;
}

export const today = (now = new Date()) => now.toISOString().slice(0, 10);
