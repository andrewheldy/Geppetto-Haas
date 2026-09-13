import { writeFileSync } from "node:fs";
import type { HSCDelta, HSCEntry, HSCState, StateKind, StateStatus, Task, TtlClass } from "./types.ts";
import { estimateTokens } from "./tokens.ts";

export interface SliceFilter { kinds?: StateKind[]; tags?: string[]; statuses?: StateStatus[]; max_tokens?: number; }

const INJECTABLE: StateStatus[] = ["accepted", "active", "tentative", "unverified", "contested"];
const DEFAULT_TTL: Record<StateKind, TtlClass> = {
  objective: "durable", constraint: "durable", decision: "durable", fact: "durable", artifact: "session",
  dependency: "session", completed_action: "session", next_action: "session", evidence: "session",
  assumption: "volatile", hypothesis: "volatile", question: "volatile", observation: "volatile",
};
// volatile entries go stale after this many node executions without confirmation
const DECAY_AFTER_NODES: Record<TtlClass, number> = { durable: Infinity, session: 12, volatile: 4 };

export type EntryInput = Pick<HSCEntry, "kind" | "content"> &
  Partial<Pick<HSCEntry, "key" | "status" | "confidence" | "tags" | "ttl" | "supersedes">> &
  { producer: string; node_id?: string; evidence_refs?: string[] };

/** L1 canonical state. Structured entries with status + provenance; deltas, promotion, decay, conflict detection. */
export class HSCManager {
  readonly state: HSCState;
  private seq = 0;
  nodeIndex = 0;
  readonly file?: string;
  constructor(workflowId: string, objective: string, file?: string) {
    this.file = file;
    this.state = { workflow_id: workflowId, version: 0, objective, entries: [] };
  }

  static fromTask(workflowId: string, task: Task, file?: string): HSCManager {
    const h = new HSCManager(workflowId, task.objective, file);
    h.add({ kind: "objective", content: task.objective, status: "accepted", confidence: 1, producer: "user", tags: ["task"] });
    for (const c of task.constraints) h.add({ kind: "constraint", content: c, status: "accepted", confidence: 1, producer: "user", tags: ["task"] });
    for (const a of task.acceptance_criteria) {
      const text = a.type === "manual" ? a.description : a.type === "command" ? `command passes: ${a.cmd}` : a.type === "file_exists" ? `file exists: ${a.path}` : `${a.path} contains /${a.pattern}/`;
      h.add({ kind: "constraint", content: `Acceptance: ${text}`, status: "accepted", confidence: 1, producer: "user", tags: ["task", "acceptance"] });
    }
    return h;
  }

  /** Agent-produced entries default to `candidate`; they are not canonical until promoted. */
  add(input: EntryInput): HSCEntry {
    const now = new Date().toISOString();
    const e: HSCEntry = {
      id: `s${++this.seq}`, kind: input.kind, key: input.key, content: input.content,
      status: input.status ?? "candidate", confidence: input.confidence ?? 0.5, ttl: input.ttl ?? DEFAULT_TTL[input.kind],
      tags: input.tags ?? [], supersedes: input.supersedes,
      provenance: { producer: input.producer, node_id: input.node_id, workflow_id: this.state.workflow_id,
        evidence_refs: input.evidence_refs ?? [], created_at: now, updated_at: now, produced_at_node_index: this.nodeIndex },
    };
    this.state.entries.push(e);
    this.state.version++;
    if (e.supersedes) this.update(e.supersedes, { status: "superseded", superseded_by: e.id }, `superseded by ${e.id}`);
    return e;
  }

  update(id: string, patch: Partial<HSCEntry>, reason: string): HSCEntry {
    const e = this.get(id);
    Object.assign(e, patch, { status_reason: reason, provenance: { ...e.provenance, updated_at: new Date().toISOString() } });
    this.state.version++;
    return e;
  }

  get(id: string): HSCEntry {
    const e = this.state.entries.find((x) => x.id === id);
    if (!e) throw new Error(`HSC entry ${id} not found`);
    return e;
  }

