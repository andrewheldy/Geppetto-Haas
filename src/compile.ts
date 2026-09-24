import { fitToBudget } from "./render.ts";
import { mentionedPaths, repoFacts } from "./repo.ts";
import { select, type SelectOptions, type Selection } from "./select.ts";
import { loadCandidates, loadCanonical, loadRuns, type Layout } from "./state.ts";

/** The context compiler: load state → select → render → enforce budget. Reads only; writes nothing. */
export function compileContext(L: Layout, task: string, opts: Partial<SelectOptions> & { handoff: string }): { md: string; sel: Selection; sections: number; warnings: string[] } {
  const warnings: string[] = [];
  const canon = loadCanonical(L);
  const sel0 = select(task, { canonical: canon.sections, runs: loadRuns(L, warnings), candidates: loadCandidates(L, warnings), repo: repoFacts(L.root), mentioned: mentionedPaths(L.root, task) }, opts);
  const { sel, md } = fitToBudget(sel0, { fingerprint: canon.fingerprint, handoff: opts.handoff });
  return { md, sel, sections: canon.sections.length, warnings };
}
