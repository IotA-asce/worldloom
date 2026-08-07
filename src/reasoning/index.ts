/**
 * Reasoning provider selection.
 *
 * The one rule worth stating: **a missing API key is not an error.** It selects
 * the rule-based provider, and the simulation runs. That is what makes `npm test`
 * real and gives a new contributor a working civilization on first clone
 * (ADR-0006).
 */

import type { WorldloomConfig } from '../core/config.ts';
import { AnthropicProvider, type UsageRecord } from './anthropic.ts';
import { HeuristicProvider } from './heuristic.ts';
import { ScriptedProvider } from './scripted.ts';
import type { ReasoningProvider } from './provider.ts';

export interface CreateProviderOptions {
  readonly config: WorldloomConfig;
  /** Defaults to `ANTHROPIC_API_KEY`. */
  readonly apiKey?: string | undefined;
  /** Meter every attempt — wired to the llm_calls repository by the runtime. */
  readonly onUsage?: (record: UsageRecord) => void;
  readonly spentUsd?: () => number;
}

export interface ProviderSelection {
  readonly provider: ReasoningProvider;
  /** Why this provider was chosen — logged at startup so it's never a surprise
   *  that a run produced no LLM calls. */
  readonly reason: string;
}

export function createReasoningProvider(options: CreateProviderOptions): ProviderSelection {
  const { config } = options;
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;

  if (config.reasoning.provider === 'heuristic') {
    return {
      provider: new HeuristicProvider(),
      reason: 'configured to run rule-based, with no model calls',
    };
  }

  if (config.reasoning.provider === 'scripted') {
    return {
      provider: new ScriptedProvider(),
      reason: 'configured to replay fixtures',
    };
  }

  if (apiKey === undefined || apiKey.length === 0) {
    return {
      provider: new HeuristicProvider(),
      reason:
        'no ANTHROPIC_API_KEY found — running rule-based. Agents will still ' +
        'explore, build and coordinate, but their choices will be simpler.',
    };
  }

  const anthropicOptions = {
    config,
    apiKey,
    ...(options.onUsage !== undefined ? { onUsage: options.onUsage } : {}),
    ...(options.spentUsd !== undefined ? { spentUsd: options.spentUsd } : {}),
  };

  return {
    provider: new AnthropicProvider(anthropicOptions),
    reason: `using ${config.reasoning.provider} with ${config.reasoning.model}`,
  };
}

export { AnthropicProvider, type UsageRecord } from './anthropic.ts';
export { HeuristicProvider } from './heuristic.ts';
export { RecordingProvider, ScriptedProvider, hashPrompt, type Fixture } from './scripted.ts';
export { estimateCostUsd, formatCostUsd, MODEL_RATES, ratesFor } from './pricing.ts';
export type {
  AnswerSource,
  Effort,
  ReasoningProvider,
  ReasoningRequest,
  ReasoningResult,
  TokenUsage,
} from './provider.ts';