  promote(ids: string[], reason: string, status: StateStatus = "accepted"): void {
    for (const id of ids) this.update(id, { status }, reason);
  }
  reject(ids: string[], reason: string, status: StateStatus = "rejected"): void {
    for (const id of ids) this.update(id, { status }, reason);
  }

  applyDelta(d: HSCDelta): void {
    for (const a of d.adds) this.state.entries.push(a);
    for (const u of d.updates) this.update(u.id, u.patch, u.reason);
  }

  /** Entries eligible for injection, filtered. Never returns rejected/quarantined/superseded/archived/stale. */
  slice(f: SliceFilter = {}): HSCEntry[] {
    let out = this.state.entries.filter((e) => (f.statuses ?? INJECTABLE).includes(e.status));
    if (f.kinds) out = out.filter((e) => f.kinds!.includes(e.kind));
    if (f.tags) out = out.filter((e) => f.tags!.some((t) => e.tags.includes(t)));
    // accepted first, then newest; deterministic
    const rank: Record<string, number> = { accepted: 0, active: 1, tentative: 2, unverified: 3, contested: 4 };
    out.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.provenance.produced_at_node_index - a.provenance.produced_at_node_index);
    if (f.max_tokens) {
      let used = 0; const kept: HSCEntry[] = [];
      for (const e of out) { const t = estimateTokens(this.renderEntry(e)); if (used + t > f.max_tokens) break; used += t; kept.push(e); }
      out = kept;
    }
    return out;
  }

  renderEntry(e: HSCEntry): string {
    const flag = e.status === "accepted" || e.status === "active" ? "" : ` [${e.status}]`;
    return `- (${e.kind}${flag}) ${e.content}`;
  }
  render(entries: HSCEntry[]): string { return entries.map((e) => this.renderEntry(e)).join("\n"); }
  renderAll(): string { return this.render(this.state.entries); }
  tokens(entries = this.state.entries): number { return estimateTokens(this.render(entries)); }

  /** Deterministic decay: volatile/session entries not refreshed within N node executions become stale. */
  decay(): HSCEntry[] {
    const stale: HSCEntry[] = [];
    for (const e of this.state.entries) {
      if (!INJECTABLE.includes(e.status)) continue;
      const age = this.nodeIndex - e.provenance.produced_at_node_index;
      if (age >= DECAY_AFTER_NODES[e.ttl]) { this.update(e.id, { status: "stale" }, `decayed after ${age} nodes (${e.ttl})`); stale.push(e); }
    }
    return stale;
  }

  /** Two injectable entries with the same key and different content → both contested. Caller decides resolution. */
  detectConflicts(): Array<[HSCEntry, HSCEntry]> {
    const byKey = new Map<string, HSCEntry[]>();
    for (const e of this.state.entries) if (e.key && INJECTABLE.includes(e.status)) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
    const conflicts: Array<[HSCEntry, HSCEntry]> = [];
    for (const group of byKey.values()) {
      for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
        if (group[i].content !== group[j].content) {
          conflicts.push([group[i], group[j]]);
          for (const e of [group[i], group[j]]) if (e.status !== "contested") this.update(e.id, { status: "contested" }, `conflicts on key ${e.key}`);
        }
      }
    }
    return conflicts;
  }

  /** Resolve a conflict deterministically: evidence-backed + higher confidence wins; otherwise leave contested (escalate). */
  resolve(a: HSCEntry, b: HSCEntry): HSCEntry | undefined {
    const score = (e: HSCEntry) => e.confidence + (e.provenance.evidence_refs.length ? 0.5 : 0);
    if (score(a) === score(b)) return undefined;
    const [win, lose] = score(a) > score(b) ? [a, b] : [b, a];
    this.update(win.id, { status: "accepted" }, "won conflict resolution");
    this.update(lose.id, { status: "superseded", superseded_by: win.id }, `lost conflict resolution to ${win.id}`);
    return win;
  }

  save(): void { if (this.file) writeFileSync(this.file, JSON.stringify(this.state, null, 2)); }
}
