import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutionMode, TraceEvent } from "./types.ts";

export interface TraceIds { experiment_id?: string; workflow_id: string; mode: ExecutionMode; graph_id?: string; }

/** Append-only JSONL trace with correlation ids: experiment → workflow → graph → node → agent → invocation. */
export class Tracer {
  readonly events: TraceEvent[] = [];
  private seq = 0;
  readonly file: string;
  readonly ids: TraceIds;
  constructor(file: string, ids: TraceIds) {
    this.file = file; this.ids = ids;
    mkdirSync(dirname(file), { recursive: true });
  }
  emit(type: string, data: Record<string, unknown> = {}, ids: Partial<Pick<TraceEvent, "node_id" | "agent_id" | "invocation_id">> = {}): TraceEvent {
    const ev: TraceEvent = {
      ts: new Date().toISOString(), seq: this.seq++, type,
      experiment_id: this.ids.experiment_id, workflow_id: this.ids.workflow_id, mode: this.ids.mode,
      graph_id: this.ids.graph_id, ...ids, data,
    };
    this.events.push(ev);
    appendFileSync(this.file, JSON.stringify(ev) + "\n");
    return ev;
  }
  count(type: string): number { return this.events.filter((e) => e.type === type).length; }
}
