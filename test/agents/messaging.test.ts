/**
 * Communication between agents (requirements 10 and 14).
 *
 * The claims worth testing are the honesty claims: that a message is the *only*
 * route knowledge takes between two minds, that a told fact is held less firmly
 * than a seen one, and that hearsay can never overwrite what an agent saw for
 * itself. Everything runs on `HeuristicProvider`, so the rule-based interpreter
 * is the one under test — as it will be in CI and for anyone without a key.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Agent } from '../../src/agents/agent.ts';
import {
  composeMessage,
  drainInbox,
  hasFunctionalPurpose,
  HEARSAY_CEILING,
  hearsayConfidence,
  ruleInterpretation,
  tell,
} from '../../src/agents/messaging.ts';
import { sequentialIdFactory } from '../../src/core/ids.ts';
import { createRng } from '../../src/core/rng.ts';
import { expect } from '../../src/core/result.ts';
import { position, type WorldTime } from '../../src/core/world.ts';
import { formatSource, OBSERVED } from '../../src/memory/types.ts';
import { Store } from '../../src/persistence/store.ts';
import { HeuristicProvider } from '../../src/reasoning/heuristic.ts';
import { foundSettlement } from '../../src/scenarios/first-settlement.ts';

interface World {
  readonly store: Store;
  readonly agents: readonly Agent[];
  readonly time: WorldTime;
}

function settled(agentCount = 2): World {
  const store = Store.openMemory(sequentialIdFactory());
  store.simulation.initialise('messaging-test', 1);
  const setup = foundSettlement({
    store,
    ids: store.ids,
    rng: createRng(3),
    center: position(0, 64, 0),
    agentCount,
  });
  return { store, agents: setup.agents, time: store.simulation.currentTime() };
}

function deps(world: World) {
  return { store: world.store, reasoning: new HeuristicProvider(), time: world.time };
}

describe('a message must be worth sending', () => {
  it('renders a discovery as something the recipient can act on', () => {
    const content = composeMessage({
      kind: 'discovery',
      subject: 'iron',
      resource: 'iron',
      at: position(120, 42, -30),
      estimatedQuantity: 24,
    });

    assert.match(content, /iron/);
    assert.match(content, /\(120, 42, -30\)/);
    assert.match(content, /about 24/);
  });

  it('refuses to send an intent that conveys nothing', () => {
    const world = settled();
    const empty = tell({ store: world.store, time: world.time }, {
      fromAgentId: world.agents[0]!.id,
      toAgentId: world.agents[1]!.id,
      intent: { kind: 'request', need: '   ' },
    });

    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.failure.kind, 'BAD_ARGS');
    assert.equal(hasFunctionalPurpose({ kind: 'offer', offering: '' }), false);
  });

  it('refuses to let an agent talk to itself', () => {
    const world = settled();
    const alone = tell({ store: world.store, time: world.time }, {
      fromAgentId: world.agents[0]!.id,
      toAgentId: world.agents[0]!.id,
      intent: { kind: 'offer', offering: 'a hand with the shelter' },
    });
    assert.equal(alone.ok, false);
  });

  it('records sending as an event, so the ledger holds the conversation', () => {
    const world = settled();
    expect(
      tell({ store: world.store, time: world.time }, {
        fromAgentId: world.agents[0]!.id,
        toAgentId: world.agents[1]!.id,
        intent: { kind: 'request', need: '20 wood' },
      }),
      'tell',
    );

    const sent = world.store.events.query({ types: ['message_sent'] });
    assert.equal(sent.length, 1);
    assert.equal((sent[0]!.payload as { toAgentId: string }).toAgentId, world.agents[1]!.id);
  });
});

describe('the rule-based interpreter reads prose', () => {
  it('extracts a resource and its position from a discovery', () => {
    const interpretation = ruleInterpretation('I found iron at (120, 42, -30) — about 24 there.', 'Arun');

    assert.equal(interpretation.purpose, 'discovery');
    assert.equal(interpretation.learned?.resource, 'iron');
    assert.deepEqual(interpretation.learned?.at, position(120, 42, -30));
    assert.equal(interpretation.learned?.estimatedQuantity, 24);
  });

  it('reads a landmark named with a space as the landmark it is', () => {
    const interpretation = ruleInterpretation('I found high ground at (10, 80, 10).', 'Sam');
    assert.equal(interpretation.learned?.location, 'high_ground');
  });

  it('does not mistake a request for a discovery just because it names a resource', () => {
    const interpretation = ruleInterpretation('I need 20 wood. Can you help?', 'Mira');

    assert.equal(interpretation.purpose, 'request');
    assert.equal(
      interpretation.learned,
      null,
      'reading a request as news would have the recipient believe in a deposit that was asked for',
    );
    assert.equal(interpretation.reconsiderPlan, true, 'being asked for something warrants a rethink');
  });

  it('reads an offer as an offer', () => {
    const interpretation = ruleInterpretation('I can offer 12 stone.', 'Elias');
    assert.equal(interpretation.purpose, 'offer');
  });

  it('learns nothing from news with no place in it', () => {
    const interpretation = ruleInterpretation('I found iron somewhere out east.', 'Arun');
    assert.equal(interpretation.purpose, 'discovery');
    assert.equal(interpretation.learned, null, 'a fact with no location cannot be acted on');
  });

  it('says plainly when it could make nothing of a message', () => {
    const interpretation = ruleInterpretation('Fine weather today.', 'Nadia');
    assert.equal(interpretation.purpose, 'unclear');
    assert.equal(interpretation.reconsiderPlan, false);
  });
});

describe('second-hand knowledge is weaker than first-hand', () => {
  it('never rates hearsay as highly as observation, however trusted the teller', () => {
    const trusted = hearsayConfidence(1, 1);
    const distrusted = hearsayConfidence(1, -1);

    assert.ok(trusted <= HEARSAY_CEILING);
    assert.ok(trusted < 0.8, 'observation enters knowledge at 0.8 to 0.9');
    assert.ok(distrusted < trusted, 'trust in the teller matters');
    assert.ok(distrusted > 0, 'but people do act on rumours');
  });

  it('stores what it was told at the discounted confidence', async () => {
    const world = settled();
    const [teller, listener] = world.agents;

    expect(
      tell({ store: world.store, time: world.time }, {
        fromAgentId: teller!.id,
        toAgentId: listener!.id,
        intent: {
          kind: 'discovery',
          subject: 'iron',
          resource: 'iron',
          at: position(60, 30, 60),
          estimatedQuantity: 40,
        },
      }),
      'tell',
    );

    const drained = expect(await drainInbox(listener!.id, deps(world)), 'drain');
    const learned = world.store.knowledge.knownResources(listener!.id, 'iron');

    assert.equal(learned.length, 1);
    assert.ok(learned[0]!.confidence <= HEARSAY_CEILING);
    assert.equal(drained.outcomes[0]!.wasNews, true);
  });

  it('refuses to let a rumour overwrite what the agent saw itself', async () => {
    const world = settled();
    const [teller, listener] = world.agents;
    const spot = position(60, 30, 60);

    // The listener has been there and looked.
    world.store.knowledge.rememberResource({
      agentId: listener!.id,
      resource: 'iron',
      position: spot,
      estimatedQuantity: 90,
      confidence: 0.9,
      source: OBSERVED,
      discoveredAtDay: 0,
      lastSeenAtTicks: 0,
    });

    expect(
      tell({ store: world.store, time: world.time }, {
        fromAgentId: teller!.id,
        toAgentId: listener!.id,
        intent: { kind: 'discovery', subject: 'iron', resource: 'iron', at: spot, estimatedQuantity: 2 },
      }),
      'tell',
    );

    const drained = expect(await drainInbox(listener!.id, deps(world)), 'drain');
    const belief = world.store.knowledge.knownResources(listener!.id, 'iron')[0]!;

    assert.equal(belief.confidence, 0.9, 'hearsay must not talk an agent out of its own eyes');
    assert.equal(formatSource(belief.source), 'observed');
    assert.equal(drained.outcomes[0]!.wasNews, false, 'and it is not news either');
  });
});

describe('draining an inbox', () => {
  it('marks messages read so news does not arrive twice', async () => {
    const world = settled();
    const [teller, listener] = world.agents;
    expect(
      tell({ store: world.store, time: world.time }, {
        fromAgentId: teller!.id,
        toAgentId: listener!.id,
        intent: { kind: 'discovery', subject: 'coal', resource: 'coal', at: position(9, 20, 9) },
      }),
      'tell',
    );

    const first = expect(await drainInbox(listener!.id, deps(world)), 'first drain');
    const second = expect(await drainInbox(listener!.id, deps(world)), 'second drain');

    assert.equal(first.outcomes.length, 1);
    assert.equal(second.outcomes.length, 0);
    assert.equal(world.store.events.query({ types: ['message_received'] }).length, 1);
  });

  it('asks the recipient to reconsider when it actually learned something', async () => {
    const world = settled();
    const [teller, listener] = world.agents;
    expect(
      tell({ store: world.store, time: world.time }, {
        fromAgentId: teller!.id,
        toAgentId: listener!.id,
        intent: { kind: 'discovery', subject: 'food', resource: 'food', at: position(30, 64, 30) },
      }),
      'tell',
    );

    const drained = expect(await drainInbox(listener!.id, deps(world)), 'drain');
    assert.equal(drained.shouldReconsider, true);
  });

  it('does not ask the recipient to reconsider over news it already had', async () => {
    const world = settled();
    const [teller, listener] = world.agents;
    const spot = position(30, 64, 30);
    world.store.knowledge.rememberResource({
      agentId: listener!.id,
      resource: 'food',
      position: spot,
      estimatedQuantity: 20,
      confidence: 0.9,
      source: OBSERVED,
      discoveredAtDay: 0,
      lastSeenAtTicks: 0,
    });

    expect(
      tell({ store: world.store, time: world.time }, {
        fromAgentId: teller!.id,
        toAgentId: listener!.id,
        intent: { kind: 'discovery', subject: 'food', resource: 'food', at: spot },
      }),
      'tell',
    );

    const drained = expect(await drainInbox(listener!.id, deps(world)), 'drain');
    assert.equal(drained.shouldReconsider, false, 'hearing a rumour you already knew changes nothing');
  });

  it('bounds how much of a flooded inbox one tick handles', async () => {
    const world = settled();
    const [teller, listener] = world.agents;
    for (let i = 0; i < 10; i++) {
      expect(
        tell({ store: world.store, time: world.time }, {
          fromAgentId: teller!.id,
          toAgentId: listener!.id,
          intent: { kind: 'request', need: `hand number ${String(i)}` },
        }),
        `tell ${i}`,
      );
    }

    const drained = expect(
      await drainInbox(listener!.id, { ...deps(world), maxMessages: 3 }),
      'drain',
    );

    assert.equal(drained.outcomes.length, 3);
    assert.equal(world.store.messages.inbox(listener!.id).length, 7, 'the rest wait, unread');
  });

  it('remembers being told, with the teller recorded as the source', async () => {
    const world = settled();
    const [teller, listener] = world.agents;
    expect(
      tell({ store: world.store, time: world.time }, {
        fromAgentId: teller!.id,
        toAgentId: listener!.id,
        intent: { kind: 'discovery', subject: 'stone', resource: 'stone', at: position(-20, 50, 8) },
      }),
      'tell',
    );

    expect(await drainInbox(listener!.id, deps(world)), 'drain');

    const hearsay = world.store.memories
      .recent(listener!.id, 10)
      .filter((memory) => formatSource(memory.source) === `told_by:${teller!.id}`);

    assert.ok(hearsay.length > 0, 'the listener should remember who told it');
    assert.ok(hearsay[0]!.confidence <= HEARSAY_CEILING);
  });

  it('leaves nothing behind for an agent nobody wrote to', async () => {
    const world = settled();
    const drained = expect(await drainInbox(world.agents[0]!.id, deps(world)), 'drain');

    assert.equal(drained.outcomes.length, 0);
    assert.equal(drained.reasoned, false);
    assert.equal(world.store.events.query({ types: ['message_received'] }).length, 0);
  });

  it('fails cleanly when asked about an agent that does not exist', async () => {
    const world = settled();
    const missing = await drainInbox('agent_nobody' as never, deps(world));
    assert.equal(missing.ok, false);
  });
});

describe('knowledge never crosses except by being told', () => {
  it('leaves the teller\'s own beliefs untouched by the telling', async () => {
    const world = settled();
    const [teller, listener] = world.agents;

    world.store.knowledge.rememberResource({
      agentId: teller!.id,
      resource: 'iron',
      position: position(100, 20, 100),
      estimatedQuantity: 50,
      confidence: 0.9,
      source: OBSERVED,
      discoveredAtDay: 0,
      lastSeenAtTicks: 0,
    });

    expect(
      tell({ store: world.store, time: world.time }, {
        fromAgentId: teller!.id,
        toAgentId: listener!.id,
        intent: {
          kind: 'discovery',
          subject: 'iron',
          resource: 'iron',
          at: position(100, 20, 100),
          estimatedQuantity: 50,
        },
      }),
      'tell',
    );
    expect(await drainInbox(listener!.id, deps(world)), 'drain');

    const tellersBelief = world.store.knowledge.knownResources(teller!.id, 'iron')[0]!;
    const listenersBelief = world.store.knowledge.knownResources(listener!.id, 'iron')[0]!;

    assert.equal(formatSource(tellersBelief.source), 'observed');
    assert.equal(formatSource(listenersBelief.source), `told_by:${teller!.id}`);
    assert.ok(
      listenersBelief.confidence < tellersBelief.confidence,
      'divergence between the two is correct behaviour, not something to reconcile',
    );
  });

  it('gives an unread message no effect on the recipient at all', async () => {
    const world = settled();
    const [teller, listener] = world.agents;
    expect(
      tell({ store: world.store, time: world.time }, {
        fromAgentId: teller!.id,
        toAgentId: listener!.id,
        intent: { kind: 'discovery', subject: 'iron', resource: 'iron', at: position(5, 5, 5) },
      }),
      'tell',
    );

    // Sent but not yet drained: the recipient has not read it, so it knows nothing.
    assert.equal(world.store.knowledge.knownResources(listener!.id, 'iron').length, 0);
    assert.equal(world.store.knowledge.relationship(listener!.id, teller!.id), null);
  });
});
