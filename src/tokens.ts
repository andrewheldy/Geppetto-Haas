import type { TokenUsage } from "./lab/types.ts";

/** ponytail: chars/4 heuristic. Provider-reported usage overrides this wherever available; entries carry `estimated`. */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

export function usageFromEstimate(input: number, output: number): TokenUsage {
  return { input, output, cache_read: 0, cache_write: 0, total: input + output, estimated: true };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input, output: a.output + b.output,
    cache_read: a.cache_read + b.cache_read, cache_write: a.cache_write + b.cache_write,
    total: a.total + b.total, estimated: a.estimated || b.estimated,
  };
}

/** Active context of one API round-trip: everything the model attended to. */
export function activeContext(u: TokenUsage): number {
  return u.input + u.cache_read + u.cache_write;
}

// USD per million tokens, first-party list prices (input, output). Cache write = 1.25x input, cache read = 0.1x input.
const PRICES: Record<string, [number, number]> = {
  "claude-fable-5-1": [10, 50], fable: [10, 50],
  "claude-opus-5": [5, 25], opus: [5, 25],
  "claude-sonnet-5": [2, 10], sonnet: [2, 10],
  "claude-haiku-4-5": [1, 5], "claude-haiku-4-5-20251001": [1, 5], haiku: [1, 5],
  mock: [0, 0],
};

export function estimateCost(model: string, u: TokenUsage): number {
  const key = Object.keys(PRICES).find((k) => model === k || model.startsWith(k)) ?? "sonnet";
  const [inP, outP] = PRICES[key];
  return (u.input * inP + u.cache_write * inP * 1.25 + u.cache_read * inP * 0.1 + u.output * outP) / 1e6;
}
