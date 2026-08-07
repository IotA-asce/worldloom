/**
 * Reflection tests.
 *
 * Two things matter here and neither is "an LLM was called".
 *
 * First, the rule has to be genuinely usable: every test in this suite runs on
 * `HeuristicProvider`, so what these tests exercise *is* the deterministic
 * fallback ADR-0006 makes mandatory. If it produced empty or meaningless
 * beliefs, the keyless path would be a lie.
 *
 * Second, a belief must stay attached to its evidence — the episodes it was
 * drawn from, still present, still retrievable (requirement 12).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NEUTRAL_PERSONALITY,
  NO_SKILLS,
  STARTING_NEEDS,
  type Agent,
} from '../../src/agents/agent.ts';
import { sequentialIdFactory, type AgentId } from '../../src/core/ids.ts';
import { expect } from '../../src/core/result.ts';
import { position, type WorldTime } from '../../src/core/world.ts';
import {
  classifyOutcome,
  FAILURE_TAG,
  outcomeTag,
  reflect,
  reflectionPrompt,
  ReflectionSchema,
  ruleReflection,
  shouldReflect,
  SUCCESS_TAG,
} from '../../src/memory/reflection.ts';
import { retrieve } from '../../src/memory/retrieval.ts';
import { OBSERVED, type MemoryEntry, type NewMemory } from '../../src/memory/types.ts';
import { Store } from '../../src/persistence/store.ts';
import { HeuristicProvider } from '../../src/reasoning/heuristic.ts';

const MIRA = 'agent_000001' as AgentId;

function makeAgent(): Agent {
  return {
    id: MIRA,
    name: 'Mira',
    role: 'Settler',
    personality: NEUTRAL_PERSONALITY,
    skills: NO_SKILLS,
    needs: STARTING_NEEDS,
    position: position(0, 64, 0),
    health: 1,
    status: 'idle',
    phase: 'observe',
    currentGoalId: null,
    lastTickAt: 0,
    activity: '',
    spawnedAtDay: 0,
  };
}

function freshStore(): Store {
  const store = Store.openMemory(sequentialIdFactory());
  store.simulation.initialise('memory-test', 1, 1_700_000_000_000);
  store.agents.insert(makeAgent());
  return store;
}

function time(totalTicks: number): WorldTime {
  return {
    totalTicks,
    day: Math.floor(totalTicks / 24_000),
    phase: 'day',
    isDay: true,
    weather: 'clear',
  };
}

function remember(
  store: Store,
  memory: Omit<NewMemory, 'agentId' | 'source'>,
  atTicks: number,
): MemoryEntry {
  return store.memories.insert(
    { agentId: MIRA, source: OBSERVED, ...memory },
    { day: Math.floor(atTicks / 24_000), worldTicks: atTicks },
  );
}

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'mem_000999' as MemoryEntry['id'],
    agentId: MIRA,
    type: 'episodic',
    content: 'Something happened.',
    importance: 0.4,
    confidence: 1,
    source: OBSERVED,
    relatedEntities: [],
    tags: [],
    createdAtDay: 1,
    createdAtTicks: 1_000,
    lastAccessedAtTicks: 1_000,
    accessCount: 0,
    eventId: null,
    consolidatedInto: null,
    ...overrides,
  };
}

/** Repeated failures at one place — the shape reflection exists to notice. */
function barrenRidge(store: Store): MemoryEntry[] {
  const contents = [
    'I dug at the northern ridge and found no iron.',
    'The northern ridge gave me nothing again.',
    'I searched the northern ridge a third time and came away empty.',
  ];
  return contents.map((content, index) =>
    remember(
      store,
      {
        type: 'episodic',
        content,
        importance: 0.4,
        tags: ['northern ridge', 'iron', FAILURE_TAG],
      },
      2_000 + index * 1_000,
    ),
  );
}

describe('reading how an episode turned out', () => {
  it('trusts an explicit outcome tag over anything in the prose', () => {
    // A tag cannot be misread; prose can. Writers of memories are meant to
    // supply one, and when they do it wins.
    assert.equal(classifyOutcome(entry({ tags: [SUCCESS_TAG], content: 'I failed utterly.' })), 'success');
    assert.equal(classifyOutcome(entry({ tags: [FAILURE_TAG], content: 'I found plenty.' })), 'failure');
    assert.equal(outcomeTag(true), SUCCESS_TAG);
    assert.equal(outcomeTag(false), FAILURE_TAG);
  });

  it('falls back to reading the memory, for anything written without a tag', () => {
    assert.equal(classifyOutcome(entry({ content: 'The seam was empty and I could not dig further.' })), 'failure');
    assert.equal(classifyOutcome(entry({ content: 'I found a wide stand of oak and gathered timber.' })), 'success');
    assert.equal(classifyOutcome(entry({ content: 'I walked south for a while.' })), 'neutral');
  });
});

