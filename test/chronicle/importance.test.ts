/**
 * Selection: what a day's entry is allowed to be about (ADR-0009 step 1).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BASE_THRESHOLD,
  bandOf,
  describeSelection,
  MAX_FACTS,
  selectForDay,
  thresholdFor,
  eligible,
} from '../../src/chronicle/importance.ts';
import { ALWAYS_NOTABLE } from '../../src/events/types.ts';
import { ARUN, MIRA, SAMPLE_PAYLOADS, eventMaker } from './fixture.ts';

describe('importance bands', () => {
  it('reads the coarse scale the event defaults were written against', () => {
    assert.equal(bandOf(1), 'era_defining');
    assert.equal(bandOf(0.9), 'era_defining');
    assert.equal(bandOf(0.7), 'notable');
    assert.equal(bandOf(0.4), 'memorable');
    assert.equal(bandOf(0.1), 'routine');
  });
});

describe('selecting a day', () => {
  it('keeps what clears the base threshold on a quiet day', () => {
    const event = eventMaker();
    const events = [
      event('goal_completed', SAMPLE_PAYLOADS.goal_completed, { actorId: MIRA }), // 0.6
      event('agent_moved', SAMPLE_PAYLOADS.agent_moved, { actorId: MIRA }), // 0.1
      event('resource_spent', SAMPLE_PAYLOADS.resource_spent, { actorId: MIRA }), // 0.2
    ];

    const selection = selectForDay(1, events);

    assert.equal(selection.threshold, BASE_THRESHOLD, 'a quiet day does not raise the bar');
    assert.deepEqual(
      selection.events.map((selected) => selected.type),
      ['goal_completed'],
      'routine movement and spending are not history',
    );
  });

  it('ignores events from other days', () => {
    const event = eventMaker();
    const events = [
      event('structure_completed', SAMPLE_PAYLOADS.structure_completed, { day: 1 }),
      event('structure_completed', SAMPLE_PAYLOADS.structure_completed, { day: 2 }),
    ];

    assert.equal(selectForDay(2, events).events.length, 1);
    assert.equal(selectForDay(2, events).events[0]?.day, 2);
  });

  it('raises the bar when the day is busy', () => {
    const event = eventMaker();
    // Forty completed goals is a busy day, not forty times a notable one.
    const busy = Array.from({ length: 40 }, () =>
      event('goal_completed', SAMPLE_PAYLOADS.goal_completed, { actorId: MIRA }),
    );

    const selection = selectForDay(1, busy);

    assert.ok(
      selection.threshold > BASE_THRESHOLD,
      `expected the threshold to climb, stayed at ${String(selection.threshold)}`,
    );
    assert.ok(
      selection.events.length < busy.length,
      'a busy day must not put every event in the chronicle',
    );
    assert.equal(selection.considered, 40, 'but every event was considered');
  });

  it('keeps an always-notable event however busy the day, and however low its importance', () => {
    const event = eventMaker();
    const busy = Array.from({ length: 60 }, () =>
      event('goal_completed', SAMPLE_PAYLOADS.goal_completed, { actorId: MIRA }),
    );
    // Importance forced far below any threshold: type alone must carry it.
    const death = event('agent_died', SAMPLE_PAYLOADS.agent_died, {
      actorId: ARUN,
      importance: 0.01,
    });

    const selection = selectForDay(1, [...busy, death]);

    assert.ok(
      selection.events.some((selected) => selected.id === death.id),
      'a death is never routine',
    );
    assert.equal(selection.alwaysNotable, 1);
  });

  it('caps the facts per day by dropping the least important, never an always-notable one', () => {
    const event = eventMaker();
    const founding = Array.from({ length: MAX_FACTS + 6 }, () =>
      event('structure_completed', SAMPLE_PAYLOADS.structure_completed),
    );
    const chatter = Array.from({ length: 30 }, () =>
      event('goal_completed', SAMPLE_PAYLOADS.goal_completed, { actorId: MIRA }),
    );

    const selection = selectForDay(1, [...founding, ...chatter]);

    assert.equal(
      selection.events.length,
      founding.length,
      'the cap yields to the always-notable set rather than truncating it',
    );
    for (const structure of founding) {
      assert.ok(selection.events.some((selected) => selected.id === structure.id));
    }
  });

  it('prefers the more important events when trimming to the cap', () => {
    const event = eventMaker();
    const dull = Array.from({ length: 30 }, () =>
      event('goal_completed', SAMPLE_PAYLOADS.goal_completed, { actorId: MIRA, importance: 0.55 }),
    );
    const sharp = event('agent_injured', SAMPLE_PAYLOADS.agent_injured, {
      actorId: ARUN,
      importance: 0.95,
    });

    const selection = selectForDay(1, [...dull, sharp], { threshold: 0.5, max: 5 });

    assert.equal(selection.events.length, 5);
    assert.ok(
      selection.events.some((selected) => selected.id === sharp.id),
      'the injury outranks routine bookkeeping for the last slot',
    );
  });

  it('leaves out events that describe the record rather than the world', () => {
    const event = eventMaker();
    const events = [
      event('day_began', SAMPLE_PAYLOADS.day_began),
      event('chronicle_entry_written', SAMPLE_PAYLOADS.chronicle_entry_written),
      event('settlement_founded', SAMPLE_PAYLOADS.settlement_founded),
    ];

    // Even with the bar on the floor: a chronicle narrating its own writing is
    // a mirror facing a mirror.
    const selection = selectForDay(1, events, { threshold: 0 });

    assert.deepEqual(
      selection.events.map((selected) => selected.type),
      ['settlement_founded'],
    );
    assert.equal(eligible(events, 1).length, 1);
  });

  it('returns the day in ledger order, whatever order it was handed', () => {
    const event = eventMaker();
    const first = event('settlement_founded', SAMPLE_PAYLOADS.settlement_founded, { seq: 1 });
    const second = event('structure_completed', SAMPLE_PAYLOADS.structure_completed, { seq: 2 });
    const third = event('agent_died', SAMPLE_PAYLOADS.agent_died, { seq: 3, actorId: ARUN });

    const selection = selectForDay(1, [third, first, second]);

    assert.deepEqual(
      selection.events.map((selected) => selected.seq),
      [1, 2, 3],
      'evening must not be reported before morning',
    );
  });

  it('explains itself in one line', () => {
    const event = eventMaker();
    const selection = selectForDay(1, [
      event('settlement_founded', SAMPLE_PAYLOADS.settlement_founded),
    ]);
    assert.match(describeSelection(selection), /day 1: 1 of 1 events at importance >= 0\.5/);
  });
});

describe('the threshold ladder', () => {
  it('honours a pinned threshold instead of deriving one', () => {
    const event = eventMaker();
    const events = Array.from({ length: 40 }, () =>
      event('goal_completed', SAMPLE_PAYLOADS.goal_completed, { actorId: MIRA }),
    );
    assert.equal(thresholdFor(events, { threshold: 0.2 }), 0.2);
    // The cap still applies: a pinned threshold changes what is eligible, not
    // how much prose a day is worth.
    assert.equal(selectForDay(1, events, { threshold: 0.2 }).events.length, MAX_FACTS);
    assert.equal(selectForDay(1, events, { threshold: 0.2, max: 100 }).events.length, 40);
  });

  it('stops climbing at the top rung rather than excluding everything', () => {
    const event = eventMaker();
    const events = Array.from({ length: 200 }, () =>
      event('agent_injured', SAMPLE_PAYLOADS.agent_injured, { actorId: ARUN, importance: 1 }),
    );
    assert.equal(thresholdFor(events), 1);
  });

  it('counts the unavoidable events against the target', () => {
    const event = eventMaker();
    // Twelve deaths already fill the day; the optional events must be squeezed.
    const deaths = Array.from({ length: 12 }, () =>
      event('agent_died', SAMPLE_PAYLOADS.agent_died, { actorId: ARUN }),
    );
    const chatter = Array.from({ length: 4 }, () =>
      event('goal_completed', SAMPLE_PAYLOADS.goal_completed, { actorId: MIRA }),
    );

    assert.ok(thresholdFor([...deaths, ...chatter]) > BASE_THRESHOLD);
  });

  it('agrees with the ledger about which types are never routine', () => {
    // A guard on the guard: if ALWAYS_NOTABLE were emptied, the tests above
    // would still pass while the guarantee had gone.
    assert.ok(ALWAYS_NOTABLE.has('agent_died'));
    assert.ok(ALWAYS_NOTABLE.has('settlement_founded'));
    assert.ok(ALWAYS_NOTABLE.has('structure_completed'));
  });
});
