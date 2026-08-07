/**
 * The settlement as a projection.
 *
 * The load-bearing test here is the last one: everything these tables hold can be
 * thrown away and rebuilt from the event ledger. The moment that stops being true,
 * the tables have quietly become a second source of truth.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { costOf } from '../../src/civilization/blueprints.ts';
import {
  applyStructureDamaged,
  blueprintForStructure,
  establishSettlement,
  foodShortfall,
  hasStandingStructure,
  nextNeededStructure,
  primarySettlement,
  settlementCenter,
  settlementShortfall,
  standingStructureTypes,
  summariseSettlement,
} from '../../src/civilization/settlement.ts';
import { reconcileCivilization } from '../../src/civilization/projects.ts';
import { sequentialIdFactory } from '../../src/core/ids.ts';
import { blueprintRegion, position } from '../../src/core/world.ts';
import { findBlueprint } from '../../src/civilization/blueprints.ts';
import { settlementOwner } from '../../src/persistence/repositories/ledger.ts';
import { Store } from '../../src/persistence/store.ts';
import { buildStructure, CENTER, firstSettlement, ticksOf, worldTime } from './fixture.ts';

describe('founding a settlement', () => {
  it('founds one, records it in the ledger, and does not found a second', () => {
    const store = Store.openMemory(sequentialIdFactory());
    store.simulation.initialise('settlement-test', 1, 1_700_000_000_000);
    const time = worldTime();

    const first = establishSettlement(store, {
      name: 'Aurelian Reach',
      objective: 'Establish a self-sustaining settlement',
      center: CENTER,
      time: ticksOf(time),
    });
    const again = establishSettlement(store, {
      name: 'Somewhere Else',
      objective: 'Something else',
      center: position(500, 64, 500),
      time: ticksOf(time),
    });

    assert.equal(again.id, first.id);
    assert.equal(again.name, 'Aurelian Reach');
    assert.equal(store.events.query({ types: ['settlement_founded'] }).length, 1);
  });

  it('adopts a settlement that the scenario founded before the tables existed', () => {
    // The scenario appends the founding event; the fixture projects it. The row
    // must carry the event's own id, or every later reference dangles.
    const fixture = firstSettlement();
    const founded = fixture.store.events.query({ types: ['settlement_founded'] })[0];
    const payload = founded?.payload as { settlementId: string };

    assert.equal(fixture.settlementId, payload.settlementId);
    assert.deepEqual(settlementCenter(fixture.store), CENTER);
    assert.equal(primarySettlement(fixture.store)?.status, 'active');
  });
});

describe('what the settlement has', () => {
  it('has nothing standing on the first day', () => {
    const fixture = firstSettlement();
    assert.deepEqual(standingStructureTypes(fixture.store), []);
    assert.equal(hasStandingStructure(fixture.store, 'shelter'), false);
    assert.deepEqual(nextNeededStructure(fixture.store)?.type, 'shelter');
  });

  it('reports a verified build as standing, and asks for storage next', () => {
    const fixture = firstSettlement();
    buildStructure(fixture, { blueprint: 'small_shelter', builders: [fixture.settler('Mira').id] });

    assert.deepEqual(standingStructureTypes(fixture.store), ['shelter']);
    assert.equal(hasStandingStructure(fixture.store, 'shelter'), true);
    assert.equal(nextNeededStructure(fixture.store)?.type, 'storage');
  });

  it('still counts a damaged structure as shelter, because it still keeps the rain off', () => {
    const fixture = firstSettlement();
    const structure = buildStructure(fixture, {
      blueprint: 'small_shelter',
      builders: [fixture.settler('Mira').id],
    });

    applyStructureDamaged(fixture.store, {
      structureId: structure.id,
      type: structure.type,
      detail: 'a wall came down in the storm',
    });

    assert.equal(fixture.store.structures.find(structure.id)?.state, 'damaged');
    assert.deepEqual(standingStructureTypes(fixture.store), ['shelter']);
  });

  it('records who built it, and adds a second builder without duplicating the row', () => {
    const fixture = firstSettlement();
    const mira = fixture.settler('Mira');
    const elias = fixture.settler('Elias');
    const structure = buildStructure(fixture, {
      blueprint: 'small_shelter',
      builders: [mira.id, elias.id],
    });

    assert.deepEqual([...structure.builders].sort(), [mira.id, elias.id].sort());
    assert.equal(fixture.store.structures.count(), 1);
  });
});

describe('what the settlement is short of', () => {
  it('is short of the whole price of its next structure when the store is empty', () => {
    const fixture = firstSettlement();
    assert.deepEqual(
      settlementShortfall(fixture.store, fixture.settlementId),
      costOf('small_shelter'),
    );
  });

  it('is short of less once settlers have deposited some of it', () => {
    const fixture = firstSettlement();
    fixture.store.ledger.credit(settlementOwner(fixture.settlementId), { wood: 20 });

    const shortfall = settlementShortfall(fixture.store, fixture.settlementId);
    const price = costOf('small_shelter');
    assert.equal(shortfall.wood, (price.wood ?? 0) - 20);
    assert.equal(shortfall.stone, price.stone);
  });

  it('prices the shortfall from the blueprint, so a bigger shelter costs more', () => {
    // Not a constant anywhere: the cost is the sum of the blocks (ADR-0004).
    const small = costOf('small_shelter');
    const communal = costOf('communal_shelter');
    assert.ok((communal.wood ?? 0) > (small.wood ?? 0));
    assert.ok((small.wood ?? 0) > 0 && (small.stone ?? 0) > 0);
  });

  it('wants food for everyone it has to feed', () => {
    const fixture = firstSettlement();
    // Five settlers, six food each, and nothing in the shared store.
    assert.equal(foodShortfall(fixture.store, fixture.settlementId), 30);

    fixture.store.ledger.credit(settlementOwner(fixture.settlementId), { food: 12 });
    assert.equal(foodShortfall(fixture.store, fixture.settlementId), 18);
  });

  it('summarises the settlement in one read', () => {
    const fixture = firstSettlement();
    buildStructure(fixture, { blueprint: 'small_shelter', builders: [fixture.settler('Mira').id] });
    const summary = summariseSettlement(fixture.store);

    assert.ok(summary !== null);
    assert.equal(summary.population, 5);
    assert.deepEqual(summary.standingTypes, ['shelter']);
    assert.equal(summary.wants?.type, 'storage');
    assert.deepEqual(summary.shortfall, costOf('storage'));
  });
});

describe('recovering a blueprint from a completed structure', () => {
  it('tells a small shelter from a communal one by its footprint', () => {
    const small = findBlueprint('small_shelter');
    const communal = findBlueprint('communal_shelter');
    assert.ok(small !== null && communal !== null);

    assert.equal(
      blueprintForStructure('shelter', blueprintRegion(small, CENTER)),
      'small_shelter',
    );
    assert.equal(
      blueprintForStructure('shelter', blueprintRegion(communal, CENTER)),
      'communal_shelter',
    );
  });

  it('falls back to the type when no blueprint makes that kind of thing', () => {
    assert.equal(
      blueprintForStructure('lighthouse', blueprintRegion(findBlueprint('storage')!, CENTER)),
      'lighthouse',
    );
  });
});

describe('the projection is only a projection', () => {
  it('rebuilds settlement and structures from the event ledger alone', () => {
    const fixture = firstSettlement();
    const mira = fixture.settler('Mira');
    const sam = fixture.settler('Sam');
    buildStructure(fixture, { blueprint: 'small_shelter', builders: [mira.id] });
    buildStructure(fixture, {
      blueprint: 'storage',
      builders: [mira.id, sam.id],
      at: position(20, 64, 20),
      time: worldTime({ totalTicks: 4_000, day: 2 }),
    });

    const before = {
      settlement: primarySettlement(fixture.store),
      structures: fixture.store.structures.all(),
    };
    assert.equal(before.structures.length, 2);

    const report = reconcileCivilization(fixture.store, { wipe: true });

    assert.equal(report.structures, 2);
    assert.deepEqual(primarySettlement(fixture.store), before.settlement);
    assert.deepEqual(fixture.store.structures.all(), before.structures);
    assert.deepEqual(report.gaps, []);
  });

  it('is idempotent: reconciling twice changes nothing', () => {
    const fixture = firstSettlement();
    buildStructure(fixture, { blueprint: 'small_shelter', builders: [fixture.settler('Mira').id] });

    reconcileCivilization(fixture.store, { wipe: true });
    const once = fixture.store.structures.all();
    reconcileCivilization(fixture.store);
    assert.deepEqual(fixture.store.structures.all(), once);
    assert.equal(fixture.store.structures.count(), 1);
  });
});
