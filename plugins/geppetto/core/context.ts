// Minimal context references: the paths, URLs and symbols a task names explicitly. Never file contents.

const URL_RE = /\bhttps?:\/\/[^\s)>\]"'`]+/g;
const PATH_RE = /(?:^|[\s(`"'])((?:\.{0,2}\/)?(?:[\w.@-]+\/)*[\w@-][\w.@-]*\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|rb|php|cs|c|h|cpp|hpp|swift|md|mdx|json|jsonc|ya?ml|toml|sql|sh|css|scss|html|proto|graphql)(?::\d+(?::\d+)?)?)(?=$|[\s)`"',.;:])/g;
const DIR_RE = /(?:^|[\s(`"'])((?:\.{0,2}\/)?(?:[\w.@-]+\/){1,}[\w.@-]*)(?=$|[\s)`"',;:])/g;
const SYMBOL_RE = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?)`/g;

export function extractContextRefs(text: string, max = 8): string[] {
  const refs: string[] = [];
  const add = (r: string) => { const v = r.replace(/[.,;:]+$/, ""); if (v.length > 1 && !refs.includes(v)) refs.push(v); };
  for (const m of text.matchAll(URL_RE)) add(m[0]);
  const withoutUrls = text.replace(URL_RE, " ");
  for (const m of withoutUrls.matchAll(PATH_RE)) if (m[1]) add(m[1]);
  for (const m of withoutUrls.matchAll(DIR_RE)) if (m[1] && !refs.some((r) => r.startsWith(m[1]!))) add(m[1]);
  for (const m of text.matchAll(SYMBOL_RE)) if (m[1] && !refs.some((r) => r.includes(m[1]!))) add(`symbol:${m[1]}`);
  return refs.slice(0, max);
}
