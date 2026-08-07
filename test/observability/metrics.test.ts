/**
 * Cost, token and reliance accounting (requirement 29).
 *
 * The figures that matter here are the ones a person acts on: what a run has
 * cost, what a longer one would cost, and whether the agents are thinking with
 * the model they were configured with or quietly falling back to rules.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sequentialIdFactory } from '../../src/core/ids.ts';
import {
  answerSourceOf,
  costView,
  daysElapsed,
  efficiencyView,
  failedCallsView,
  recentCallsView,
  relianceView,
} from '../../src/observability/metrics.ts';
import { Store } from '../../src/persistence/store.ts';
import { assertJsonSafe, insertAgent, seedWorld } from './seed.ts';

describe('cost accounting', () => {
  it('reports a rule-based run as costing nothing, without special cases', () => {
    const store = Store.openMemory(sequentialIdFactory());
    const view = costView(store);

    assert.deepEqual(view.total, {
      calls: 0,
      failedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    });
    assert.deepEqual(view.byCategory, []);
    assert.equal(view.efficiency.tokensPerAgentDay, 0, 'no division by zero on an empty world');
    assertJsonSafe(view, 'empty costView');
    store.close();
  });

  it('totals calls, tokens and estimated spend', () => {
    const world = seedWorld();
    const { total } = costView(world.store);

    assert.equal(total.calls, 4);
    assert.equal(total.failedCalls, 1);
    assert.equal(total.inputTokens, 1_200 + 1_600 + 1_500 + 900);
    assert.equal(total.outputTokens, 180 + 220 + 0 + 120);
    assert.equal(total.totalTokens, 5_200 + 520);
    assert.ok(Math.abs(total.costUsd - 0.033) < 1e-9);
    world.close();
  });

  it('attributes spend per category, per day and per model', () => {
    const world = seedWorld();
    const view = costView(world.store);

    const goalSelection = view.byCategory.find((entry) => entry.category === 'goal_selection');
    assert.equal(goalSelection?.calls, 2);
    assert.equal(goalSelection?.failedCalls, 1);

    assert.deepEqual(view.byDay.map((entry) => entry.day), [0, 1]);
    assert.equal(view.byDay[0]?.calls, 1);
    assert.equal(view.byDay[1]?.calls, 3);
    assert.equal(view.byDay[1]?.decisions, 3, 'the day the settlers made three decisions');

    assert.deepEqual(view.byModel.map((entry) => entry.model), ['claude-opus-5', 'claude-haiku-4-5']);
    assert.ok(view.byModel.every((entry) => entry.priced), 'both models have published rates');
    world.close();
  });

  it('says how much spend it could not attribute rather than apportioning it', () => {
    const world = seedWorld();
    const view = costView(world.store);

    assert.equal(view.unattributedCalls, 3, 'the usage callback carries no agent');
    const unattributed = view.byAgent.find((entry) => entry.agent === null);
    assert.equal(unattributed?.calls, 3);

    // Decisions, by contrast, are recorded per agent and can be trusted.
    assert.deepEqual(
      view.perAgentActivity.map((entry) => `${entry.agent.name ?? '?'}:${String(entry.decisions)}`),
      ['Mira:2', 'Arun:2'],
    );
    world.close();
  });

  it('survives a JSON round trip', () => {
    const world = seedWorld();
    assertJsonSafe(costView(world.store), 'costView');
    assertJsonSafe(recentCallsView(world.store, 10), 'recentCallsView');
    assertJsonSafe(failedCallsView(world.store, 10), 'failedCallsView');
    world.close();
  });
});

describe('efficiency per agent-day', () => {
  it('counts day zero as a day, so a fresh run still divides', () => {
    const store = Store.openMemory(sequentialIdFactory());
    store.simulation.initialise('first-settlement', 1);
    assert.equal(daysElapsed(store), 1);
    store.close();
  });

  it('divides the run by the settlers and the days it covers', () => {
    const world = seedWorld();
    const efficiency = efficiencyView(world.store);

    assert.equal(efficiency.days, 2, 'day 0 and day 1');
    assert.equal(efficiency.agents, 2);
    assert.equal(efficiency.agentDays, 4);
    assert.equal(efficiency.totalTokens, 5_720);
    assert.equal(efficiency.tokensPerAgentDay, 5_720 / 4);
    assert.ok(Math.abs(efficiency.costUsdPerAgentDay - 0.033 / 4) < 1e-9);
    assert.equal(efficiency.decisions, 4);
    assert.equal(efficiency.decisionsPerAgentDay, 1);
    world.close();
  });

  it('projects the cost of another day at the run current rate', () => {
    const world = seedWorld();
    const efficiency = efficiencyView(world.store);

    assert.ok(Math.abs(efficiency.projectedCostUsdPerDay - 0.033 / 2) < 1e-9);
    assert.equal(efficiency.tokensPerCall, 5_720 / 4);
    world.close();
  });
});

describe('reliance on the model', () => {
  it('classifies one decision from the row it left behind', () => {
    assert.equal(answerSourceOf({ model: 'heuristic', response: null }, true), 'rule_based');
    assert.equal(answerSourceOf({ model: 'scripted', response: '{}' }, true), 'rule_based');
    assert.equal(answerSourceOf({ model: 'claude-opus-5', response: '{}' }, true), 'model');
    assert.equal(
      answerSourceOf({ model: 'claude-opus-5', response: null }, true),
      'model_fallback',
      'a model was asked and a rule answered',
    );
    assert.equal(
      answerSourceOf({ model: 'claude-opus-5', response: null }, false),
      'unknown',
      'without stored text the two cannot be told apart',
    );
  });

  it('makes a silent fallback visible', () => {
    const world = seedWorld();
    const reliance = relianceView(world.store);

    assert.equal(reliance.decisions, 4);
    assert.equal(reliance.modelAnswered, 2);
    assert.equal(reliance.ruleAnswered, 1, "Arun's replan was answered by the rule engine");
    assert.equal(reliance.modelFallback, 1, 'and one model call could not be used');
    assert.equal(reliance.undetermined, 0);
    assert.equal(reliance.ruleAnsweredShare, 0.5);
    assert.equal(reliance.failedCalls, 1);
    assert.equal(reliance.textRecorded, true);
    world.close();
  });

  it('breaks reliance down by category and by model', () => {
    const world = seedWorld();
    const reliance = relianceView(world.store);

    const selection = reliance.byCategory.find((entry) => entry.category === 'goal_selection');
    assert.equal(selection?.decisions, 2);
    assert.equal(selection?.modelAnswered, 1);
    assert.equal(selection?.modelFallback, 1);

    assert.deepEqual(
      reliance.byModel.map((entry) => `${entry.model}:${String(entry.decisions)}`),
      ['claude-opus-5:3', 'heuristic:1'],
    );
    assert.equal(reliance.byModel.find((entry) => entry.model === 'heuristic')?.ruleEngine, true);
    world.close();
  });

  it('admits it cannot tell when a world stores no decision text', () => {
    // A store built the way `record_decisions: false` builds one: the causal link
    // survives, the text does not.
    const quiet = Store.open({ path: ':memory:', ids: sequentialIdFactory(), recordDecisionText: false });
    const agent = insertAgent(quiet, 'Tam');
    quiet.decisions.record({
      agentId: agent.id,
      category: 'goal_selection',
      worldTicks: 10,
      day: 0,
      observation: {},
      memoryIds: [],
      prompt: 'a prompt that will not be kept',
      response: 'a response that will not be kept',
      model: 'claude-opus-5',
      chosenAction: 'rest: tired',
      eventId: null,
      llmCallId: null,
    });

    const reliance = relianceView(quiet);
    assert.equal(reliance.textRecorded, false);
    assert.equal(reliance.undetermined, 1);
    assert.equal(reliance.modelAnswered, 0);
    assert.equal(reliance.ruleAnsweredShare, 0, 'no claim is made either way');
    quiet.close();
  });
});
