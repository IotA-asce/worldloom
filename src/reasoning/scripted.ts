/**
 * Fixture playback and recording.
 *
 * `ScriptedProvider` replays canned answers so tests can exercise
 * *model-shaped* behaviour — an agent acting on a decision the rules would not
 * have made — without a network call. `RecordingProvider` wraps a real provider
 * to capture those fixtures in the first place.
 *
 * Fixtures are keyed by category plus a hash of the prompt, so a prompt change
 * misses its fixture loudly rather than silently replaying a stale answer.
 */

import { createHash } from 'node:crypto';
import type { ReasoningCategory } from '../core/config.ts';
import { fail, ok, type Result } from '../core/result.ts';
import {
  NO_USAGE,
  type ReasoningProvider,
  type ReasoningRequest,
  type ReasoningResult,
} from './provider.ts';

export interface Fixture {
  readonly category: ReasoningCategory;
  /** Hash of the prompt this answer was recorded for. */
  readonly promptHash: string;
  /** The parsed answer, as JSON. Validated against the schema on replay. */
  readonly value: unknown;
  readonly model: string;
}

export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

export function fixtureKey(category: ReasoningCategory, prompt: string): string {
  return `${category}:${hashPrompt(prompt)}`;
}

export interface ScriptedProviderOptions {
  readonly fixtures?: readonly Fixture[];
  /**
   * What to do when no fixture matches. `fallback` (default) uses the request's
   * rule, which keeps a partially-recorded suite running; `fail` surfaces the
   * miss, which is what you want while recording.
   */
  readonly onMiss?: 'fallback' | 'fail';
}

export class ScriptedProvider implements ReasoningProvider {
  readonly id = 'scripted';

  private readonly fixtures = new Map<string, Fixture>();
  private readonly onMiss: 'fallback' | 'fail';
  /** Keys that were actually used, so a test can assert its fixtures were hit. */
  private readonly hits = new Set<string>();

  constructor(options: ScriptedProviderOptions = {}) {
    for (const fixture of options.fixtures ?? []) {
      this.fixtures.set(`${fixture.category}:${fixture.promptHash}`, fixture);
    }
    this.onMiss = options.onMiss ?? 'fallback';
  }

  /**
   * Queue an answer for the next request in a category, without needing to know
   * the prompt in advance. The common case in a test: "when the agent next
   * chooses a goal, have it choose this one."
   */
  static forCategory(
    answers: Partial<Record<ReasoningCategory, unknown>>,
  ): ScriptedProvider {
    const provider = new ScriptedProvider();
    for (const [category, value] of Object.entries(answers)) {
      provider.byCategory.set(category as ReasoningCategory, value);
    }
    return provider;
  }

  /** Category-keyed answers, used when no prompt-specific fixture matches. */
  private readonly byCategory = new Map<ReasoningCategory, unknown>();

  async reason<T>(request: ReasoningRequest<T>): Promise<Result<ReasoningResult<T>>> {
    const started = Date.now();
    const key = fixtureKey(request.category, request.prompt);

    const candidate = this.fixtures.get(key)?.value ?? this.byCategory.get(request.category);

    if (candidate === undefined) {
      if (this.onMiss === 'fail') {
        return fail(
          'REASONING_INVALID',
          `no fixture for ${key}; record one or set onMiss to 'fallback'`,
        );
      }
      return ok({
        value: request.fallback(),
        source: 'heuristic',
        model: 'scripted',
        usage: NO_USAGE,
        costUsd: 0,
        durationMs: Date.now() - started,
        prompt: request.prompt,
        raw: null,
        degradedReason: `no fixture for ${key}`,
      });
    }

    // Validate the fixture too. A fixture that no longer matches its schema is
    // a stale test, and should fail rather than inject a bad shape.
    const parsed = request.schema.safeParse(candidate);
    if (!parsed.success) {
      return fail(
        'REASONING_INVALID',
        `fixture for ${key} does not match its schema: ${parsed.error.message}`,
      );
    }

    this.hits.add(key);
    return ok({
      value: parsed.data,
      source: 'fixture',
      model: 'scripted',
      usage: NO_USAGE,
      costUsd: 0,
      durationMs: Date.now() - started,
      prompt: request.prompt,
      raw: JSON.stringify(candidate),
    });
  }

  usedKeys(): readonly string[] {
    return [...this.hits];
  }
}

/**
 * Wraps another provider and records every model-sourced answer as a fixture.
 * Run once against the real API, commit the output, and CI replays it for free.
 */
export class RecordingProvider implements ReasoningProvider {
  readonly id: string;
  private readonly recorded: Fixture[] = [];

  constructor(private readonly inner: ReasoningProvider) {
    this.id = `recording:${inner.id}`;
  }

  async reason<T>(request: ReasoningRequest<T>): Promise<Result<ReasoningResult<T>>> {
    const result = await this.inner.reason(request);
    // Only genuine model answers are worth recording — a fallback would just
    // bake the rule's answer into a fixture that adds nothing.
    if (result.ok && result.value.source === 'model') {
      this.recorded.push({
        category: request.category,
        promptHash: hashPrompt(request.prompt),
        value: result.value.value,
        model: result.value.model,
      });
    }
    return result;
  }

  fixtures(): readonly Fixture[] {
    return this.recorded;
  }

  /** Serialise for committing to `test/fixtures/`. */
  toJson(): string {
    return JSON.stringify(this.recorded, null, 2);
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }
}