describe('the deterministic reflection', () => {
  it('generalises a run of failures at one place into a belief about that place', () => {
    const store = freshStore();
    const reflection = ruleReflection(barrenRidge(store));
    assert.ok(reflection !== null);
    assert.equal(reflection.subject, 'northern ridge');
    assert.match(reflection.belief, /northern ridge has gone badly/);
    assert.match(reflection.belief, /3 of 3/);
    // The generalisation outlives its episodes, so it is worth more than they were.
    assert.ok(reflection.importance > 0.4);
    assert.equal(reflection.confidence, 1);
    assert.ok(reflection.tags.includes('northern ridge'));
    // Its evidence's other handle is kept, so the belief is reachable by it too.
    assert.ok(reflection.tags.includes('iron'));
    store.close();
  });

  it('says so when something has been working, not only when it has not', () => {
    const store = freshStore();
    for (let day = 1; day <= 3; day++) {
      remember(
        store,
        {
          type: 'episodic',
          content: 'I gathered timber by the river.',
          importance: 0.3,
          tags: ['river', 'wood'],
        },
        day * 1_000,
      );
    }
    const reflection = ruleReflection(store.memories.unconsolidated(MIRA, 'episodic'));
    assert.ok(reflection !== null);
    assert.match(reflection.belief, /has been reliable for me: 3 of 3/);
    store.close();
  });

  it('holds a belief less firmly when the evidence disagrees with itself', () => {
    const store = freshStore();
    remember(store, { type: 'episodic', content: 'good', importance: 0.4, tags: ['river', SUCCESS_TAG] }, 1_000);
    remember(store, { type: 'episodic', content: 'good', importance: 0.4, tags: ['river', SUCCESS_TAG] }, 2_000);
    remember(store, { type: 'episodic', content: 'bad', importance: 0.4, tags: ['river', FAILURE_TAG] }, 3_000);

    const reflection = ruleReflection(store.memories.unconsolidated(MIRA, 'episodic'));
    assert.ok(reflection !== null);
    assert.ok(reflection.confidence < 1, 'mixed evidence should not be held with certainty');
    assert.ok(Math.abs(reflection.confidence - 2 / 3) < 1e-9);
    store.close();
  });

  it('refuses to invent a belief out of unrelated episodes', () => {
    // Three things happening once each is not a pattern, and pretending
    // otherwise would fill an agent's head with confident nonsense.
    const unrelated = [
      entry({ id: 'mem_000001' as MemoryEntry['id'], tags: ['river'] }),
      entry({ id: 'mem_000002' as MemoryEntry['id'], tags: ['ridge'] }),
      entry({ id: 'mem_000003' as MemoryEntry['id'], tags: ['cave'] }),
    ];
    assert.equal(ruleReflection(unrelated), null);
    assert.equal(ruleReflection([entry()]), null, 'one episode is an anecdote');
    assert.equal(ruleReflection([]), null);
  });

  it('never makes an outcome tag the subject of a belief', () => {
    // Every memory here shares the failure tag, which would otherwise be the
    // most common handle and produce a belief about failure in the abstract.
    const store = freshStore();
    const reflection = ruleReflection(barrenRidge(store));
    assert.ok(reflection !== null);
    assert.notEqual(reflection.subject, FAILURE_TAG);
    assert.ok(!reflection.tags.includes(FAILURE_TAG));
    store.close();
  });

  it('produces something the reflection schema accepts', () => {
    // The fallback and the model answer the same shape, or the fallback could
    // not stand in for the model (ADR-0006).
    const store = freshStore();
    const reflection = ruleReflection(barrenRidge(store));
    assert.equal(ReflectionSchema.safeParse(reflection).success, true);
    store.close();
  });

  it('picks the same subject however the episodes are ordered', () => {
    const store = freshStore();
    const episodes = barrenRidge(store);
    const forwards = ruleReflection(episodes)?.subject;
    const backwards = ruleReflection([...episodes].reverse())?.subject;
    assert.equal(forwards, backwards);
    store.close();
  });
});

