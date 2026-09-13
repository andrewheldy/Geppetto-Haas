import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ContextPacket, ContextSection, GraphNode, HandoffPacket, Task } from "./types.ts";
import type { ContextGovernor, ContextItem } from "./governor.ts";
import { estimateTokens } from "./tokens.ts";

export interface CompileInput {
  task: Task;
  node: GraphNode;
  graph_nodes: GraphNode[];
  governor: ContextGovernor;
  workspace: string;
  handoff: HandoffPacket;
  /** total L0 budget for this node */
  max_tokens: number;
  extra?: ContextSection[];
}

function listFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "runs") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listFiles(p, out, depth + 1); else out.push(p);
  }
  return out;
}

function expandPaths(workspace: string, paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const abs = join(workspace, p);
    if (existsSync(abs) && statSync(abs).isDirectory()) for (const f of listFiles(abs)) out.add(relative(workspace, f));
    else if (existsSync(abs)) out.add(p);
    else if (p.includes("*")) {
      const re = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");
      for (const f of listFiles(workspace)) { const r = relative(workspace, f); if (re.test(r)) out.add(r); }
    }
  }
  return [...out].sort();
}

/**
 * Context Compiler: Full available state → node requirements → relevant HSC slice → history retrieval → files → packet.
 * Every section is measured; the packet reports what was injected and what was deliberately left out.
 */
export function compileContext(input: CompileInput): ContextPacket {
  const { task, node, governor, workspace, handoff } = input;
  const items: ContextItem[] = [];
  const sectionMeta = new Map<string, ContextSection["source"]>();
  const push = (name: string, source: ContextSection["source"], text: string, tags: string[], provenance: string[], priority: number) => {
    if (!text.trim()) return;
    items.push({ name, text, tags, provenance, priority }); sectionMeta.set(name, source);
  };

  for (const req of node.required_context) {
    if (req.kind === "task") {
      push("task", "task", `Objective: ${task.objective}\nConstraints:\n${task.constraints.map((c) => `- ${c}`).join("\n")}`, ["task"], ["user"], 100);
    } else if (req.kind === "hsc") {
      const entries = governor.hsc.slice({ kinds: req.kinds, tags: req.tags, max_tokens: req.max_tokens });
      push(`hsc:${(req.kinds ?? ["all"]).join("+")}`, "hsc", governor.hsc.render(entries), ["hsc", ...(req.tags ?? [])], entries.map((e) => e.id), 90);
    } else if (req.kind === "node_output") {
      const dep = input.graph_nodes.find((n) => n.node_id === req.node_id);
      if (dep?.outputs) {
        const text = req.full ? dep.outputs.text : dep.outputs.summary;
        push(`output:${dep.node_id}`, "node_output", `## Output of ${dep.node_id} (${dep.node_type}${dep.outputs.verdict ? `, verdict=${dep.outputs.verdict}` : ""})\n${text}`, [dep.node_id, dep.node_type], [dep.outputs.history_ref], 80);
      }
    } else if (req.kind === "files") {
      const perFile = Math.floor((req.max_tokens ?? 6000) / Math.max(1, req.paths.length));
      for (const rel of expandPaths(workspace, req.paths)) {
        const abs = join(workspace, rel);
        let content = readFileSync(abs, "utf8");
        if (estimateTokens(content) > perFile) content = content.slice(0, perFile * 4) + `\n... [truncated: read the file for the rest]`;
        push(`file:${rel}`, "file", `### ${rel}\n\`\`\`\n${content}\n\`\`\``, ["file", rel], [`file:${rel}`], 60);
      }
    } else if (req.kind === "history") {
      const r = governor.rehydrate(req.query, node, { limit: req.limit });
      push(`history:${req.query.slice(0, 30)}`, "history", r.text, ["history"], r.sources, 50);
    }
  }
  const handoffText = renderHandoff(handoff);
  push("handoff", "handoff", handoffText, ["handoff"], ["governor"], 95);
  for (const s of input.extra ?? []) push(s.name, s.source, s.text, [s.source], s.provenance, 70);

  const { admitted, discarded } = governor.admit(items, node, input.max_tokens);
  const sections: ContextSection[] = admitted.map((it) => ({ name: it.name, source: sectionMeta.get(it.name) ?? "task", tokens: estimateTokens(it.text), text: it.text, provenance: it.provenance }));
  const text = sections.map((s) => s.text).join("\n\n");
  const sum = (src: ContextSection["source"]) => sections.filter((s) => s.source === src).reduce((a, s) => a + s.tokens, 0);
  const tokens = estimateTokens(text);
  const available = governor.availableTokens() + items.filter((i) => sectionMeta.get(i.name) === "file").reduce((a, i) => a + estimateTokens(i.text), 0);
  const packet: ContextPacket = {
    node_id: node.node_id, sections, text, tokens,
    available_tokens: Math.max(available, tokens),
    hsc_tokens: sum("hsc") + sum("handoff"), file_tokens: sum("file"), node_output_tokens: sum("node_output"),
    retrieved_tokens: sum("history") + sum("rehydration"),
    discarded_tokens: Math.max(0, Math.max(available, tokens) - tokens),
    discarded_items: discarded.length,
  };
  governor.tracer.emit("context.compiled", {
    tokens, available_tokens: packet.available_tokens, discarded_tokens: packet.discarded_tokens, discarded_items: discarded.length,
    sections: sections.map((s) => ({ name: s.name, source: s.source, tokens: s.tokens })),
  }, { node_id: node.node_id });
  return packet;
}

export function renderHandoff(h: HandoffPacket): string {
  const list = (xs: string[]) => xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)";
  return [
    `## Handoff`, `Status: ${h.current_status}`,
    `Accepted decisions:\n${list(h.accepted_decisions)}`,
    `Active hypotheses/assumptions:\n${list(h.active_hypotheses)}`,
    `Unresolved questions:\n${list(h.unresolved_questions)}`,
    `Artifacts:\n${list(h.artifact_refs)}`,
    `Acceptance criteria:\n${list(h.acceptance_criteria)}`,
    `Allowed tools: ${h.allowed_tools.join(", ") || "none"} | authority: ${h.authority}`,
    h.warnings.length ? `Warnings:\n${list(h.warnings)}` : "",
  ].filter(Boolean).join("\n");
}
