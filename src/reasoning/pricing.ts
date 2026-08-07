/**
 * Model pricing, for the cost instrumentation requirement 29 asks for.
 *
 * These are published Anthropic first-party rates in USD per million tokens,
 * current as of 2026-08. They exist to make a run's spend *visible*, not to be
 * an invoice — an organisation with negotiated rates will see a lower bill than
 * Worldloom reports, and reporting slightly high is the safe direction for a
 * budget cap to err in.
 */

import type { TokenUsage } from './provider.ts';

export interface ModelRates {
  /** USD per million input tokens. */
  readonly input: number;
  /** USD per million output tokens. */
  readonly output: number;
}

/**
 * Known models. Aliases rather than dated snapshots, since the alias is what
 * callers should be passing.
 */
export const MODEL_RATES: Readonly<Record<string, ModelRates>> = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  // Sonnet 5 has promotional pricing ($2/$10) through 2026-08-31; the standard
  // rate is used here so a budget set today doesn't quietly overshoot in September.
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** Cache reads bill at ~10% of the input rate. */
const CACHE_READ_MULTIPLIER = 0.1;
/** Cache writes bill at ~125% of the input rate (5-minute TTL). */
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Rates for a model. An unknown model — a newer release, or a local model —
 * costs nothing rather than crashing the run; the token counts are still
 * recorded, so usage stays visible even when the price isn't known.
 */
export function ratesFor(model: string): ModelRates | null {
  return MODEL_RATES[model] ?? null;
}

export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const rates = ratesFor(model);
  if (rates === null) return 0;

  const perToken = (perMillion: number): number => perMillion / 1_000_000;
  return (
    usage.inputTokens * perToken(rates.input) +
    usage.outputTokens * perToken(rates.output) +
    usage.cacheReadTokens * perToken(rates.input) * CACHE_READ_MULTIPLIER +
    usage.cacheWriteTokens * perToken(rates.input) * CACHE_WRITE_MULTIPLIER
  );
}

/** Format a cost for the CLI. Sub-cent figures still need to be legible. */
export function formatCostUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function isKnownModel(model: string): boolean {
  return model in MODEL_RATES;
}
