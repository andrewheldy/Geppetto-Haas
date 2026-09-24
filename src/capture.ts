import { join } from "node:path";
import { assertSectionContent, fileSlug, GeppettoError, hash, parseFrontmatter, serializeFrontmatter, slugify, splitSections, str, stripComments } from "./markdown.ts";
import { bullets, CONTENT_HEADING, loadCanonical, nextId, today, writeAtomic, type CandidateOp, type Layout } from "./state.ts";

/** Handoff: the Markdown an agent (or human) fills in after a task. Capture turns it into an EPISODIC run record plus CANDIDATES. */
export function handoffTemplate(task: string, agent = ""): string {
  return serializeFrontmatter({ task, agent, outcome: "success" }, `# Handoff
<!-- outcome: success | partial | failed. Comments like this one are ignored. -->

## Summary
<!-- Required. What was done and the result, in a few sentences. -->

## Discoveries
<!-- Bullet list: facts learned that the next agent would want to know. -->

## Failed approaches
<!-- Bullet list: what was tried and did not work, and why. -->

## Files changed
<!-- Bullet list of paths. -->

## Proposed changes
<!--
Changes to accepted project knowledge. NOTHING here becomes canonical until a human approves it with \`geppetto reconcile\`.
One block per proposal:

### Proposal: <short title>
- op: add            (add | replace | remove)
- target: architecture.md            (add: a file in .geppetto/context/; replace/remove: file.md#section-anchor)
- heading: <section heading>         (required for add; optional for replace = rename)
- why: <one line>

<content of the section, Markdown, no # or ## headings>
-->
`);
}

export interface Proposal { title: string; op: CandidateOp; target: string; heading: string; why: string; content: string }
export interface Handoff { task: string; agent: string; outcome: string; summary: string; discoveries: string[]; failed: string[]; filesChanged: string[]; proposals: Proposal[]; raw: string }

