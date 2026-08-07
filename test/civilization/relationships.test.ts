/**
 * Relationships driven by events (requirement 13, requirement 47).
 *
 * The rule under test throughout is that a relationship cannot move without a
 * stored event to explain it. So the assertions are mostly about provenance: is
 * `last_event_id` a real row, does the reason read as a sentence, and can the
 * same event move the same relationship twice.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Agent } from '../../src/agents/agent.ts';
import {
  applyEffects,
  applyRelationshipEffects,
  catchUpRelationships,
  effectOf,
  RELATIONSHIP_DELTAS,
  relationshipEffectsOf,
  relationshipUpdatesFrom,
} from '../../src/civilization/relationships.ts';
import type { EventId, StructureId } from '../../src/core/ids.ts';
import { sequentialIdFactory } from '../../src/core/ids.ts';
import { createRng } from '../../src/core/rng.ts';
import { position, region, type WorldTime } from '../../src/core/world.ts';
import type { WorldEvent } from '../../src/events/types.ts';
import { Store } from '../../src/persistence/store.ts';
import { foundSettlement } from '../../src/scenarios/first-settlement.ts';

interface World {
  readonly store: Store;
  readonly agents: readonly Agent[];
  readonly time: WorldTime;
}

function settled(agentCount = 3): World {
  const store = Store.openMemory(sequentialIdFactory());
  store.simulation.initialise('relationships-test', 1);
  const setup = foundSettlement({
    store,
    ids: store.ids,
    rng: createRng(5),
    center: position(0, 64, 0),
    agentCount,
  });
  return { store, agents: setup.agents, time: store.simulation.currentTime() };
}

function record<T extends WorldEvent>(world: World, event: Parameters<Store['events']['append']>[0]): WorldEvent {
  return world.store.events.append(event, {
    day: world.time.day,
    worldTicks: world.time.totalTicks,
  }) as T;
}

describe('an event, and only an event, moves a relationship', () => {
  it('moves the recipient of shared knowledge toward the agent who shared it', () => {
    const world = settled();
    const [arun, nadia] = world.agents;

    const event = record(world, {
      type: 'knowledge_shared',
      actorId: arun!.id,
      payload: {
        fromAgentId: arun!.id,
        toAgentId: nadia!.id,
        subject: 'iron at (60, 30, 60)',
        detail: 'Arun says there is iron at (60, 30, 60).',
      },
    });

    const changes = applyRelationshipEffects(world.store, [event], world.time);
    const nadiaOnArun = world.store.knowledge.relationship(nadia!.id, arun!.id)!;

    assert.ok(changes.length > 0);
    assert.ok(nadiaOnArun.trust > 0, 'useful information is evidence their word is worth having');
    assert.equal(nadiaOnArun.lastEventId, event.id, 'and the row points at the event that says why');
    assert.match(nadiaOnArun.lastReason ?? '', /told me about iron/);
  });

  it('keeps the relationship asymmetric', () => {
    const world = settled();
    const [arun, nadia] = world.agents;

    applyRelationshipEffects(
      world.store,
      [
        record(world, {
          type: 'knowledge_shared',
          actorId: arun!.id,
          payload: {
            fromAgentId: arun!.id,
            toAgentId: nadia!.id,
            subject: 'the ridge',
            detail: 'there is high ground north of here',
          },
        }),
      ],
      world.time,
    );

    const nadiaOnArun = world.store.knowledge.relationship(nadia!.id, arun!.id)!;
    const arunOnNadia = world.store.knowledge.relationship(arun!.id, nadia!.id)!;

    assert.ok(nadiaOnArun.trust > arunOnNadia.trust, 'she learned his word is good; he learned nothing');
    assert.equal(arunOnNadia.trust, 0);
    assert.ok(arunOnNadia.familiarity > 0, 'but they do now know each other a little better');
  });

  it('moves trust further for handing over resources than for handing over news', () => {
    const world = settled();
    const [giver, taker] = world.agents;

    applyRelationshipEffects(
      world.store,
      [
        record(world, {
          type: 'resource_transferred',
          actorId: giver!.id,
          payload: {
            fromAgentId: giver!.id,
            toAgentId: taker!.id,
            resources: { wood: 20 },
            reason: 'they had none and night was coming',
          },
        }),
      ],
      world.time,
    );

    const view = world.store.knowledge.relationship(taker!.id, giver!.id)!;
    assert.ok(view.trust > RELATIONSHIP_DELTAS.shared_information.trust);
    assert.match(view.lastReason ?? '', /gave me what they had gathered/);
  });

  it('binds together everyone who raised the same structure', () => {
    const world = settled();
    const [a, b, c] = world.agents;

    const event = record(world, {
      type: 'structure_completed',
      actorId: a!.id,
      payload: {
        structureId: 'struct_1' as StructureId,
        type: 'shelter',
        region: region(position(0, 64, 0), position(8, 70, 8)),
        builders: [a!.id, b!.id],
        purpose: 'somewhere safe to sleep',
      },
    });

    applyRelationshipEffects(world.store, [event], world.time);

    assert.ok(world.store.knowledge.relationship(a!.id, b!.id)!.trust > 0);
    assert.ok(world.store.knowledge.relationship(b!.id, a!.id)!.trust > 0);
    assert.equal(
      world.store.knowledge.relationship(a!.id, c!.id),
      null,
      'someone who did not lift a block gains nothing',
    );
  });

  it('costs a little affinity to be the one holding the ground someone needed', () => {
    const world = settled();
    const [blocked, holder] = world.agents;

    const event = record(world, {
      type: 'action_failed',
      actorId: blocked!.id,
      payload: {
        agentId: blocked!.id,
        action: 'reserve_region',
        failureKind: 'REGION_RESERVED',
        detail: `${holder!.id} is already working there`,
      },
    });

    applyRelationshipEffects(world.store, [event], world.time);
    const view = world.store.knowledge.relationship(blocked!.id, holder!.id)!;

    assert.ok(view.affinity < 0, 'being turned away from a site is not nothing');
    assert.equal(view.trust, 0, 'but they did not lie — they were simply there first');
    assert.equal(view.lastEventId, event.id);
  });

  it('ignores a failure that names nobody', () => {
    const world = settled();
    const event = record(world, {
      type: 'action_failed',
      actorId: world.agents[0]!.id,
      payload: {
        agentId: world.agents[0]!.id,
        action: 'harvest_resource',
        failureKind: 'RESOURCE_UNAVAILABLE',
        detail: 'no wood visible within 80 blocks',
      },
    });

    assert.deepEqual(relationshipEffectsOf(event), []);
  });

  it('treats the record of a change as no reason for another one', () => {
    const world = settled();
    const event = record(world, {
      type: 'relationship_changed',
      actorId: world.agents[0]!.id,
      payload: {
        agentId: world.agents[0]!.id,
        otherAgentId: world.agents[1]!.id,
        trustDelta: 0.1,
        affinityDelta: 0.1,
        reason: 'they told me about iron',
      },
    });

    assert.deepEqual(
      relationshipEffectsOf(event),
      [],
      'otherwise relationships would compound themselves with nothing happening',
    );
  });
});

describe('familiarity only rises', () => {
  it('rises on a quarrel as well as on a kindness', () => {
    const world = settled();
    const [blocked, holder] = world.agents;

    applyRelationshipEffects(
      world.store,
      [
        record(world, {
          type: 'action_failed',
          actorId: blocked!.id,
          payload: {
            agentId: blocked!.id,
            action: 'reserve_region',
            failureKind: 'REGION_RESERVED',
            detail: `${holder!.id} is already working there`,
          },
        }),
      ],
      world.time,
    );

    const view = world.store.knowledge.relationship(blocked!.id, holder!.id)!;
    assert.ok(view.familiarity > 0, 'a falling-out does not make two people strangers again');
  });

  it('never lets an effect carry a negative familiarity', () => {
    const effect = effectOf('caused_harm', {
      agentId: 'agent_a' as never,
      otherAgentId: 'agent_b' as never,
      eventId: 'evt_1' as EventId,
      reason: 'they hurt me',
    });

    assert.ok(effect.trust < 0);
    assert.ok(effect.familiarity >= 0);
  });

  it('keeps every delta in the table modest, so no one interaction decides a friendship', () => {
    for (const [kind, delta] of Object.entries(RELATIONSHIP_DELTAS)) {
      assert.ok(Math.abs(delta.trust) <= 0.4, `${kind} moves trust too far in one go`);
      assert.ok(Math.abs(delta.affinity) <= 0.4, `${kind} moves affinity too far in one go`);
      assert.ok(delta.familiarity >= 0, `${kind} would lower familiarity`);
    }
  });
});

describe('a batch of recent events', () => {
  it('turns a run of events into the updates they imply', () => {
    const world = settled();
    const [a, b] = world.agents;

    const events = [
      record(world, {
        type: 'message_sent',
        actorId: a!.id,
        payload: {
          messageId: 'msg_1' as never,
          fromAgentId: a!.id,
          toAgentId: b!.id,
          content: 'I need 20 wood. Can you help?',
        },
      }),
      record(world, {
        type: 'resource_transferred',
        actorId: b!.id,
        payload: {
          fromAgentId: b!.id,
          toAgentId: a!.id,
          resources: { wood: 20 },
          reason: 'they asked and I had some',
        },
      }),
    ];

    const updates = relationshipUpdatesFrom(events);
    assert.ok(updates.length >= 3, 'both directions of the transfer, plus the conversation');
    assert.ok(updates.every((update) => update.eventId !== undefined));

    applyEffects(world.store, updates, world.time);
    assert.ok(world.store.knowledge.relationship(a!.id, b!.id)!.trust > 0);
  });

  it('is harmless to apply the same batch twice', () => {
    const world = settled();
    const [a, b] = world.agents;
    const events = [
      record(world, {
        type: 'knowledge_shared',
        actorId: a!.id,
        payload: {
          fromAgentId: a!.id,
          toAgentId: b!.id,
          subject: 'coal at (9, 20, 9)',
          detail: 'there is coal below the ridge',
        },
      }),
    ];

    applyRelationshipEffects(world.store, events, world.time);
    const once = world.store.knowledge.relationship(b!.id, a!.id)!;

    applyRelationshipEffects(world.store, events, world.time);
    const twice = world.store.knowledge.relationship(b!.id, a!.id)!;

    assert.equal(twice.trust, once.trust, 'one interaction, one change');
    assert.equal(twice.interactions, once.interactions);
  });

  it('catches up from a cursor after a gap', () => {
    const world = settled();
    const [a, b] = world.agents;
    const before = world.store.events.latestSeq();

    record(world, {
      type: 'knowledge_shared',
      actorId: a!.id,
      payload: { fromAgentId: a!.id, toAgentId: b!.id, subject: 'the river', detail: 'water to the east' },
    });

    const caught = catchUpRelationships(world.store, before, world.time);

    assert.ok(caught.changes.length > 0);
    assert.ok(caught.throughSeq > before, 'the cursor advances so the next sweep stays cheap');
    assert.ok(world.store.knowledge.relationship(b!.id, a!.id)!.trust > 0);
  });

  it('skips an effect naming someone who is not here', () => {
    const world = settled();
    const effect = effectOf('gave_resources', {
      agentId: world.agents[0]!.id,
      otherAgentId: 'agent_ghost' as never,
      eventId: 'evt_ghost' as EventId,
      reason: 'a ghost gave me wood',
    });

    // A foreign key violation here would take the whole tick down with it.
    assert.deepEqual(applyEffects(world.store, [effect], world.time), []);
  });

  it('skips an agent forming a relationship with itself', () => {
    const world = settled();
    const self = world.agents[0]!.id;
    const effect = effectOf('spoke', {
      agentId: self,
      otherAgentId: self,
      eventId: 'evt_self' as EventId,
      reason: 'I talked to myself',
    });

    assert.deepEqual(applyEffects(world.store, [effect], world.time), []);
  });
});

describe('the ledger records why a relationship moved', () => {
  it('appends a relationship_changed event when trust or affinity moved', () => {
    const world = settled();
    const [a, b] = world.agents;

    applyRelationshipEffects(
      world.store,
      [
        record(world, {
          type: 'knowledge_shared',
          actorId: a!.id,
          payload: { fromAgentId: a!.id, toAgentId: b!.id, subject: 'iron', detail: 'iron below the ridge' },
        }),
      ],
      world.time,
    );

    const changed = world.store.events.query({ types: ['relationship_changed'] });
    assert.equal(changed.length, 1, 'the teller only gained familiarity, which is not news');
    const payload = changed[0]!.payload as { agentId: string; reason: string };
    assert.equal(payload.agentId, b!.id);
    assert.ok(payload.reason.length > 0);
  });

  it('stays quiet about routine contact', () => {
    const world = settled();
    const [a, b] = world.agents;

    applyRelationshipEffects(
      world.store,
      [
        record(world, {
          type: 'message_sent',
          actorId: a!.id,
          payload: {
            messageId: 'msg_2' as never,
            fromAgentId: a!.id,
            toAgentId: b!.id,
            content: 'I can offer 12 stone.',
          },
        }),
      ],
      world.time,
    );

    assert.equal(
      world.store.events.query({ types: ['relationship_changed'] }).length,
      0,
      'familiarity ticking up is not worth a chronicle entry',
    );
    assert.ok(world.store.knowledge.relationship(a!.id, b!.id)!.familiarity > 0);
  });
});
