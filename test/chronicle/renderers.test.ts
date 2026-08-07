/**
 * Deterministic rendering: the chronicle that needs no model (ADR-0009 step 2).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dayTitle,
  headlineFact,
  nameBook,
  renderDayProse,
  renderEvent,
  renderFacts,
} from '../../src/chronicle/renderers.ts';
import { NOT_HISTORY } from '../../src/chronicle/importance.ts';
import type { AgentId } from '../../src/core/ids.ts';
import {
  ALL_EVENT_TYPES,
  ARUN,
  MIRA,
  SAMPLE_PAYLOADS,
  SITE,
  eventMaker,
  oneOfEverything,
  testNames,
} from './fixture.ts';

describe('rendering one event', () => {
  it('writes the sentence ADR-0009 asks for', () => {
    const event = eventMaker();
    const completed = event('structure_completed', SAMPLE_PAYLOADS.structure_completed, { day: 4 });

    const fact = renderEvent(completed, testNames());

    assert.equal(
      fact.sentence,
      'Mira completed the storage at (142, 68, -91) on day 4, ' +
        'for somewhere to keep what the settlement gathers.',
    );
  });

  it('resolves agent ids to the names a reader knows', () => {
    const event = eventMaker();
    const shared = event('knowledge_shared', SAMPLE_PAYLOADS.knowledge_shared);

    const fact = renderEvent(shared, testNames());

    assert.match(fact.sentence, /^Arun told Mira about the iron seam/);
    assert.ok(!fact.sentence.includes('agent_'), 'no raw id should reach the chronicle');
  });

  it('prints the id when it cannot resolve a name, rather than inventing a settler', () => {
    const event = eventMaker();
    const died = event('agent_died', { agentId: 'agent_999999' as AgentId, cause: 'exposure' });

    const fact = renderEvent(died, testNames());

    assert.match(fact.sentence, /^agent_999999 died/);
  });

  it('names every builder of a shared structure', () => {
    const event = eventMaker();
    const completed = event('structure_completed', {
      ...SAMPLE_PAYLOADS.structure_completed,
      builders: [MIRA, ARUN],
    });

    assert.match(renderEvent(completed, testNames()).sentence, /^Mira and Arun completed/);
  });

  it('carries the evidence for the sentence it wrote', () => {
    const event = eventMaker(7);
    const founded = event('settlement_founded', SAMPLE_PAYLOADS.settlement_founded, { day: 0 });

    const fact = renderEvent(founded, testNames());

    assert.equal(fact.eventId, founded.id);
    assert.equal(fact.type, 'settlement_founded');
    assert.equal(fact.day, 0);
    assert.equal(fact.seq, 7);
    assert.equal(fact.importance, 1);
  });

  it('turns identifiers into prose rather than leaking them', () => {
    const event = eventMaker();
    const created = event('goal_created', SAMPLE_PAYLOADS.goal_created);

    const sentence = renderEvent(created, testNames()).sentence;

    assert.ok(sentence.includes('build structure'), sentence);
    assert.ok(!sentence.includes('build_structure'), 'an identifier is not prose');
  });

  it('cites the day of every event, so a sentence can stand alone', () => {
    const names = testNames();
    // The two bookkeeping types describe the record rather than the world and
    // carry their own day in the payload; selection never offers them.
    const world = oneOfEverything(4).filter((event) => !NOT_HISTORY.has(event.type));

    for (const fact of renderFacts(world, names)) {
      assert.match(
        fact.sentence,
        /\bday 4\b/i,
        `${fact.type} does not say which day it happened on: ${fact.sentence}`,
      );
    }
  });

  it('renders every event type in the ledger vocabulary', () => {
    const names = testNames();
    const facts = renderFacts(oneOfEverything(), names);

    assert.equal(facts.length, ALL_EVENT_TYPES.length);
    for (const fact of facts) {
      assert.ok(fact.sentence.length > 10, `${fact.type} rendered too little: ${fact.sentence}`);
      assert.match(
        fact.sentence,
        /[.!?]["'’”]?$/,
        `${fact.type} is not a sentence: ${fact.sentence}`,
      );
      assert.ok(!/\s{2,}/.test(fact.sentence), `${fact.type} has ragged spacing`);
    }
  });

  it('ends a sentence exactly once, whatever the payload text ended with', () => {
    const event = eventMaker();
    const sent = event('message_sent', SAMPLE_PAYLOADS.message_sent);

    // The payload's content already ends in a full stop, inside quotes.
    const sentence = renderEvent(sent, testNames()).sentence;
    assert.ok(sentence.endsWith('"'), sentence);
    assert.ok(!sentence.includes('..'), sentence);
  });
});

describe('rendering a day', () => {
  it('reads as one paragraph in ledger order', () => {
    const event = eventMaker();
    const facts = renderFacts(
      [
        event('settlement_founded', SAMPLE_PAYLOADS.settlement_founded, { seq: 1, day: 0 }),
        event('agent_spawned', SAMPLE_PAYLOADS.agent_spawned, { seq: 2, day: 0 }),
      ],
      testNames(),
    );

    const prose = renderDayProse(facts);

    assert.ok(prose.indexOf('Aurelian Reach') < prose.indexOf('Mira, Builder'), prose);
    assert.ok(!prose.includes('\n'), 'a day is a paragraph, not a list');
  });

  it('titles a day from its most consequential event', () => {
    const event = eventMaker();
    const facts = renderFacts(
      [
        event('goal_completed', SAMPLE_PAYLOADS.goal_completed),
        event('agent_died', SAMPLE_PAYLOADS.agent_died, { actorId: ARUN }),
        event('resource_discovered', SAMPLE_PAYLOADS.resource_discovered),
      ],
      testNames(),
    );

    assert.equal(headlineFact(facts)?.type, 'agent_died');
    assert.equal(dayTitle(6, facts), 'Day 6: a death');
  });

  it('says so plainly when there is nothing to say', () => {
    assert.equal(renderDayProse([]), 'Nothing worth recording happened.');
    assert.equal(dayTitle(9, []), 'Day 9: a quiet day');
  });

  it('mentions the position a reader could go and stand on', () => {
    const event = eventMaker();
    const facts = renderFacts(
      [event('structure_started', SAMPLE_PAYLOADS.structure_started)],
      testNames(),
    );

    assert.ok(
      renderDayProse(facts).includes(`(${String(SITE.x)}, ${String(SITE.y)}, ${String(SITE.z)})`),
      renderDayProse(facts),
    );
  });
});

describe('the name book', () => {
  it('is the only channel through which a name reaches the chronicle', () => {
    const empty = nameBook([]);
    assert.equal(empty.nameOf(MIRA), MIRA, 'an unknown id resolves to itself, not to a guess');

    const known = nameBook([{ id: MIRA, name: 'Mira' }]);
    assert.equal(known.nameOf(MIRA), 'Mira');
  });
});
