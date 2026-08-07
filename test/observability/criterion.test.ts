/**
 * M7's criterion, against a real run.
 *
 * The milestone is done when a developer can answer "what is each agent doing
 * and why" and "what did this run cost" — so this test seeds a small world, runs
 * it, and then answers both questions using *only* the view models. Nothing here
 * reads a repository directly: if a question cannot be answered from the views,
 * a dashboard cannot answer it either, and the milestone is not met.
 *
 * It runs against `FakeEnvironment` and the rule-based provider, so it needs no
 * server and no API key.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig, type WorldloomConfig } from '../../src/core/config.ts';
import { sequentialIdFactory } from '../../src/core/ids.ts';
import { expect } from '../../src/core/result.ts';
import { FakeEnvironment } from '../../src/environment/fake/environment.ts';
import { causalChains } from '../../src/observability/causality.ts';
import { costView } from '../../src/observability/metrics.ts';
import {
  agentView,
  civilizationView,
  failureView,
  liveFeedView,
} from '../../src/observability/views.ts';
import { silentLogger } from '../../src/observability/logger.ts';
import { Store } from '../../src/persistence/store.ts';
import { HeuristicProvider } from '../../src/reasoning/heuristic.ts';
import { Simulation } from '../../src/simulation.ts';
import { assertJsonSafe } from './seed.ts';

function config(): WorldloomConfig {
  return expect(
    parseConfig(
      {
        simulation: { agents: 2, tick_interval_seconds: 0, seed: 21 },
        environment: { type: 'fake' },
        reasoning: { provider: 'heuristic' },
      },
      {},
    ),
    'config',
  );
}

/** A world that has been alive long enough to have a history. */
async function runSmallWorld(rounds = 40): Promise<Store> {
  const store = Store.openMemory(sequentialIdFactory());
  const simulation = Simulation.create({
    config: config(),
    store,
    environment: new FakeEnvironment({ seed: 3, startTicks: 1_000, ticksPerQuery: 180 }),
    reasoning: new HeuristicProvider(),
    logger: silentLogger(),
    ids: store.ids,
  });

  expect(await simulation.start(), 'start');
  for (let round = 0; round < rounds; round++) await simulation.tickAll();

  // Close the simulation but keep the store: the views are what a separate
  // process would open, and that is the case worth exercising.
  await simulation.environment.disconnect();
  return store;
}

