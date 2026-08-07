/**
 * Grounding: the check that makes requirement 22 structural (ADR-0009 step 4).
 *
 * The ADR is explicit that a verifier which never rejects anything is worse than
 * none at all, so most of this file is fabrication: settlers who never existed,
 * structures nobody built, coordinates from nowhere, and the celebration by the
 * fire the ADR names as the failure mode of a well-behaved model.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractClaims,
  groundingFrom,
  verify,
  verifyEntry,
  INVENTION_VOCABULARY,
  STRUCTURE_VOCABULARY,
  type Grounding,
} from '../../src/chronicle/verifier.ts';
import { dayTitle, renderDayProse, renderFacts } from '../../src/chronicle/renderers.ts';
import { NOT_HISTORY } from '../../src/chronicle/importance.ts';
import type { WorldEvent } from '../../src/events/types.ts';
import { ARUN, MIRA, SAMPLE_PAYLOADS, eventMaker, oneOfEverything, testNames } from './fixture.ts';

/** A day the whole file works against: a founding, an arrival, and a build. */
function day4(): { events: WorldEvent[]; grounding: Grounding } {
  const event = eventMaker();
  const events: WorldEvent[] = [
    event('settlement_founded', SAMPLE_PAYLOADS.settlement_founded, { day: 4 }),
    event('agent_spawned', SAMPLE_PAYLOADS.agent_spawned, { day: 4, actorId: MIRA }),
    event('structure_completed', SAMPLE_PAYLOADS.structure_completed, { day: 4 }),
    event('resource_collected', SAMPLE_PAYLOADS.resource_collected, { day: 4, actorId: MIRA }),
  ];
  return { events, grounding: groundingFrom(events, testNames(), 4) };
}

describe('the verifier rejects fabrication', () => {
  it('rejects a settler who does not exist', () => {
    const { grounding } = day4();

    const result = verify('Kael completed the storage at (142, 68, -91) on day 4.', grounding);

    assert.equal(result.grounded, false, 'an invented settler must not reach the record');
    assert.deepEqual(
      result.unbacked.map((claim) => claim.normalized),
      ['kael'],
    );
    assert.match(result.complaints.join(' '), /"Kael" is not anyone/);
  });

  it('rejects a settler introduced at the start of a sentence, where grammar hides them', () => {
    const { grounding } = day4();

    // The obvious loophole: sentence-initial capitals are grammatical, so a
    // verifier that exempts them lets any name in.
    const result = verify('Mira laid the floor. Kael raised the walls.', grounding);

    assert.equal(result.grounded, false);
    assert.deepEqual(
      result.unbacked.map((claim) => claim.normalized),
      ['kael'],
    );
  });

  it('rejects a structure nobody built', () => {
    const { grounding } = day4();

    const result = verify('Mira completed the granary on day 4.', grounding);

    assert.equal(result.grounded, false);
    assert.deepEqual(
      result.unbacked.map((claim) => claim.normalized),
      ['granary'],
    );
    assert.match(result.complaints.join(' '), /no event mentions a granary/);
  });

  it('rejects coordinates that appear in no event', () => {
    const { grounding } = day4();

    const result = verify('Mira completed the storage at (7, 8, 9) on day 4.', grounding);

    assert.equal(result.grounded, false);
    assert.deepEqual(
      result.unbacked.map((claim) => claim.normalized),
      ['7,8,9'],
    );
  });

  it('rejects a day the events did not happen on', () => {
    const { grounding } = day4();

    const result = verify('Mira completed the storage at (142, 68, -91) on day 11.', grounding);

    assert.equal(result.grounded, false);
    assert.deepEqual(
      result.unbacked.map((claim) => claim.kind),
      ['day'],
    );
  });

  it('rejects a resource nobody found', () => {
    const { grounding } = day4();

    const result = verify('Mira brought back iron and coal on day 4.', grounding);

    assert.equal(result.grounded, false);
    assert.deepEqual(
      result.unbacked.map((claim) => claim.normalized).sort(),
      ['coal', 'iron'],
    );
  });

  it('rejects the celebration by the fire that ADR-0009 warns about', () => {
    const { grounding } = day4();

    // No name, no coordinate, no structure — and still fiction.
    const result = verify(
      'The storage was finished on day 4, and they celebrated by the fire.',
      grounding,
    );

    assert.equal(result.grounded, false);
    assert.deepEqual(
      result.unbacked.map((claim) => claim.normalized).sort(),
      ['celebrated', 'fire'],
    );
    assert.match(result.complaints.join(' '), /do not add colour/);
  });

  it('rejects a fabricated headline as readily as fabricated prose', () => {
    const { grounding } = day4();

    const result = verifyEntry(
      "Day 4: Kael's triumph",
      'The storage was completed on day 4.',
      grounding,
    );

    assert.equal(result.grounded, false, 'a headline is a claim too');
  });

  it('reports every problem at once, deduplicated, so a retry can fix them all', () => {
    const { grounding } = day4();

    const result = verify(
      'Kael and Kael built the granary at (7, 8, 9) on day 12 and feasted.',
      grounding,
    );

    assert.equal(result.grounded, false);
    assert.equal(result.complaints.length, 5, result.complaints.join('; '));
  });
});