const TARGET = /^[a-z0-9][\w.-]*\.md(#[\p{L}\p{N}_-]+)?$/iu;

export function parseHandoff(text: string, source = "handoff"): Handoff {
  const { data, body } = parseFrontmatter(text, source);
  const task = str(data.task).trim();
  if (!task) throw new GeppettoError(`${source}: frontmatter must set \`task:\``);
  const outcome = str(data.outcome).trim() || "unknown";
  if (!["success", "partial", "failed", "unknown"].includes(outcome)) throw new GeppettoError(`${source}: outcome must be success | partial | failed (got ${JSON.stringify(outcome)})`);
  const s = splitSections(body);
  const get = (h: string) => s.sections.find((x) => x.heading.toLowerCase() === h);
  const summary = stripComments(get("summary")?.body ?? "");
  if (!summary) throw new GeppettoError(`${source}: "## Summary" is missing or empty`);
  const prop = get("proposed changes");
  const after = prop ? s.sections.filter((x) => x.start > prop.start) : [];
  if (after.length) throw new GeppettoError(`${source}: unexpected "## ${after[0].heading}" after "## Proposed changes" — proposal content may not use # or ## headings`);
  const proposals = prop ? parseProposals(s.lines.slice(prop.start + 1, prop.end).join("\n"), source) : [];
  return { task, agent: str(data.agent), outcome, summary, discoveries: bullets(stripComments(get("discoveries")?.body ?? "")),
    failed: bullets(stripComments(get("failed approaches")?.body ?? "")), filesChanged: bullets(stripComments(get("files changed")?.body ?? "")), proposals, raw: body };
}

function parseProposals(block: string, source: string): Proposal[] {
  const text = stripComments(block);
  const parts = text.split(/^### Proposal:\s*/m).slice(1);
  if (!parts.length && text.trim()) throw new GeppettoError(`${source}: text under "## Proposed changes" must be "### Proposal: <title>" blocks`);
  return parts.map((part) => {
    const lines = part.split("\n");
    const title = lines.shift()!.trim();
    const meta: Record<string, string> = {};
    while (lines.length && (!lines[0].trim() || /^\s*-\s*(op|target|heading|why):/.test(lines[0]))) {
      const m = /^\s*-\s*(\w+):\s*(.*)$/.exec(lines.shift()!);
      if (m) meta[m[1]] = m[2].trim();
    }
    const content = lines.join("\n").trim();
    const where = `${source}: proposal "${title}"`;
    const op = meta.op as CandidateOp;
    if (!title) throw new GeppettoError(`${source}: a proposal is missing its title`);
    if (!["add", "replace", "remove"].includes(op)) throw new GeppettoError(`${where}: op must be add | replace | remove`);
    if (!TARGET.test(meta.target ?? "")) throw new GeppettoError(`${where}: target must look like file.md or file.md#anchor (a file in .geppetto/context/), got ${JSON.stringify(meta.target)}`);
    const anchored = meta.target.includes("#");
    if (op === "add" && (anchored || !meta.heading)) throw new GeppettoError(`${where}: add needs a file target without #anchor and a heading`);
    if (op !== "add" && !anchored) throw new GeppettoError(`${where}: ${op} needs a target of the form file.md#anchor`);
    if (op !== "remove" && !content) throw new GeppettoError(`${where}: content is empty`);
    assertSectionContent(content, where);
    return { title, op, target: meta.target, heading: meta.heading ?? "", why: meta.why ?? "", content: op === "remove" ? "" : content };
  });
}

export interface CaptureResult { run: string; candidates: string[] }

/**
 * Record a run (episodic) and its proposals (candidates). Never touches canonical state.
 * Validates everything before writing anything, so malformed input leaves the store unchanged.
 */
export function capture(L: Layout, text: string, opts: { source?: string; now?: Date } = {}): CaptureResult {
  const h = parseHandoff(text, opts.source);
  const canonical = loadCanonical(L).sections;
  const bases = h.proposals.map((p) => {
    if (p.op === "add") {
      const clash = canonical.find((s) => s.id === `${p.target}#${slugify(p.heading)}`);
      if (clash) throw new GeppettoError(`proposal "${p.title}": ${clash.id} already exists; use op: replace`);
      return "absent";
    }
    const cur = canonical.find((s) => s.id === p.target);
    if (!cur) throw new GeppettoError(`proposal "${p.title}": target ${p.target} does not exist in .geppetto/context/`);
    return cur.hash;
  });

  const date = today(opts.now);
  const runId = nextId(L.runs, "r");
  const runFile = `${runId}-${fileSlug(h.task)}.md`;
  const first = +nextId(L.candidates, "c").slice(2);
  const ids = h.proposals.map((_, i) => `c-${String(first + i).padStart(4, "0")}`);
  const runBody = stripComments(h.raw).replace(/^# Handoff\s*\n/, `# ${h.task}\n`).trimEnd() + "\n";
  writeAtomic(join(L.runs, runFile), serializeFrontmatter({ id: runId, task: h.task, date, outcome: h.outcome, agent: h.agent, candidates: ids }, runBody));
  const files = h.proposals.map((p, i) => writeCandidate(L, { ...p, id: ids[i], base: bases[i], extra: { run: runId, task: h.task } }, opts.now));
  return { run: `runs/${runFile}`, candidates: files };
}


/** Write one pending candidate. `base` is the hash of the target section now ("absent" for add), used to detect staleness at approval. */
export function writeCandidate(L: Layout, p: Proposal & { id?: string; base: string; extra?: Record<string, string> }, now?: Date): string {
  const id = p.id ?? nextId(L.candidates, "c");
  const fm = { id, status: "pending", op: p.op, target: p.target, heading: p.heading, base: p.base,
    content_hash: hash(p.content), ...p.extra, created: today(now) };
  const body = `# ${p.title}\n\n## Why\n\n${p.why || "_not stated_"}\n\n## ${CONTENT_HEADING}\n\n${p.content}\n`;
  const file = `${id}-${fileSlug(p.title)}.md`;
  writeAtomic(join(L.candidates, file), serializeFrontmatter(fm, body));
  return `candidates/${file}`;
}
