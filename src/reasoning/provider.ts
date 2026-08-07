/**
 * The reasoning provider abstraction (ADR-0006).
 *
 * One method, `reason`, covering every place a model may be called. Everything
 * is structured: there is no free-text path, because prose that the simulation
 * then has to parse is the standard source of silent corruption (requirement 27).
 *
 * The design decision worth noticing is that **every request must carry its own
 * deterministic fallback**. That single required field does a lot of work:
 *
 *  - `HeuristicProvider` is implemented by calling it, so the whole simulation
 *    runs with no API key and no network.
 *  - A model outage, a refusal, or output that fails validation degrades to the
 *    fallback rather than stopping the world.
 *  - It enforces ADR-0006's discipline at the type level: if a decision cannot
 *    be expressed as something a rule could answer, the schema is too vague.
 */

import type { z } from 'zod';
import type { ReasoningCategory } from '../core/config.ts';
import type { AgentId } from '../core/ids.ts';
import type { Result } from '../core/result.ts';

/** How hard the model should think. Maps to the API's effort levels. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tokens served from the prompt cache, billed at ~10% of input. */
  readonly cacheReadTokens: number;
  /** Tokens written to the cache, billed at ~125% of input. */
  readonly cacheWriteTokens: number;
}

export const NO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** Where an answer came from. Recorded on the decision row so a run's
 *  reliance on the model versus the rules is measurable, not assumed. */
export type AnswerSource =
  /** The model answered and its output validated. */
  | 'model'
  /** The model was asked but its answer was unusable; the rule answered. */
  | 'fallback'
  /** No model was involved — the rule-based provider. */
  | 'heuristic'
  /** Replayed from a recorded fixture. */
  | 'fixture';

export interface ReasoningRequest<T> {
  readonly category: ReasoningCategory;
  /** Null for civilization-level reasoning such as the chronicle. */
  readonly agentId: AgentId | null;
  /** Stable across calls in a category — placed first so it can be cached. */
  readonly system: string;
  /** The situation-specific part. Deliberately built small (requirement 29). */
  readonly prompt: string;
  readonly schema: z.ZodType<T>;
  /**
   * The deterministic answer. Required — see the note above. Must be cheap and
   * must not throw; it is the last line of defence when everything else fails.
   */
  readonly fallback: () => T;
  readonly maxTokens?: number;
  readonly effort?: Effort;
}

export interface ReasoningResult<T> {
  readonly value: T;
  readonly source: AnswerSource;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly costUsd: number;
  readonly durationMs: number;
  /** The rendered prompt, for the decision audit trail (ADR-0008). */
  readonly prompt: string;
  /** The model's raw response, when there was one. */
  readonly raw: string | null;
  /** Set when the model was asked but the rule answered instead. */
  readonly degradedReason?: string;
}

export interface ReasoningProvider {
  /** Identifies the provider on cost rows: 'anthropic', 'heuristic', … */
  readonly id: string;

  /**
   * Answer a request. Returns a failure only when even the fallback could not
   * be produced — in practice, never. Model problems surface as a successful
   * result whose `source` is `fallback`, because the simulation continuing with
   * duller agents beats the simulation stopping.
   */
  reason<T>(request: ReasoningRequest<T>): Promise<Result<ReasoningResult<T>>>;

  /** Release any transport. Safe to call more than once. */
  close?(): Promise<void>;
}

/**
 * Default output ceiling.
 *
 * Generous relative to Worldloom's schemas, which are small, because
 * `max_tokens` caps thinking *and* response text together — a limit sized to the
 * JSON alone truncates the answer the moment the model thinks at all. Still
 * comfortably under the SDK's non-streaming HTTP timeout.
 */
export const DEFAULT_MAX_TOKENS = 8_192;

/** Per-category effort. Strategy gets thought; bookkeeping does not. */
export const DEFAULT_EFFORT: Readonly<Record<ReasoningCategory, Effort>> = {
  goal_selection: 'medium',
  replanning: 'medium',
  message_interpretation: 'low',
  reflection: 'low',
  consolidation: 'low',
  chronicle: 'medium',
};
