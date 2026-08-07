/**
 * Region reservations (ADR-0005).
 *
 * The interesting cases are the ones that decide whether two agents can corrupt
 * each other's build: does a partial overlap count, does a refusal say who to go
 * and talk to, and — the one that matters most for a long run — does a dead
 * agent's claim ever let go.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Agent } from '../../src/agents/agent.ts';
import { sequentialIdFactory } from '../../src/core/ids.ts';
import { createRng } from '../../src/core/rng.ts';
import { expect } from '../../src/core/result.ts';
import { position, region } from '../../src/core/world.ts';
import { Store } from '../../src/persistence/store.ts';
import { foundSettlement } from '../../src/scenarios/first-settlement.ts';
import {
  DEFAULT_RESERVATION_TICKS,
  ReservationService,
  describeReservation,
} from '../../src/scheduler/locks.ts';

function settled(agentCount = 3): { store: Store; agents: readonly Agent[] } {
  const store = Store.openMemory(sequentialIdFactory());
  store.simulation.initialise('locks-test', 1);
  const setup = foundSettlement({
    store,
    ids: store.ids,
    rng: createRng(7),
    center: position(0, 64, 0),
    agentCount,
  });
  return { store, agents: setup.agents };
}

const site = region(position(0, 60, 0), position(8, 66, 8));
const overlapping = region(position(6, 60, 6), position(14, 66, 14));
const elsewhere = region(position(40, 60, 40), position(48, 66, 48));

describe('a region can only be held by one agent', () => {
  it('grants a claim on free ground', () => {
    const { store, agents } = settled();
    const locks = new ReservationService(store);

    const claim = expect(
      locks.claim({ agentId: agents[0]!.id, region: site, atTicks: 100, purpose: 'shelter' }),
      'claim',
    );

    assert.equal(claim.agentId, agents[0]!.id);
    assert.equal(claim.purpose, 'shelter');
    assert.equal(claim.expiresAtTicks, 100 + DEFAULT_RESERVATION_TICKS);
    assert.equal(locks.holds(agents[0]!.id, site, 100), true);
  });

  it('refuses a claim that overlaps another agent, and names the holder', () => {
    const { store, agents } = settled();
    const locks = new ReservationService(store);
    expect(locks.claim({ agentId: agents[0]!.id, region: site, atTicks: 100 }), 'first claim');

    const refused = locks.claim({ agentId: agents[1]!.id, region: overlapping, atTicks: 100 });

    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.failure.kind, 'REGION_RESERVED');
      // The planner's three options are wait, choose elsewhere, or ask the
      // holder — and the third needs to know who that is.
      assert.match(refused.failure.detail, new RegExp(agents[0]!.id));
      assert.equal(refused.failure.retryable, false);
    }
  });

  it('allows two agents to work on ground that does not touch', () => {
    const { store, agents } = settled();
    const locks = new ReservationService(store);

    expect(locks.claim({ agentId: agents[0]!.id, region: site, atTicks: 100 }), 'first');
    expect(locks.claim({ agentId: agents[1]!.id, region: elsewhere, atTicks: 100 }), 'second');

    assert.equal(locks.active(100).length, 2, 'parallel building is the point of the cap');
  });

  it('treats a region touching only at a corner as a conflict', () => {
    const { store, agents } = settled();
    const locks = new ReservationService(store);
    expect(locks.claim({ agentId: agents[0]!.id, region: site, atTicks: 0 }), 'first');

    // Regions are inclusive of both corners, so sharing one block is sharing
    // ground — and two fills in the same block is precisely the corruption the
    // reservation exists to prevent.
    const corner = region(position(8, 66, 8), position(20, 70, 20));
    assert.equal(locks.claim({ agentId: agents[1]!.id, region: corner, atTicks: 0 }).ok, false);
  });

  it('renews rather than duplicates when an agent re-claims its own site', () => {
    const { store, agents } = settled();
    const locks = new ReservationService(store);

    const first = expect(
      locks.claim({ agentId: agents[0]!.id, region: site, atTicks: 100 }),
      'first',
    );
    const again = expect(
      locks.claim({ agentId: agents[0]!.id, region: overlapping, atTicks: 500 }),
      'retry',
    );

    // A retried plan step must not leave a second row behind, or releasing the
    // site would only release half of it.
    assert.equal(locks.heldBy(agents[0]!.id, 500).length, 1);
    assert.equal(again.id, first.id);
    assert.ok(again.expiresAtTicks > first.expiresAtTicks, 'the hold is extended');
  });
});

describe('a claim does not outlive its usefulness', () => {
  it('lets another agent take ground whose claim has expired', () => {
    const { store, agents } = settled();
    const locks = new ReservationService(store);

    expect(
      locks.claim({ agentId: agents[0]!.id, region: site, atTicks: 0, durationTicks: 500 }),
      'claim',
    );
    assert.equal(locks.claim({ agentId: agents[1]!.id, region: site, atTicks: 400 }).ok, false);

    // Whoever held this is gone — killed, or simply stopped coming back. Nothing
    // has to notice; the hold runs out on its own.
    const taken = locks.claim({ agentId: agents[1]!.id, region: site, atTicks: 501 });

    assert.equal(taken.ok, true);
    assert.equal(locks.holderOf(site, 501)?.agentId, agents[1]!.id);
  });

  it('sweeps expired rows instead of accumulating them', () => {
    const { store, agents } = settled();
    const locks = new ReservationService(store);

    for (let i = 0; i < 5; i++) {
      expect(
        locks.claim({
          agentId: agents[0]!.id,
          region: region(position(i * 40, 60, 0), position(i * 40 + 8, 66, 8)),
          atTicks: 0,
          durationTicks: 100,
        }),
        `claim ${i}`,
      );
    }
    assert.equal(locks.active(50).length, 5);

    // Any later claim pays for the sweep, so the table cannot grow unbounded
    // across a long run.
    expect(locks.claim({ agentId: agents[1]!.id, region: elsewhere, atTicks: 200 }), 'later claim');
    assert.equal(locks.active(200).length, 1);
    assert.equal(locks.releaseExpired(200), 0, 'nothing stale is left');
  });

  it('reports a dead agent as holding nothing once its claim lapses', () => {
    const { store, agents } = settled();
    const locks = new ReservationService(store);
    const dead = agents[0]!;

    expect(locks.claim({ agentId: dead.id, region: site, atTicks: 0, durationTicks: 10 }), 'claim');
    store.agents.update({ ...dead, status: 'dead', health: 0 });

    assert.equal(locks.heldBy(dead.id, 11).length, 0);
    assert.equal(locks.holderOf(site, 11), null, 'the ground is free again');
  });
});

describe('releasing a claim', () => {
  it('releases only the ground that overlaps what was asked for', () => {
    const { store, agents } = settled();
    const locks = new ReservationService(store);
    expect(locks.claim({ agentId: agents[0]!.id, region: site, atTicks: 0 }), 'site');
    expect(locks.claim({ agentId: agents[0]!.id, region: elsewhere, atTicks: 0 }), 'elsewhere');

    assert.equal(locks.release(agents[0]!.id, overlapping, 0), 1);
    assert.equal(locks.heldBy(agents[0]!.id, 0).length, 1);
    assert.equal(locks.holds(agents[0]!.id, elsewhere, 0), true);
  });

  it('releases everything an agent holds when it gives up', () => {
    const { store, agents } = settled();
    const locks = new ReservationService(store);
    expect(locks.claim({ agentId: agents[0]!.id, region: site, atTicks: 0 }), 'site');
    expect(locks.claim({ agentId: agents[0]!.id, region: elsewhere, atTicks: 0 }), 'elsewhere');

    assert.equal(locks.releaseAll(agents[0]!.id), 2);
    assert.equal(locks.active(0).length, 0);
  });

  it('leaves other agents alone', () => {
    const { store, agents } = settled();
    const locks = new ReservationService(store);
    expect(locks.claim({ agentId: agents[0]!.id, region: site, atTicks: 0 }), 'a');
    expect(locks.claim({ agentId: agents[1]!.id, region: elsewhere, atTicks: 0 }), 'b');

    locks.releaseAll(agents[0]!.id);
    assert.equal(locks.holderOf(elsewhere, 0)?.agentId, agents[1]!.id);
  });
});

describe('reservations are legible', () => {
  it('describes a claim in terms of who, where, and until when', () => {
    const { store, agents } = settled();
    const locks = new ReservationService(store);
    const claim = expect(
      locks.claim({ agentId: agents[0]!.id, region: site, atTicks: 100, purpose: 'shelter' }),
      'claim',
    );

    const described = describeReservation(claim);
    assert.match(described, new RegExp(agents[0]!.id));
    assert.match(described, /shelter/);
    assert.match(described, /until tick/);
  });
});
