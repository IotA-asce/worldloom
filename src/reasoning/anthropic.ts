/**
 * The Anthropic-backed reasoning provider.
 *
 * Uses the API's structured-output support (`output_config.format` with a Zod
 * schema, via `messages.parse`) rather than asking for JSON in the prompt and
 * parsing prose — requirement 27, and the difference between "usually valid" and
 * "validated".
 *
 * Every failure path lands in the same place: the request's deterministic
 * fallback (ADR-0006). A refusal, a truncated answer, a rate limit, a network
 * outage, or output that fails validation all degrade the civilization's
 * intelligence rather than stopping it — and each records *why* on the result,
 * so a run's reliance on the model is measurable.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { modelFor, type ReasoningCategory, type WorldloomConfig } from '../core/config.ts';
import type { AgentId } from '../core/ids.ts';
import { ok, type Result } from '../core/result.ts';
import { estimateCostUsd } from './pricing.ts';
import {
  DEFAULT_EFFORT,
  DEFAULT_MAX_TOKENS,
  NO_USAGE,
  type ReasoningProvider,
  type ReasoningRequest,
  type ReasoningResult,
  type TokenUsage,
} from './provider.ts';

export interface AnthropicProviderOptions {
  readonly config: WorldloomConfig;
  readonly apiKey: string;
  /** Injectable for tests; defaults to a real client. */
  readonly client?: Anthropic;
  /** Called after every attempt so the caller can meter spend. */
  readonly onUsage?: (record: UsageRecord) => void;
  /** Total spend so far, in USD. Used to enforce the configured budget. */
  readonly spentUsd?: () => number;
}

export interface UsageRecord {
  readonly category: ReasoningCategory;
  /**
   * Who the reasoning was for, when it was for anyone.
   *
   * Without this, every call lands in one unattributed bucket and "which agent
   * is expensive?" — a question requirement 29 explicitly asks for — cannot be
   * answered at all.
   */
  readonly agentId: AgentId | null;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly error: string | null;
}

export class AnthropicProvider implements ReasoningProvider {
  readonly id = 'anthropic';

  private readonly client: Anthropic;
  private readonly config: WorldloomConfig;
  private readonly onUsage: ((record: UsageRecord) => void) | undefined;
  private readonly spentUsd: (() => number) | undefined;

  constructor(options: AnthropicProviderOptions) {
    this.config = options.config;
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.onUsage = options.onUsage;
    this.spentUsd = options.spentUsd;
  }

  async reason<T>(request: ReasoningRequest<T>): Promise<Result<ReasoningResult<T>>> {
    const model = modelFor(this.config, request.category);
    const started = Date.now();

    // A configured budget is a hard stop, not a warning: past it the run keeps
    // going on rules alone rather than quietly spending more.
    const budget = this.config.reasoning.budget_usd;
    if (budget !== null && this.spentUsd !== undefined && this.spentUsd() >= budget) {
      return ok(
        this.degraded(request, model, started, `reasoning budget of $${budget} reached`),
      );
    }

    const agentId = request.agentId;

    const retries = this.config.reasoning.structured_retries;
    let lastProblem = 'unknown';

    for (let attempt = 0; attempt <= retries; attempt++) {
      const attemptStarted = Date.now();
      try {
        const message = await this.client.messages.parse({
          model,
          max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          // The system prompt is stable per category, so it goes first and is
          // marked cacheable. Short prompts fall below the model's minimum
          // cacheable prefix and simply won't cache — harmless either way.
          system: [
            { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
          ],
          messages: [{ role: 'user', content: request.prompt }],
          output_config: {
            format: zodOutputFormat(request.schema),
            effort: request.effort ?? DEFAULT_EFFORT[request.category],
          },
        });

        const usage = readUsage(message.usage);
        const costUsd = estimateCostUsd(model, usage);
        const durationMs = Date.now() - attemptStarted;

        // Check why the model stopped before touching content: a refusal has no
        // content to read, and a truncated answer's JSON is incomplete.
        if (message.stop_reason === 'refusal') {
          lastProblem = `the model declined the request (${message.stop_details?.category ?? 'unspecified'})`;
          this.report(request.category, agentId, model, usage, costUsd, durationMs, false, lastProblem);
          // A refusal is deterministic — retrying the same prompt cannot help.
          break;
        }
        if (message.stop_reason === 'max_tokens') {
          lastProblem = 'the response hit max_tokens before completing';
          this.report(request.category, agentId, model, usage, costUsd, durationMs, false, lastProblem);
          continue;
        }

        const parsed = message.parsed_output;
        if (parsed === null || parsed === undefined) {
          lastProblem = 'the response did not validate against the schema';
          this.report(request.category, agentId, model, usage, costUsd, durationMs, false, lastProblem);
          continue;
        }

        this.report(request.category, agentId, model, usage, costUsd, durationMs, true, null);
        return ok({
          value: parsed,
          source: 'model',
          model,
          usage,
          costUsd,
          durationMs,
          prompt: request.prompt,
          raw: renderText(message.content),
        });
      } catch (error) {
        lastProblem = describeError(error);
        this.report(
          request.category,
          agentId,
          model,
          NO_USAGE,
          0,
          Date.now() - attemptStarted,
          false,
          lastProblem,
        );
        // Only a transient failure is worth another attempt; a bad request or a
        // rejected key will fail identically forever.
        if (!isTransient(error)) break;
      }
    }

    return ok(this.degraded(request, model, started, lastProblem));
  }

  async close(): Promise<void> {
    // The SDK holds no connection that needs closing.
  }

  /** Fall back to the request's rule, recording why. */
  private degraded<T>(
    request: ReasoningRequest<T>,
    model: string,
    started: number,
    reason: string,
  ): ReasoningResult<T> {
    return {
      value: request.fallback(),
      source: 'fallback',
      model,
      usage: NO_USAGE,
      costUsd: 0,
      durationMs: Date.now() - started,
      prompt: request.prompt,
      raw: null,
      degradedReason: reason,
    };
  }

  private report(
    category: ReasoningCategory,
    agentId: AgentId | null,
    model: string,
    usage: TokenUsage,
    costUsd: number,
    durationMs: number,
    succeeded: boolean,
    error: string | null,
  ): void {
    this.onUsage?.({ category, agentId, model, usage, costUsd, durationMs, ok: succeeded, error });
  }
}

function readUsage(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): TokenUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/** Concatenate the text blocks of a response, for the audit trail. */
function renderText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('');
}

/**
 * Whether another attempt could plausibly succeed. Checked with the SDK's typed
 * error classes rather than by matching message strings.
 */
function isTransient(error: unknown): boolean {
  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.InternalServerError) return true;
  if (error instanceof Anthropic.APIConnectionError) return true;
  return false;
}

function describeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'the API key was rejected';
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return 'the API key lacks access to this model';
  }
  if (error instanceof Anthropic.NotFoundError) {
    return 'the model was not found — check the model id';
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'rate limited';
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `the request was rejected: ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return 'could not reach the API';
  }
  if (error instanceof Anthropic.APIError) {
    return `API error ${String(error.status)}: ${error.message}`;
  }
  return `unexpected error: ${String(error)}`;
}

/** Ask the API how large a prompt is, rather than guessing from characters. */
export async function countPromptTokens(
  client: Anthropic,
  model: string,
  system: string,
  prompt: string,
): Promise<number> {
  const result = await client.messages.countTokens({
    model,
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  return result.input_tokens;
}