describe('the verifier accepts what the events support', () => {
  it('accepts prose that only recombines the facts it was given', () => {
    const { grounding } = day4();

    const result = verify(
      'Aurelian Reach was founded at (142, 68, -91) on day 4. Mira, who arrived that ' +
        'same day, gathered 24 wood and completed the storage at (142, 68, -91).',
      grounding,
    );

    assert.equal(result.grounded, true, result.complaints.join('; '));
    assert.ok(result.claims.length > 5, 'and it did extract claims to check');
  });

  it('accepts a settlement name because the founding event carries it', () => {
    const { grounding } = day4();
    assert.equal(verify('Aurelian Reach stood on day 4.', grounding).grounded, true);
  });

  it('accepts a region corner and its centre, since both are in the event', () => {
    const { grounding } = day4();

    // resource_collected names the region (100, 64, -100)..(110, 70, -90).
    assert.equal(verify('The cut ran from (100, 64, -100).', grounding).grounded, true);
    assert.equal(verify('The cut ran to (110, 70, -90).', grounding).grounded, true);
    assert.equal(verify('The cut centred on (105, 67, -95).', grounding).grounded, true);
    assert.equal(verify('The cut ran to (111, 70, -90).', grounding).grounded, false);
  });

  it('treats capitalised ordinary words as grammar rather than as names', () => {
    const { grounding } = day4();

    const result = verify(
      'The settlers worked through the day. Nothing else was recorded. Their storage stood.',
      grounding,
    );

    assert.equal(result.grounded, true, result.complaints.join('; '));
  });

  it('accepts a possessive form of a real name', () => {
    const { grounding } = day4();
    assert.equal(verify("Mira's storage stood on day 4.", grounding).grounded, true);
  });
});

describe('the deterministic rendering is always its own witness', () => {
  it('passes verification for every event type in the vocabulary', () => {
    // The fallback must survive the check that guards it, or a rejected
    // narration would leave the pipeline with nothing truthful to fall back on.
    const names = testNames();
    for (const event of oneOfEverything(4)) {
      if (NOT_HISTORY.has(event.type)) continue;
      const facts = renderFacts([event], names);
      const grounding = groundingFrom([event], names, 4);
      const result = verifyEntry(dayTitle(4, facts), renderDayProse(facts), grounding);
      assert.equal(
        result.grounded,
        true,
        `${event.type}: ${result.complaints.join('; ')}\n  ${renderDayProse(facts)}`,
      );
    }
  });

  it('passes verification for a whole day rendered together', () => {
    const names = testNames();
    const events = oneOfEverything(4).filter((event) => !NOT_HISTORY.has(event.type));
    const facts = renderFacts(events, names);
    const grounding = groundingFrom(events, names, 4);

    const result = verifyEntry(dayTitle(4, facts), renderDayProse(facts), grounding);

    assert.equal(result.grounded, true, result.complaints.join('; '));
  });
});

describe('claim extraction', () => {
  it('finds coordinates, days, structures, resources and names', () => {
    const kinds = new Set(
      extractClaims('Mira finished the shelter at (1, 2, 3) on day 5 with wood.').map(
        (claim) => claim.kind,
      ),
    );
    assert.deepEqual([...kinds].sort(), ['coordinate', 'day', 'name', 'resource', 'structure']);
  });

  it('does not mistake a quantity for a day number', () => {
    const { grounding } = day4();
    // 24 wood is in the events; "day 24" is not, and only the second is a claim
    // about when something happened.
    assert.equal(verify('Mira gathered 24 wood on day 4.', grounding).grounded, true);
    assert.equal(verify('Mira gathered wood on day 24.', grounding).grounded, false);
  });

  it('does not treat an acronym or a bare "I" as an invented settler', () => {
    const { grounding } = day4();
    assert.equal(verify('I saw the storage on day 4.', grounding).grounded, true);
  });

  it('keeps the vocabularies it checks non-empty', () => {
    // A guard on the guard: an emptied vocabulary would silently disable a whole
    // class of check while every test above still passed.
    assert.ok(STRUCTURE_VOCABULARY.includes('granary'));
    assert.ok(STRUCTURE_VOCABULARY.includes('shelter'));
    assert.ok(INVENTION_VOCABULARY.includes('celebrated'));
  });
});

describe('the grounding set comes only from the events', () => {
  it('draws names from the agents the events reference, and no further', () => {
    const event = eventMaker();
    const events = [event('agent_died', { agentId: ARUN, cause: 'exposure' }, { actorId: ARUN })];
    const grounding = groundingFrom(events, testNames(), 1);

    assert.ok(grounding.names.has('arun'));
    assert.ok(
      !grounding.names.has('mira'),
      'a settler who appears in no event today cannot be mentioned today',
    );
    assert.equal(verify('Mira died on day 1.', grounding).grounded, false);
  });

  it('records the event ids the grounding was built from', () => {
    const { events, grounding } = day4();
    assert.deepEqual(grounding.eventIds, events.map((event) => event.id));
  });
});
