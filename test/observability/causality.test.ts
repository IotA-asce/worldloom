/**
 * Causal tracing (ADR-0008).
 *
 * The question these exist for is "why did Mira abandon the farm project?" —
 * asked in both directions. Forwards: this is what she saw, this is what she
 * recalled, this is what she decided, and here is what happened next. Backwards:
 * here is an event, and here is the decision that stands behind it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sequentialIdFactory, type MemoryId } from '../../src/core/ids.ts';
import { causalChain, causalChains, explainEvent } from '../../src/observability/causality.ts';
import { Store } from '../../src/persistence/store.ts';
import { assertJsonSafe, seedWorld } from './seed.ts';

describe('a decision traced forward to its consequences', () => {
  it('returns null for an id that is not a decision', () => {
    const world = seedWorld();
    assert.equal(causalChain(world.store, 'dec_nothing'), null);
    world.close();
  });

  it('reconstructs observation, memories, decision, events and memories', () => {
    const world = seedWorld();
    const chain = causalChain(world.store, world.shelterDecisionId);
    assert.ok(chain !== null);

    // The situation she acted on.
    const observation = chain.decision.observation as { sheltered: boolean; knownResources: number };
    assert.equal(observation.sheltered, false);
    assert.equal(observation.knownResources, 1);

    // The memories she retrieved, resolved to their content.
    assert.equal(chain.retrievedMemories.length, 2);
    assert.match(chain.retrievedMemories[0]?.content ?? '', /gave up on the farm/);
    assert.deepEqual(chain.forgottenMemoryIds, []);

    // What she chose, and by what means.
    assert.match(chain.decision.chosenAction, /^build_structure: nightfall/);
    assert.equal(chain.decision.answeredBy, 'model');
    assert.equal(chain.decision.category, 'goal_selection');

    // And what came of it, ending in what she remembered of it.
    const types = chain.consequences.map((consequence) => consequence.event.type);
    assert.ok(types.includes('goal_created'));
    assert.ok(types.includes('action_failed'));
    const failure = chain.consequences.find((entry) => entry.event.type === 'action_failed');
    assert.match(failure?.memories[0]?.content ?? '', /already been felled/);
    world.close();
  });

  it('says whether the link to its consequences was recorded or inferred', () => {
    const world = seedWorld();

    // The abandonment decision names its event, so the link is exact.
    const explicit = causalChain(world.store, world.abandonDecisionId);
    assert.equal(explicit?.link, 'explicit');
    assert.equal(explicit?.consequences[0]?.event.type, 'goal_abandoned');

    // The goal-selection decision does not, so it is held responsible for the
    // window of world time up to her next decision.
    const inferred = causalChain(world.store, world.shelterDecisionId);
    assert.equal(inferred?.link, 'reconstructed');
    assert.equal(inferred?.window.fromTicks, 25_000);
    assert.equal(inferred?.window.untilTicks, null, 'it is her latest decision, still in force');
    world.close();
  });

  it('bounds a decision window at the next decision, not at the end of the run', () => {
    const world = seedWorld();
    const chain = causalChain(world.store, world.abandonDecisionId);

    assert.equal(chain?.window.fromTicks, 11_900);
    assert.equal(chain?.window.untilTicks, 25_000, 'her next decision ends the window');
    // Everything she did on day 1 belongs to the later decision, not this one.
    assert.ok(
      chain?.consequences.every((entry) => entry.event.worldTicks < 25_000),
      'a later decision consequences must not be attributed to an earlier one',
    );
    world.close();
  });

  it('lists an agent recent decisions, newest first', () => {
    const world = seedWorld();
    const chains = causalChains(world.store, world.mira.id, 5);

    assert.equal(chains.length, 2);
    assert.deepEqual(chains.map((chain) => chain.decision.category), ['goal_selection', 'replanning']);
    assert.ok(chains.every((chain) => chain.decision.agent.name === 'Mira'));
    world.close();
  });

  it('reports a memory it cannot resolve rather than dropping it silently', () => {
    const world = seedWorld();
    const decision = world.store.decisions.record({
      agentId: world.mira.id,
      category: 'reflection',
      worldTicks: 26_000,
      day: 1,
      observation: {},
      memoryIds: ['mem_forgotten' as MemoryId],
      prompt: 'reflect',
      response: '{}',
      model: 'claude-haiku-4-5',
      chosenAction: 'belief: timber is scarce here',
      eventId: null,
      llmCallId: null,
    });

    const chain = causalChain(world.store, decision.id);
    assert.deepEqual(chain?.forgottenMemoryIds, ['mem_forgotten']);
    assert.deepEqual(chain?.retrievedMemories, []);
    world.close();
  });

  it('survives a JSON round trip', () => {
    const world = seedWorld();
    assertJsonSafe(causalChains(world.store, world.mira.id), 'causalChains');
    world.close();
  });
});

describe('an event traced back to its cause', () => {
  it('returns null for an id that is not an event', () => {
    const world = seedWorld();
    assert.equal(explainEvent(world.store, 'evt_nothing'), null);
    world.close();
  });

  it('names the decision that produced it, and the reason it gave', () => {
    const world = seedWorld();
    const explained = explainEvent(world.store, world.abandonedEventId);
    assert.ok(explained !== null);

    assert.equal(explained.link, 'explicit');
    assert.equal(explained.agent?.name, 'Mira');
    assert.match(
      explained.decision?.chosenAction ?? '',
      /no soil within reach/,
      'this is the answer to "why did Mira abandon the farm project?"',
    );
    assert.equal(explained.decision?.answeredBy, 'model');
    assert.match(explained.decision?.response ?? '', /abandon/);
    world.close();
  });

  it('resolves the goal and the plan the event belonged to', () => {
    const world = seedWorld();
    const explained = explainEvent(world.store, world.abandonedEventId);

    assert.equal(explained?.goal?.state, 'abandoned');
    assert.equal(explained?.goal?.outcome, 'no soil within reach of the settlement');
    assert.equal(explained?.goal?.summary, 'build farm');
    world.close();
  });

  it('falls back to the decision in force when no decision names the event', () => {
    const world = seedWorld();
    const failed = world.store.events
      .recentOfTypes(['action_failed'], 10)
      .find(
        (event) =>
          event.actorId === world.mira.id &&
          (event.payload as { detail: string }).detail.includes('stand of trees'),
      );
    assert.ok(failed !== undefined);

    const explained = explainEvent(world.store, failed.id);
    assert.equal(explained?.link, 'reconstructed');
    assert.equal(explained?.decision?.category, 'goal_selection', 'the goal she was acting under');
    assert.match(explained?.memories[0]?.content ?? '', /already been felled/);
    world.close();
  });

  it('shows what the actor did immediately before, oldest first', () => {
    const world = seedWorld();
    const collected = world.store.events.recentOfTypes(['resource_collected'], 1)[0]!;
    const explained = explainEvent(world.store, collected.id, { precedingEvents: 3 });

    assert.ok((explained?.precedingEvents.length ?? 0) > 0);
    assert.ok(explained?.precedingEvents.every((event) => event.actor?.name === 'Arun'));
    const sequences = explained?.precedingEvents.map((event) => event.seq) ?? [];
    assert.deepEqual([...sequences].sort((a, b) => a - b), sequences, 'the lead-up reads forwards');
    assert.ok(sequences.every((seq) => seq < collected.seq));
    world.close();
  });

  it('admits when nothing explains an event', () => {
    const store = Store.openMemory(sequentialIdFactory());
    const founded = store.events.append(
      {
        type: 'day_began',
        actorId: null,
        payload: { day: 3 },
      },
      { day: 3, worldTicks: 72_000 },
    );

    const explained = explainEvent(store, founded.id);
    assert.equal(explained?.link, 'none');
    assert.equal(explained?.decision, null);
    assert.equal(explained?.agent, null);
    assert.deepEqual(explained?.memories, []);
    assertJsonSafe(explained, 'unexplained event');
    store.close();
  });

  it('survives a JSON round trip', () => {
    const world = seedWorld();
    assertJsonSafe(explainEvent(world.store, world.abandonedEventId), 'explainEvent');
    world.close();
  });
});
