// Model ids and prices for the agent's tiers: one place, dated, so the budget
// cap, the bench and SKILL.md all quote the same numbers. Re-check against the
// published price list and bump PRICES_CHECKED whenever a number changes.
//
// The Agent SDK reports its own `total_cost_usd`, but from a price table
// bundled into the SDK build, which can predate the models pinned here (the
// 0.3.221 build bills claude-haiku-5-5 at $5/$25). The budget cap therefore
// runs on this table; the SDK's figure is shown beside it, never instead.

import type { AgentModel } from "../protocol.ts";

export const PRICES_CHECKED = "2026-10-12";

export const MODEL_IDS: Record<AgentModel, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

interface Band {
  input: number; // USD per million tokens
  output: number;
}

/** `longPrompt` applies to a request whose prompt exceeds its `aboveTokens`. */
interface TierPrice extends Band {
  longPrompt?: Band & { aboveTokens: number };
}

export const PRICING: Record<AgentModel, TierPrice> = {
  haiku: { input: 0.1, output: 0.5, longPrompt: { aboveTokens: 100_000, input: 0.5, output: 2.5 } },
  sonnet: { input: 2, output: 10 },
  opus: { input: 4, output: 20 },
};

export const CACHE_READ_RATE = 0.1; // cache reads bill at a tenth of the input rate
export const CACHE_WRITE_5M_RATE = 1.25; // 5-minute cache writes: 125% of input
export const CACHE_WRITE_1H_RATE = 2; // 1-hour cache writes (the SDK's default): 200% of input

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** Everything the model read for one request: what picks the price band. */
export function promptTokens(t: Tokens): number {
  return t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
}

export function isLongPrompt(tier: AgentModel, prompt: number): boolean {
  const long = PRICING[tier].longPrompt;
  return long !== undefined && prompt > long.aboveTokens;
}

/**
 * Estimated USD for `t`. For one request the band follows from its own prompt
 * size; for a total over many requests the caller says which band applies.
 */
export function costUsd(tier: AgentModel, t: Tokens, longPrompt?: boolean): number {
  const price = PRICING[tier];
  const long = longPrompt ?? isLongPrompt(tier, promptTokens(t));
  const band = long && price.longPrompt !== undefined ? price.longPrompt : price;
  const input =
    t.input +
    t.cacheRead * CACHE_READ_RATE +
    t.cacheWrite5m * CACHE_WRITE_5M_RATE +
    t.cacheWrite1h * CACHE_WRITE_1H_RATE;
  return (input * band.input + t.output * band.output) / 1_000_000;
}
