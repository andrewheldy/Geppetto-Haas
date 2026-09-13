import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { estimateTokens } from "./tokens.ts";

export interface HistoryRecord {
  id: string;
  ts: string;
  type: "agent_output" | "tool_output" | "state_snapshot" | "rejected" | "superseded" | "conversation" | "artifact";
  node_id?: string;
  agent_id?: string;
  tags: string[];
  content: string;
  tokens: number;
}

/** L2 historical store. Append-only JSONL; searchable; never auto-injected into L0. */
export class HistoricalStore {
  readonly records: HistoryRecord[] = [];
  private seq = 0;
  readonly file: string;
  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) this.records.push(JSON.parse(line));
      this.seq = this.records.length;
    }
  }

  append(r: Omit<HistoryRecord, "id" | "ts" | "tokens">): HistoryRecord {
    const rec: HistoryRecord = { id: `h${++this.seq}`, ts: new Date().toISOString(), tokens: estimateTokens(r.content), ...r };
    this.records.push(rec);
    appendFileSync(this.file, JSON.stringify(rec) + "\n");
    return rec;
  }

  get(id: string): HistoryRecord | undefined { return this.records.find((r) => r.id === id); }

  /** ponytail: keyword overlap scoring. Upgrade to embeddings only if retrieval precision is measurably the bottleneck. */
  search(query: string, opts: { limit?: number; tags?: string[]; types?: HistoryRecord["type"][] } = {}): HistoryRecord[] {
    const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2);
    return this.records
      .filter((r) => !opts.types || opts.types.includes(r.type))
      .filter((r) => !opts.tags || opts.tags.some((t) => r.tags.includes(t)))
      .map((r) => {
        const hay = (r.content + " " + r.tags.join(" ")).toLowerCase();
        const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0) / Math.max(1, terms.length);
        return { r, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.r.id.localeCompare(a.r.id))
      .slice(0, opts.limit ?? 3)
      .map((x) => x.r);
  }

  totalTokens(): number { return this.records.reduce((a, r) => a + r.tokens, 0); }
}
