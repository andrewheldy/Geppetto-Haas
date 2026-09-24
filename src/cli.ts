#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { ADAPTERS, CONTEXT_FILE, detectAgents, installAdapter, removeAdapter } from "./adapters.ts";
import { capture, handoffTemplate } from "./capture.ts";
import { init } from "./init.ts";
import { fileSlug, GeppettoError } from "./markdown.ts";
import { approve, candidatePath, defer, describe, findCandidate, reject } from "./reconcile.ts";
import { compileContext } from "./compile.ts";
import { DEFAULTS } from "./select.ts";
import { loadCandidates, requireLayout, writeAtomic, type Layout } from "./state.ts";
import { status } from "./status.ts";

const USAGE = `geppetto — portable project state and task context for the coding agents you already use

  geppetto init                         create .geppetto/ (idempotent; never overwrites your files)
  geppetto task "<task>" [--budget N]   compile working context → .geppetto/generated/context.md (+ a handoff template)
                         [--print]      also print the context to stdout (for piping into an agent)
  geppetto capture <handoff.md>         record the run (episodic) and its proposals (candidates); canonical unchanged
  geppetto capture --template "<task>"  print a blank handoff template
  geppetto reconcile                    review pending candidates (interactive on a terminal, otherwise lists them)
  geppetto reconcile show|approve|reject|defer|edit <id> [--by name] [--note text]
  geppetto status                       canonical, episodic, candidate and generated state at a glance
  geppetto adapter list|install|remove [claude|agents]   manage a delimited block in CLAUDE.md / AGENTS.md
  geppetto clean                        delete derived output (.geppetto/generated/); canonical state is untouched
  geppetto lab <command>                the Experiment 000/001 orchestration rig (not part of the core loop)
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "lab") { const { labMain } = await import("./lab/cli.ts"); await labMain(rest); return 0; }
  const { values: v, positionals: pos } = parseArgs({ args: rest, allowPositionals: true, options: {
    budget: { type: "string" }, print: { type: "boolean" }, template: { type: "string" }, agent: { type: "string" },
    by: { type: "string" }, note: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  const cwd = process.cwd();
  const by = v.by ?? process.env.USER ?? "unknown";
  const rel = (L: Layout, p: string) => relative(L.root, p) || ".";

  switch (cmd) {
    case "init": {
      const r = init(cwd);
      console.log(`Geppetto initialised in ${r.root}/.geppetto`);
      if (r.created.length) console.log(`  created: ${r.created.join(", ")}`);
      if (r.kept.length) console.log(`  kept existing: ${r.kept.join(", ")}`);
      if (r.facts.length) console.log(`  detected: ${r.facts.join(" · ")}`);
      console.log(r.agents.length ? `  agent files found (left untouched): ${r.agents.map((a) => `${a.path} (${a.agent}${a.kind === "instructions" ? "" : `, ${a.kind}`})`).join(", ")}` : "  no agent instruction files detected");
      if (r.imports.length) console.log(`  proposed as candidates, NOT canonical: ${r.imports.join(", ")} — review with \`geppetto reconcile\``);
      if (r.skippedImports.length) console.log(`  already proposed earlier: ${r.skippedImports.join(", ")}`);
      console.log(`\nNext: edit .geppetto/context/*.md (canonical state), then \`geppetto task "<what you want done>"\`.`);
      return 0;
    }
    case "task": {
      const L = requireLayout(cwd);
      const task = pos.join(" ").trim();
      if (!task) throw new GeppettoError('usage: geppetto task "<task description>"');
      const budget = v.budget ? Number(v.budget) : DEFAULTS.budgetTokens;
      if (!Number.isInteger(budget) || budget < 200) throw new GeppettoError("--budget must be an integer ≥ 200 (tokens)");
      const handoffRel = `.geppetto/generated/handoff-${fileSlug(task)}.md`;
      const { md, sel, sections, warnings } = compileContext(L, task, { budgetTokens: budget, handoff: handoffRel });
      writeAtomic(join(L.root, CONTEXT_FILE), md);
      const handoff = join(L.root, handoffRel);
      if (!existsSync(handoff)) writeAtomic(handoff, handoffTemplate(task, v.agent ?? ""));
      if (v.print) process.stdout.write(md);
      const log = v.print ? console.error : console.log;
      log(`working context → ${CONTEXT_FILE}  (~${/~(\d+) \//.exec(md)?.[1]} / ${budget} tokens)`);
      log(`  canonical: ${sel.essential.length} always + ${sel.relevant.length} relevant of ${sections} sections · history: ${sel.history.length} run(s) · pending proposals shown: ${sel.pending.length}${sel.omitted.length ? ` · over budget: ${sel.omitted.length}` : ""}`);
      if (sel.budget.essentialOverflow > 0) log(`  WARNING: always-included sections exceed the budget by ~${sel.budget.essentialOverflow} tokens (kept, not dropped)`);
      for (const w of warnings) log(`  warning: ${w}`);
      log(`handoff template → ${handoffRel}  (fill it in after the task, then \`geppetto capture ${handoffRel}\`)`);
      return 0;
    }
    case "capture": {
      if (v.template !== undefined) { process.stdout.write(handoffTemplate(v.template, v.agent ?? "")); return 0; }
      const L = requireLayout(cwd);
      if (!pos[0]) throw new GeppettoError("usage: geppetto capture <handoff.md>   (or --template \"<task>\")");
      const file = resolve(cwd, pos[0]);
      if (!existsSync(file)) throw new GeppettoError(`${pos[0]}: no such file`);
      const r = capture(L, readFileSync(file, "utf8"), { source: pos[0] });
      console.log(`run recorded (episodic) → .geppetto/${r.run}`);
      console.log(r.candidates.length ? `candidates (pending, NOT canonical) → ${r.candidates.map((c) => `.geppetto/${c}`).join(", ")}\nreview with \`geppetto reconcile\`` : "no proposals in handoff");
      return 0;
    }
    case "reconcile": return reconcile(requireLayout(cwd), pos, by, v.note);
    case "status": console.log(status(requireLayout(cwd))); return 0;
    case "adapter": {
      const L = requireLayout(cwd);
      const [sub, id] = pos;
      if (!sub || sub === "list") {
        const found = detectAgents(L.root);
        for (const a of ADAPTERS) {
          const d = found.find((x) => x.path === a.file);
          console.log(`${a.id.padEnd(8)} ${a.file.padEnd(10)} ${a.agent} — ${d ? (d.managed ? "installed" : "file present, not installed") : "not present"}`);
        }
        console.log(`generic  ${CONTEXT_FILE} — any agent can read this file`);
        return 0;
      }
      if (!id) throw new GeppettoError(`usage: geppetto adapter ${sub} <${ADAPTERS.map((a) => a.id).join("|")}>`);
      if (sub === "install") { const r = installAdapter(L.root, id); console.log(`${r.file}: ${r.action} Geppetto block`); return 0; }
      if (sub === "remove") { const r = removeAdapter(L.root, id); console.log(`${r.file}: ${r.action === "absent" ? "no Geppetto block found" : r.action === "deleted" ? "block removed; file was otherwise empty and has been deleted" : "block removed; your content is unchanged"}`); return 0; }
      throw new GeppettoError(`unknown adapter subcommand ${sub}`);
    }
    case "clean": {
      const L = requireLayout(cwd);
      rmSync(L.generated, { recursive: true, force: true });
      console.log(`removed ${rel(L, L.generated)}/ (derived). Canonical state in .geppetto/context/ is untouched.`);
      return 0;
    }
    default:
      process.stdout.write(USAGE);
      return cmd && cmd !== "help" && !v.help ? 1 : 0;
  }
}