describe('what is each agent doing, and why', () => {
  it('is answerable for every settler from the view models alone', async () => {
    const store = await runSmallWorld();

    const civilization = civilizationView(store);
    assert.equal(civilization.initialised, true);
    assert.equal(civilization.population.total, 2);
    assert.ok(civilization.time.day >= 0);

    // One sentence per settler, assembled only from view data. Every part of it
    // has to be present, or the question is not really answered.
    const answers = civilization.population.agents.map((summary) => {
      const detail = agentView(store, summary.id);
      assert.ok(detail !== null, `no view for ${summary.name}`);

      assert.ok(detail.identity.name.length > 0);
      assert.ok(detail.status.status.length > 0, 'a settler always has a visible status');
      assert.equal(detail.needs.length, 5, 'every need is reported');
      assert.ok(detail.memoryCounts.total > 0, `${summary.name} should remember something`);

      const goal = detail.goal;
      if (goal === null) {
        // No active goal is legitimate — but then the record of what it has
        // pursued must still be there, or "why" is unanswerable.
        assert.ok(
          detail.pastGoals.length > 0 || detail.decisions > 0,
          `${summary.name} has no goal and no history explaining that`,
        );
        return `${detail.identity.name} is ${detail.status.status} with nothing in hand`;
      }

      assert.ok(goal.reason.length > 0, 'a goal must say why it exists');
      assert.ok(goal.summary.length > 0);
      if (detail.plan !== null) {
        assert.ok(detail.plan.steps.length > 0, 'a plan must have steps');
        assert.ok(
          detail.plan.steps.every((step) => step.summary.length > 0),
          'every step must be describable',
        );
        assert.ok(detail.plan.progress.total >= detail.plan.progress.done);
      }

      const step = detail.plan?.steps[detail.plan.currentStep];
      return (
        `${detail.identity.name} (${detail.identity.role}) is ${detail.status.status}: ` +
        `${goal.summary} because ${goal.reason}` +
        (step === undefined ? '' : `, currently ${step.summary} (${step.status})`)
      );
    });

    assert.equal(answers.length, 2);
    for (const answer of answers) {
      assert.ok(answer.length > 20, `not much of an answer: "${answer}"`);
      assert.doesNotMatch(answer, /undefined|null|\[object/, `a hole in the answer: "${answer}"`);
    }

    store.close();
  });

  it('traces at least one decision to what actually happened next', async () => {
    const store = await runSmallWorld();
    const civilization = civilizationView(store);

    const traced = civilization.population.agents.flatMap((summary) =>
      causalChains(store, summary.id, 5),
    );
    assert.ok(traced.length > 0, 'a run of forty rounds should have recorded decisions');

    for (const chain of traced) {
      assert.ok(chain.decision.chosenAction.length > 0, 'a decision must say what was chosen');
      assert.notEqual(chain.decision.observation, null, 'and what it was acting on');
      assert.ok(['rule_based', 'model', 'model_fallback', 'unknown'].includes(chain.decision.answeredBy));
      assert.equal(chain.decision.answeredBy, 'rule_based', 'this run has no model');
    }

    // At least one decision must be followed by something that happened, or the
    // "→ event → memory" half of the causal chain is decorative.
    assert.ok(
      traced.some((chain) => chain.consequences.length > 0),
      'no decision could be tied to a single consequence',
    );
    store.close();
  });

  it('shows the recent history and what has been going wrong', async () => {
    const store = await runSmallWorld();

    const feed = liveFeedView(store, 15);
    assert.ok(feed.entries.length > 0);
    assert.ok(feed.entries.every((entry) => entry.type.length > 0));
    assert.equal(feed.entries[0]?.seq, feed.latestSeq);

    const failures = failureView(store);
    // A failure-free run is fine; a run whose failures are not grouped is not.
    assert.equal(
      failures.byKind.reduce((sum, group) => sum + group.count, 0),
      failures.windowSize,
      'every failure in the window belongs to exactly one group',
    );
    for (const group of failures.byKind) {
      assert.ok(group.kind.length > 0);
      assert.ok(group.latest.detail.length > 0, 'a group must show a concrete occurrence');
    }
    store.close();
  });
});

describe('what did this run cost', () => {
  it('is answerable, and says plainly that a rule-based run cost nothing', async () => {
    const store = await runSmallWorld();
    const cost = costView(store);

    assert.equal(cost.total.calls, 0, 'the heuristic provider makes no model calls');
    assert.equal(cost.total.costUsd, 0);
    assert.equal(cost.total.totalTokens, 0);
    assert.equal(cost.efficiency.tokensPerAgentDay, 0);
    assert.ok(cost.efficiency.agentDays >= 2, 'two settlers, at least one day');

    // The important half: the run being free is *because* nothing asked a model,
    // and that is visible rather than assumed.
    assert.ok(cost.reliance.decisions > 0, 'decisions were made');
    assert.equal(cost.reliance.decisions, cost.reliance.ruleAnswered);
    assert.equal(cost.reliance.modelAnswered, 0);
    assert.equal(cost.reliance.modelFallback, 0);
    assert.equal(cost.reliance.ruleAnsweredShare, 1);
    assert.ok(
      cost.reliance.byModel.every((entry) => entry.ruleEngine),
      'every answer came from the rule engine',
    );

    // Attribution of *activity* is per agent even when spend is not.
    assert.equal(cost.perAgentActivity.length, 2);
    assert.ok(cost.perAgentActivity.some((entry) => entry.decisions > 0));
    store.close();
  });

  it('hands a dashboard everything as JSON', async () => {
    const store = await runSmallWorld(12);

    assertJsonSafe(civilizationView(store), 'civilizationView (live run)');
    assertJsonSafe(liveFeedView(store, 20), 'liveFeedView (live run)');
    assertJsonSafe(failureView(store), 'failureView (live run)');
    assertJsonSafe(costView(store), 'costView (live run)');
    for (const summary of civilizationView(store).population.agents) {
      assertJsonSafe(agentView(store, summary.id), `agentView (${summary.name})`);
      assertJsonSafe(causalChains(store, summary.id, 3), `causalChains (${summary.name})`);
    }
    store.close();
  });
});