describe('reflecting', () => {
  it('waits for enough undigested experience before it is worth the call', () => {
    const store = freshStore();
    remember(store, { type: 'episodic', content: 'one', importance: 0.4 }, 1_000);
    assert.equal(shouldReflect(store, MIRA, 3), false);
    remember(store, { type: 'episodic', content: 'two', importance: 0.4 }, 2_000);
    remember(store, { type: 'episodic', content: 'three', importance: 0.4 }, 3_000);
    assert.equal(shouldReflect(store, MIRA, 3), true);
    store.close();
  });

  it('stores the belief as a semantic memory inferred from the episodes behind it', async () => {
    const store = freshStore();
    const episodes = barrenRidge(store);

    const outcome = expect(
      await reflect({
        store,
        reasoning: new HeuristicProvider(),
        agent: { id: MIRA, name: 'Mira' },
        time: time(10_000),
      }),
      'reflect',
    );

    assert.ok(outcome.belief !== null);
    assert.equal(outcome.belief.type, 'semantic');
    assert.equal(outcome.source, 'heuristic');
    // "How does Mira know that?" — from exactly these episodes (ADR-0007).
    assert.deepEqual(outcome.belief.source, {
      kind: 'inferred',
      from: episodes.map((memory) => memory.id),
    });
    assert.deepEqual(outcome.from, episodes.map((memory) => memory.id));
    store.close();
  });

  it('keeps the episodes it generalised from, pointing at the belief', async () => {
    const store = freshStore();
    const episodes = barrenRidge(store);
    const outcome = expect(
      await reflect({
        store,
        reasoning: new HeuristicProvider(),
        agent: { id: MIRA, name: 'Mira' },
        time: time(10_000),
      }),
      'reflect',
    );

    for (const episode of episodes) {
      const stored = store.memories.find(MIRA, episode.id);
      assert.ok(stored !== null, 'evidence must not be deleted');
      assert.equal(stored.consolidatedInto, outcome.belief?.id);
    }
    // And it is still retrievable, just below the belief (requirement 12).
    const retrieved = retrieve(store, MIRA, { tags: ['northern ridge'] }, { atTicks: 10_000 });
    assert.equal(retrieved.length, 4);
    assert.equal(retrieved[0]?.memory.id, outcome.belief?.id);
    store.close();
  });

  it('writes an event, so a belief is part of the world\'s history', async () => {
    const store = freshStore();
    barrenRidge(store);
    await reflect({
      store,
      reasoning: new HeuristicProvider(),
      agent: { id: MIRA, name: 'Mira' },
      time: time(10_000),
    });

    const events = store.events.query({ types: ['agent_reflected'] });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]?.payload, {
      agentId: MIRA,
      belief: 'northern ridge has gone badly for me: 3 of 3 attempts came to nothing.',
      fromMemories: 3,
    });
    store.close();
  });

  it('does nothing at all when there is nothing to generalise', async () => {
    const store = freshStore();
    remember(store, { type: 'episodic', content: 'I walked south.', importance: 0.2 }, 1_000);

    const outcome = expect(
      await reflect({
        store,
        reasoning: new HeuristicProvider(),
        agent: { id: MIRA, name: 'Mira' },
        time: time(10_000),
      }),
      'reflect',
    );

    assert.equal(outcome.belief, null);
    assert.equal(outcome.source, null, 'no model should be consulted with nothing to say');
    assert.match(outcome.note, /not enough recent experience/);
    assert.equal(store.memories.count(MIRA), 1);
    assert.equal(store.events.query({ types: ['agent_reflected'] }).length, 0);
    store.close();
  });

  it('cannot draw the same belief from the same episodes twice', async () => {
    const store = freshStore();
    barrenRidge(store);
    const deps = {
      store,
      reasoning: new HeuristicProvider(),
      agent: { id: MIRA, name: 'Mira' },
      time: time(10_000),
    };

    assert.ok(expect(await reflect(deps), 'first').belief !== null);
    // The evidence is spent: it now belongs to the belief that was drawn from it.
    const second = expect(await reflect(deps), 'second');
    assert.equal(second.belief, null);
    assert.equal(store.memories.byType(MIRA, 'semantic').length, 1);
    store.close();
  });

  it('generalises only over episodes, not over beliefs it already holds', async () => {
    const store = freshStore();
    barrenRidge(store);
    remember(store, { type: 'semantic', content: 'Water is south.', importance: 0.9, tags: ['water'] }, 500);

    const outcome = expect(
      await reflect({
        store,
        reasoning: new HeuristicProvider(),
        agent: { id: MIRA, name: 'Mira' },
        time: time(10_000),
      }),
      'reflect',
    );
    assert.match(outcome.belief?.content ?? '', /northern ridge/);
    store.close();
  });

  it('recounts the episodes to the model in the order they happened', () => {
    const store = freshStore();
    const episodes = barrenRidge(store);
    const prompt = reflectionPrompt('Mira', episodes);
    const first = prompt.indexOf(episodes[0]!.content);
    const last = prompt.indexOf(episodes[2]!.content);
    assert.ok(first > 0 && last > first, 'a run of events should read forwards');
    assert.match(prompt, /You are Mira/);
    store.close();
  });
});
