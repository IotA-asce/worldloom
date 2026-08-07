/**
 * Reasoning provider tests.
 *
 * The behaviour under test is ADR-0006's central claim: the simulation keeps
 * running whatever the model does. Every failure mode — refusal, truncation,
 * invalid output, rate limit, dead network, exhausted budget — must degrade to
 * the request's rule and say so, never throw and never stop the world.
 *
 * No test here touches the network.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { defaultConfig, parseConfig, type WorldloomConfig } from '../../src/core/config.ts';
import type { AgentId } from '../../src/core/ids.ts';
import { expect } from '../../src/core/result.ts';
import { AnthropicProvider, type UsageRecord } from '../../src/reasoning/anthropic.ts';
import { HeuristicProvider } from '../../src/reasoning/heuristic.ts';
import { createReasoningProvider } from '../../src/reasoning/index.ts';
import { estimateCostUsd, formatCostUsd, ratesFor } from '../../src/reasoning/pricing.ts';
import type { ReasoningRequest } from '../../src/reasoning/provider.ts';
import {
  hashPrompt,
  RecordingProvider,
  ScriptedProvider,
} from '../../src/reasoning/scripted.ts';

const DecisionSchema = z.object({
  decision: z.enum(['continue_goal', 'new_goal', 'abandon_goal']),
  reason: z.string(),
});

type Decision = z.infer<typeof DecisionSchema>;

const RULE_ANSWER: Decision = { decision: 'continue_goal', reason: 'the rule says carry on' };

function request(overrides: Partial<ReasoningRequest<Decision>> = {}): ReasoningRequest<Decision> {
  return {
    category: 'goal_selection',
    agentId: 'agent_000001' as AgentId,
    system: 'You choose what an agent should do next.',
    prompt: 'Mira has 22 wood and no shelter. Night is coming. What next?',
    schema: DecisionSchema,
    fallback: () => RULE_ANSWER,
    ...overrides,
  };
}

/** A stand-in for the SDK's `messages` surface. */
function fakeClient(behaviour: {
  parse?: (params: unknown) => Promise<unknown>;
  countTokens?: () => Promise<{ input_tokens: number }>;
}): never {
  return {
    messages: {
      parse: behaviour.parse ?? (async () => ({})),
      countTokens: behaviour.countTokens ?? (async () => ({ input_tokens: 0 })),
    },
  } as never;
}