async function reconcile(L: Layout, pos: string[], by: string, note?: string): Promise<number> {
  const [sub, id] = pos;
  if (sub && sub !== "list") {
    if (!id) throw new GeppettoError(`usage: geppetto reconcile ${sub} <candidate-id>`);
    if (sub === "show") { console.log(describe(L, findCandidate(L, id))); return 0; }
    if (sub === "approve") { const r = approve(L, id, { by, note }); console.log(`approved ${r.candidate.id} → canonical ${r.file} updated (review with \`git diff ${r.file}\`)`); return 0; }
    if (sub === "reject") { const c = reject(L, id, { by, note }); console.log(`rejected ${c.id}; canonical state unchanged`); return 0; }
    if (sub === "defer") { const c = defer(L, id, { by, note }); console.log(`deferred ${c.id}; canonical state unchanged`); return 0; }
    if (sub === "edit") { editCandidate(L, id); return 0; }
    throw new GeppettoError(`unknown reconcile subcommand ${sub}`);
  }
  const open = loadCandidates(L).filter((c) => c.status === "pending" || c.status === "deferred");
  if (!open.length) { console.log("no pending or deferred candidates"); return 0; }
  if (sub === "list" || !process.stdin.isTTY || !process.stdout.isTTY) {
    for (const c of open) console.log(describe(L, c) + "\n");
    console.log("act with: geppetto reconcile approve|reject|defer|edit <id>");
    return 0;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const c0 of open) {
      for (;;) {
        const c = findCandidate(L, c0.id);
        console.log("\n" + describe(L, c));
        const a = (await rl.question("[a]pprove  [r]eject  [d]efer  [e]dit  [s]kip  [q]uit > ")).trim().toLowerCase();
        try {
          if (a === "a") { const r = approve(L, c.id, { by }); console.log(`approved → ${r.file}`); break; }
          if (a === "r") { reject(L, c.id, { by, note: (await rl.question("reason (optional) > ")).trim() || undefined }); console.log("rejected"); break; }
          if (a === "d") { if (c.status === "pending") defer(L, c.id, { by }); console.log("deferred"); break; }
          if (a === "e") { editCandidate(L, c.id); continue; }
          if (a === "s") break;
          if (a === "q") return 0;
        } catch (e) { if (e instanceof GeppettoError) { console.log(`!! ${e.message}`); continue; } throw e; }
      }
    }
  } finally { rl.close(); }
  return 0;
}

/** Editing changes what would be applied; it never changes review status. */
function editCandidate(L: Layout, id: string): void {
  const c = findCandidate(L, id);
  const path = candidatePath(L, c);
  const editor = process.env.VISUAL ?? process.env.EDITOR;
  if (!editor || !process.stdin.isTTY) { console.log(`edit ${relative(process.cwd(), path)} in any editor; it stays ${c.status} until you approve it`); return; }
  spawnSync(editor, [JSON.stringify(path)], { stdio: "inherit", shell: true });
  console.log(`${c.id} edited; still ${findCandidate(L, id).status} — approve it to apply`);
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  if (e instanceof GeppettoError) { console.error(`geppetto: ${e.message}`); process.exitCode = 1; }
  else { console.error(e); process.exitCode = 2; }
});
