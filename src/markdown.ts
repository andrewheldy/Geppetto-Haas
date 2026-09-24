import { createHash } from "node:crypto";

/** Expected, user-facing failure (bad input, stale target, conflict). The CLI prints the message without a stack. */
export class GeppettoError extends Error {}

export type Frontmatter = Record<string, string | string[]>;
export interface Doc { data: Frontmatter; body: string }

/**
 * Minimal frontmatter: `key: value` and `key: [a, b]` lines between `---` fences, `#` comment lines ignored.
 * Deliberately a small subset of YAML so files stay editable by hand and readable by Obsidian/GitHub.
 */
export function parseFrontmatter(text: string, source = "input"): Doc {
  const norm = text.replace(/\r\n/g, "\n");
  if (!norm.startsWith("---\n")) return { data: {}, body: norm };
  const end = norm.indexOf("\n---", 3);
  if (end < 0 || (norm[end + 4] !== undefined && norm[end + 4] !== "\n")) throw new GeppettoError(`${source}: frontmatter opened with --- but never closed`);
  const data: Frontmatter = {};
  for (const line of norm.slice(4, end).split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) throw new GeppettoError(`${source}: malformed frontmatter line: ${JSON.stringify(line)}`);
    data[m[1]] = parseValue(m[2].trim(), source);
  }
  return { data, body: norm.slice(end + 4).replace(/^\n/, "") };
}

function parseValue(v: string, source: string): string | string[] {
  if (v.startsWith("[")) {
    try { const a = JSON.parse(v); if (Array.isArray(a)) return a.map(String); } catch { /* fall through to comma list */ }
    if (!v.endsWith("]")) throw new GeppettoError(`${source}: unterminated list: ${v}`);
    return v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (v.startsWith('"')) {
    try { return String(JSON.parse(v)); } catch { throw new GeppettoError(`${source}: bad quoted value: ${v}`); }
  }
  return v;
}

const needsQuote = (s: string) => s === "" || /^[\s["'#]|[:#]|\s$/.test(s);

export function serializeFrontmatter(data: Frontmatter, body: string): string {
  const lines = Object.entries(data).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: ${v.some(needsQuote) ? JSON.stringify(v) : `[${v.join(", ")}]`}`;
    return `${k}: ${needsQuote(v) ? JSON.stringify(v) : v}`;
  });
  return `---\n${lines.join("\n")}\n---\n${body.startsWith("\n") ? body : "\n" + body}`;
}

export const str = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join(", ") : v ?? "");

/** GitHub-style heading anchor, so `file.md#slug` links work on GitHub, in VS Code and in Obsidian. */
export function slugify(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

export interface RawSection { heading: string; slug: string; start: number; end: number; body: string }
export interface Sections { title?: string; preamble: string; sections: RawSection[]; lines: string[] }

/** Split a Markdown body on `## ` headings (outside code fences). `start`/`end` are line indices into `lines`. */
export function splitSections(body: string): Sections {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const heads: Array<{ i: number; heading: string }> = [];
  let fence = false, comment = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!comment && /^\s*(```|~~~)/.test(l)) fence = !fence;
    else if (!fence && !comment && /^## \S/.test(l)) heads.push({ i, heading: l.slice(3).trim() });
    // headings inside HTML comments (template guidance) are not structure
    if (!fence) { const open = l.lastIndexOf("<!--"), close = l.lastIndexOf("-->"); if (open > close) comment = true; else if (close >= 0) comment = false; }
  }
  const preEnd = heads.length ? heads[0].i : lines.length;
  const pre = lines.slice(0, preEnd);
  const t = pre.findIndex((l) => /^# \S/.test(l));
  const title = t >= 0 ? pre[t].slice(2).trim() : undefined;
  const preamble = pre.filter((_, i) => i !== t).join("\n").trim();
  const seen = new Map<string, number>();
  const sections = heads.map((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
    let slug = slugify(h.heading);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n) slug = `${slug}-${n}`;
    return { heading: h.heading, slug, start: h.i, end, body: lines.slice(h.i + 1, end).join("\n").trim() };
  });
  return { title, preamble, sections, lines };
}

/** Filesystem-friendly slug for generated file names. */
export const fileSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 48).replace(/-+$/, "") || "task";

/** HTML comments hold editing guidance in templates; they are never shown to agents or scored. */
export const stripComments = (s: string) =>
  s.replace(/(`[^`\n]*`)|<!--[\s\S]*?-->/g, (m, code) => code ?? "").replace(/\n{3,}/g, "\n\n").trim(); // comments quoted in `code` are content

export const hash = (s: string) =>
  createHash("sha256").update(s.replace(/\r\n/g, "\n").split("\n").map((l) => l.trimEnd()).join("\n").trim()).digest("hex").slice(0, 12);

/** Optional `Tags:` and `Paths:` lines inside a section: explicit, portable relationships (future graph edges). */
export function sectionMeta(body: string): { tags: string[]; paths: string[] } {
  const grab = (key: string) => {
    const m = new RegExp(`^${key}:\\s*(.+)$`, "im").exec(body);
    return m ? m[1].split(/[,\s]+/).map((s) => s.replace(/^[#`]+|`+$/g, "")).filter(Boolean) : [];
  };
  return { tags: grab("tags").map((t) => t.toLowerCase()), paths: grab("paths") };
}

/** Headings inside proposed content must not be H1/H2, otherwise they would split canonical sections. */
export function assertSectionContent(content: string, source: string): void {
  let fence = false;
  for (const l of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    else if (!fence && /^#{1,2} /.test(l)) throw new GeppettoError(`${source}: proposed content may not contain '# ' or '## ' headings (found ${JSON.stringify(l)}); use ### or deeper`);
  }
}