function reply(overrides: Record<string, unknown> = {}): unknown {
  return {
    stop_reason: 'end_turn',
    parsed_output: { decision: 'new_goal', reason: 'shelter matters more than timber' },
    content: [{ type: 'text', text: '{"decision":"new_goal"}' }],
    usage: { input_tokens: 1200, output_tokens: 90, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...overrides,
  };
}

function anthropic(
  client: never,
  configOverrides: Partial<WorldloomConfig['reasoning']> = {},
  extras: { onUsage?: (r: UsageRecord) => void; spentUsd?: () => number } = {},
): AnthropicProvider {
  const config = expect(parseConfig({ reasoning: configOverrides }), 'config');
  return new AnthropicProvider({
    config,
    apiKey: 'test-key',
    client,
    ...(extras.onUsage !== undefined ? { onUsage: extras.onUsage } : {}),
    ...(extras.spentUsd !== undefined ? { spentUsd: extras.spentUsd } : {}),
  });
}

describe('HeuristicProvider', () => {
  it('answers with the request\'s rule and costs nothing', async () => {
    const result = expect(await new HeuristicProvider().reason(request()), 'reason');
    assert.deepEqual(result.value, RULE_ANSWER);
    assert.equal(result.source, 'heuristic');
    assert.equal(result.costUsd, 0);
    assert.deepEqual(result.usage, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('records the prompt for the audit trail even with no model involved', async () => {
    const req = request();
    const result = expect(await new HeuristicProvider().reason(req), 'reason');
    assert.equal(result.prompt, req.prompt);
    assert.equal(result.raw, null);
  });
});

describe('AnthropicProvider — the happy path', () => {
  it('returns the model\'s validated answer', async () => {
    const provider = anthropic(fakeClient({ parse: async () => reply() }));
    const result = expect(await provider.reason(request()), 'reason');

    assert.equal(result.source, 'model');
    assert.equal(result.value.decision, 'new_goal');
    assert.equal(result.usage.inputTokens, 1200);
    assert.ok(result.costUsd > 0, 'a real call should report a cost');
    assert.equal(result.degradedReason, undefined);
  });

  it('sends the category\'s configured model, cacheable system, and structured format', async () => {
    let sent: Record<string, unknown> = {};
    const provider = anthropic(
      fakeClient({
        parse: async (params) => {
          sent = params as Record<string, unknown>;
          return reply();
        },
      }),
    );
    await provider.reason(request({ category: 'reflection' }));

    // reflection routes to the cheap model by default.
    assert.equal(sent.model, 'claude-haiku-4-5');

    const system = sent.system as { text: string; cache_control?: unknown }[];
    assert.equal(system[0]?.text, 'You choose what an agent should do next.');
    assert.deepEqual(system[0]?.cache_control, { type: 'ephemeral' });

    const outputConfig = sent.output_config as { format?: unknown; effort?: string };
    assert.ok(outputConfig.format !== undefined, 'structured output must be requested');
    assert.equal(outputConfig.effort, 'low', 'reflection is cheap work');

    // max_tokens must leave room for thinking, not just the JSON.
    assert.ok((sent.max_tokens as number) >= 4096);
  });

  it('reports usage for metering', async () => {
    const records: UsageRecord[] = [];
    const provider = anthropic(fakeClient({ parse: async () => reply() }), {}, {
      onUsage: (record) => records.push(record),
    });
    await provider.reason(request());

    assert.equal(records.length, 1);
    assert.equal(records[0]?.category, 'goal_selection');
    assert.equal(records[0]?.ok, true);
    assert.equal(records[0]?.usage.outputTokens, 90);
  });
});

describe('AnthropicProvider — every failure degrades, none throws', () => {
  it('falls back when the model declines the request', async () => {
    // A refusal returns HTTP 200 with no usable content; reading content[0]
    // unconditionally would crash here.
    const provider = anthropic(
      fakeClient({
        parse: async () =>
          reply({
            stop_reason: 'refusal',
            parsed_output: null,
            content: [],
            stop_details: { type: 'refusal', category: 'cyber' },
          }),
      }),
    );

    const result = expect(await provider.reason(request()), 'reason');
    assert.deepEqual(result.value, RULE_ANSWER);
    assert.equal(result.source, 'fallback');
    assert.match(result.degradedReason ?? '', /declined the request \(cyber\)/);
  });

  it('does not retry a refusal, since the same prompt refuses again', async () => {
    let calls = 0;
    const provider = anthropic(
      fakeClient({
        parse: async () => {
          calls++;
          return reply({ stop_reason: 'refusal', parsed_output: null, content: [] });
        },
      }),
      { structured_retries: 3 },
    );
    await provider.reason(request());
    assert.equal(calls, 1);
  });

  it('retries a truncated response, then falls back', async () => {
    let calls = 0;
    const provider = anthropic(
      fakeClient({
        parse: async () => {
          calls++;
          return reply({ stop_reason: 'max_tokens', parsed_output: null });
        },
      }),
      { structured_retries: 2 },
    );

    const result = expect(await provider.reason(request()), 'reason');
    assert.equal(calls, 3, 'initial attempt plus two retries');
    assert.equal(result.source, 'fallback');
    assert.match(result.degradedReason ?? '', /max_tokens/);
  });

  it('recovers when a retry succeeds', async () => {
    let calls = 0;
    const provider = anthropic(
      fakeClient({
        parse: async () => {
          calls++;
          return calls === 1 ? reply({ parsed_output: null }) : reply();
        },
      }),
      { structured_retries: 2 },
    );

    const result = expect(await provider.reason(request()), 'reason');
    assert.equal(result.source, 'model');
    assert.equal(result.value.decision, 'new_goal');
    assert.equal(calls, 2);
  });

  it('falls back when output fails schema validation', async () => {
    const provider = anthropic(
      fakeClient({ parse: async () => reply({ parsed_output: null }) }),
      { structured_retries: 0 },
    );
    const result = expect(await provider.reason(request()), 'reason');
    assert.equal(result.source, 'fallback');
    assert.match(result.degradedReason ?? '', /did not validate/);
  });

  it('falls back when the network is unreachable, without throwing', async () => {
    const provider = anthropic(
      fakeClient({
        parse: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
      { structured_retries: 0 },
    );

    const result = expect(await provider.reason(request()), 'reason');
    assert.deepEqual(result.value, RULE_ANSWER);
    assert.equal(result.source, 'fallback');
  });

  it('stops calling once the budget is spent', async () => {
    let calls = 0;
    const provider = anthropic(
      fakeClient({
        parse: async () => {
          calls++;
          return reply();
        },
      }),
      { budget_usd: 1 },
      { spentUsd: () => 1.5 },
    );

    const result = expect(await provider.reason(request()), 'reason');
    assert.equal(calls, 0, 'a spent budget must prevent the call, not just log it');
    assert.equal(result.source, 'fallback');
    assert.match(result.degradedReason ?? '', /budget of \$1 reached/);
  });

  it('keeps calling while under budget', async () => {
    let calls = 0;
    const provider = anthropic(
      fakeClient({
        parse: async () => {
          calls++;
          return reply();
        },
      }),
      { budget_usd: 10 },
      { spentUsd: () => 0.2 },
    );
    const result = expect(await provider.reason(request()), 'reason');
    assert.equal(calls, 1);
    assert.equal(result.source, 'model');
  });

  it('reports failed attempts to the meter', async () => {
    const records: UsageRecord[] = [];
    const provider = anthropic(
      fakeClient({
        parse: async () => {
          throw new Error('boom');
        },
      }),
      { structured_retries: 0 },
      { onUsage: (record) => records.push(record) },
    );
    await provider.reason(request());
    assert.equal(records.length, 1);
    assert.equal(records[0]?.ok, false);
    assert.ok((records[0]?.error ?? '').length > 0);
  });
});

describe('ScriptedProvider', () => {
  it('replays an answer keyed by category and prompt', async () => {
    const req = request();
    const provider = new ScriptedProvider({
      fixtures: [
        {
          category: 'goal_selection',
          promptHash: hashPrompt(req.prompt),
          value: { decision: 'abandon_goal', reason: 'from the fixture' },
          model: 'claude-opus-5',
        },
      ],
    });

    const result = expect(await provider.reason(req), 'reason');
    assert.equal(result.source, 'fixture');
    assert.equal(result.value.decision, 'abandon_goal');
    assert.deepEqual(provider.usedKeys(), [`goal_selection:${hashPrompt(req.prompt)}`]);
  });

  it('answers by category when the prompt is not known in advance', async () => {
    const provider = ScriptedProvider.forCategory({
      goal_selection: { decision: 'abandon_goal', reason: 'scripted' },
    });
    const result = expect(await provider.reason(request()), 'reason');
    assert.equal(result.source, 'fixture');
    assert.equal(result.value.decision, 'abandon_goal');
  });

  it('falls back on a miss by default, so a partial fixture set still runs', async () => {
    const result = expect(await new ScriptedProvider().reason(request()), 'reason');
    assert.deepEqual(result.value, RULE_ANSWER);
    assert.match(result.degradedReason ?? '', /no fixture/);
  });

  it('fails loudly on a miss when asked to, which is what recording wants', async () => {
    const provider = new ScriptedProvider({ onMiss: 'fail' });
    const result = await provider.reason(request());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.kind, 'REASONING_INVALID');
  });

  it('rejects a fixture that no longer matches its schema', async () => {
    const req = request();
    const provider = new ScriptedProvider({
      fixtures: [
        {
          category: 'goal_selection',
          promptHash: hashPrompt(req.prompt),
          // 'dither' was never a valid decision — a stale fixture.
          value: { decision: 'dither', reason: 'stale' },
          model: 'claude-opus-5',
        },
      ],
    });

    const result = await provider.reason(req);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.failure.detail, /does not match its schema/);
  });

  it('misses when the prompt changes, rather than replaying a stale answer', async () => {
    const provider = new ScriptedProvider({
      fixtures: [
        {
          category: 'goal_selection',
          promptHash: hashPrompt('an older prompt'),
          value: { decision: 'abandon_goal', reason: 'old' },
          model: 'claude-opus-5',
        },
      ],
      onMiss: 'fail',
    });
    assert.equal((await provider.reason(request())).ok, false);
  });
});

describe('RecordingProvider', () => {
  it('records model answers as fixtures', async () => {
    const inner = anthropic(fakeClient({ parse: async () => reply() }));
    const recorder = new RecordingProvider(inner);
    const req = request();

    await recorder.reason(req);

    const fixtures = recorder.fixtures();
    assert.equal(fixtures.length, 1);
    assert.equal(fixtures[0]?.category, 'goal_selection');
    assert.equal(fixtures[0]?.promptHash, hashPrompt(req.prompt));
    assert.deepEqual(fixtures[0]?.value, {
      decision: 'new_goal',
      reason: 'shelter matters more than timber',
    });
  });

  it('does not record a rule\'s answer as if it were the model\'s', async () => {
    const recorder = new RecordingProvider(new HeuristicProvider());
    await recorder.reason(request());
    assert.equal(recorder.fixtures().length, 0);
  });

  it('serialises to committable JSON', async () => {
    const recorder = new RecordingProvider(anthropic(fakeClient({ parse: async () => reply() })));
    await recorder.reason(request());
    assert.deepEqual(JSON.parse(recorder.toJson()), recorder.fixtures());
  });
});

describe('provider selection', () => {
  it('runs rule-based when there is no API key, rather than failing', async () => {
    const selection = createReasoningProvider({ config: defaultConfig(), apiKey: undefined });
    assert.equal(selection.provider.id, 'heuristic');
    assert.match(selection.reason, /no ANTHROPIC_API_KEY/);
  });

  it('treats an empty key as absent', () => {
    const selection = createReasoningProvider({ config: defaultConfig(), apiKey: '' });
    assert.equal(selection.provider.id, 'heuristic');
  });

  it('uses Anthropic when a key is present', () => {
    const selection = createReasoningProvider({ config: defaultConfig(), apiKey: 'sk-test' });
    assert.equal(selection.provider.id, 'anthropic');
    assert.match(selection.reason, /claude-opus-5/);
  });

  it('honours an explicit heuristic configuration even with a key', () => {
    const config = expect(parseConfig({ reasoning: { provider: 'heuristic' } }), 'config');
    const selection = createReasoningProvider({ config, apiKey: 'sk-test' });
    assert.equal(selection.provider.id, 'heuristic');
  });

  it('explains its choice, so a run with no model calls is never a surprise', () => {
    for (const apiKey of [undefined, 'sk-test']) {
      const selection = createReasoningProvider({ config: defaultConfig(), apiKey });
      assert.ok(selection.reason.length > 10, 'the reason should be informative');
    }
  });
});

describe('cost estimation', () => {
  it('prices input and output separately', () => {
    const cost = estimateCostUsd('claude-opus-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.equal(cost, 5);

    const outputCost = estimateCostUsd('claude-opus-5', {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.equal(outputCost, 25);
  });

  it('prices cache reads far below fresh input', () => {
    const fresh = estimateCostUsd('claude-opus-5', {
      inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    const cached = estimateCostUsd('claude-opus-5', {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0,
    });
    assert.ok(cached < fresh / 5, `cache reads should be much cheaper: ${cached} vs ${fresh}`);
  });

  it('prices cache writes above fresh input', () => {
    const fresh = estimateCostUsd('claude-opus-5', {
      inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    const written = estimateCostUsd('claude-opus-5', {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000,
    });
    assert.ok(written > fresh);
  });

  it('makes the cheap routing genuinely cheap', () => {
    const usage = {
      inputTokens: 100_000, outputTokens: 5_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    };
    const strong = estimateCostUsd('claude-opus-5', usage);
    const cheap = estimateCostUsd('claude-haiku-4-5', usage);
    assert.ok(cheap * 4 < strong, `per-category routing should save real money: ${cheap} vs ${strong}`);
  });

  it('charges nothing for an unknown model rather than crashing', () => {
    assert.equal(ratesFor('some-future-model'), null);
    assert.equal(
      estimateCostUsd('some-future-model', {
        inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0,
      }),
      0,
    );
  });

  it('knows every model the default config routes to', () => {
    const config = defaultConfig();
    const models = new Set([config.reasoning.model, ...Object.values(config.reasoning.models)]);
    for (const model of models) {
      assert.ok(ratesFor(model) !== null, `no pricing for configured model '${model}'`);
    }
  });

  it('formats sub-cent and larger costs legibly', () => {
    assert.equal(formatCostUsd(0), '$0.00');
    assert.equal(formatCostUsd(0.0034), '$0.0034');
    assert.equal(formatCostUsd(1.5), '$1.50');
    assert.equal(formatCostUsd(12.345), '$12.35');
  });
});
