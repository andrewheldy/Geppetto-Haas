// Agent definitions as Markdown with YAML-ish frontmatter (Claude Code's .claude/agents/*.md format).
import type { AgentOption } from "./types.ts";

const WRITE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|Bash)(\(|$)/;

/** Reads `name`, `model` and `tools` from an agent file's frontmatter. A file without frontmatter yields only its name. */
export function parseAgentDefinition(markdown: string, fallbackName: string): AgentOption {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? "";
  const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, "");
  const name = field("name") || fallbackName;
  const model = field("model") || undefined;
  const toolsRaw = field("tools");
  const tools = toolsRaw ? toolsRaw.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : undefined;
  return { id: name, model, readOnly: tools ? !tools.some((t) => WRITE_TOOLS.test(t)) : false };
}
