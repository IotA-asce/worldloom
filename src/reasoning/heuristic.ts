/**
 * The rule-based provider — no network, no key, no cost.
 *
 * Its whole implementation is "call the request's fallback", which sounds like a
 * stub and isn't. Because `ReasoningRequest.fallback` is mandatory, every
 * reasoning call site already carries a deterministic answer, and this provider
 * simply takes it. That makes the entire simulation runnable in CI, gives
 * contributors a zero-cost path, and forces each new reasoning category to be
 * specified well enough that a rule could answer it (ADR-0006).
 *
 * If this file ever needs to grow logic, the logic belongs in the caller's
 * fallback instead — that is where the rule for that specific decision lives.
 */

import { ok, type Result } from '../core/result.ts';
import {
  NO_USAGE,
  type ReasoningProvider,
  type ReasoningRequest,
  type ReasoningResult,
} from './provider.ts';

export class HeuristicProvider implements ReasoningProvider {
  readonly id = 'heuristic';

  async reason<T>(request: ReasoningRequest<T>): Promise<Result<ReasoningResult<T>>> {
    const started = Date.now();
    return ok({
      value: request.fallback(),
      source: 'heuristic',
      model: 'heuristic',
      usage: NO_USAGE,
      costUsd: 0,
      durationMs: Date.now() - started,
      prompt: request.prompt,
      raw: null,
    });
  }
}
