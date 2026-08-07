/**
 * Retrieval tests.
 *
 * The behaviour under test is selectivity: given a decision, the memories that
 * come back must be the ones about *that*, not merely the newest or the loudest.
 * A retrieval that ignored the query would pass a naive "returns some memories"
 * test and quietly make memory decorative, so most of what follows compares a
 * relevant memory against a fresher and more important irrelevant one.
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
import { position } from '../../src/core/world.ts';
import {
  DEFAULT_WEIGHTS,
  explainRetrieval,
  placeTag,
  recencyScore,
  relevanceScore,
  retrieve,
  retrievedContents,
  retrievedIds,
  scoreMemories,
  usageScore,
} from '../../src/memory/retrieval.ts';
import { OBSERVED, type MemoryEntry, type NewMemory } from '../../src/memory/types.ts';
import { Store } from '../../src/persistence/store.ts';

function freshStore(): Store {
  const store = Store.openMemory(sequentialIdFactory());
  store.simulation.initialise('memory-test', 1, 1_700_000_000_000);
  return store;
}

const MIRA = 'agent_000001' as AgentId;
const ELIAS = 'agent_000002' as AgentId;

function makeAgent(id: AgentId, name: string): Agent {
  return {
    id,
    name,
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

/** A store with Mira and Elias in it, so knowledge-boundary checks are possible. */
function storeWithAgents(): Store {
  const store = freshStore();
  store.agents.insert(makeAgent(MIRA, 'Mira'));
  store.agents.insert(makeAgent(ELIAS, 'Elias'));
  return store;
}

function remember(
  store: Store,
  memory: Omit<NewMemory, 'agentId' | 'source'> & { agentId?: AgentId },
  atTicks: number,
): MemoryEntry {
  return store.memories.insert(
    { agentId: memory.agentId ?? MIRA, source: OBSERVED, ...memory },
    { day: Math.floor(atTicks / 24_000), worldTicks: atTicks },
  );
}

/** A bare memory, for scoring functions that need no database. */
function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'mem_000999' as MemoryEntry['id'],
    agentId: MIRA,
    type: 'episodic',
    content: 'Something happened.',
    importance: 0.5,
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

describe('retrieval scoring terms', () => {
  it('treats a memory as less fresh the more world ticks have passed', () => {
    const memory = entry({ createdAtTicks: 0, lastAccessedAtTicks: 0 });
    assert.equal(recencyScore(memory, 0), 1);
    // One world day is the half-life.
    assert.ok(Math.abs(recencyScore(memory, 24_000) - 0.5) < 1e-9);
    assert.ok(recencyScore(memory, 96_000) < 0.1);
  });

  it('counts a memory as fresh again once it has been brought to mind', () => {
    const old = entry({ createdAtTicks: 0, lastAccessedAtTicks: 0 });
    const revisited = entry({ createdAtTicks: 0, lastAccessedAtTicks: 90_000 });
    assert.ok(recencyScore(revisited, 96_000) > recencyScore(old, 96_000));
  });

  it('rewards a memory that has proved useful, with diminishing returns', () => {
    assert.equal(usageScore(entry({ accessCount: 0 })), 0);
    assert.ok(usageScore(entry({ accessCount: 3 })) > usageScore(entry({ accessCount: 1 })));
    assert.ok(usageScore(entry({ accessCount: 40 })) < 1);
    // The gap between never-used and twice-used matters more than the gap
    // between twenty and forty times.
    const early = usageScore(entry({ accessCount: 2 })) - usageScore(entry({ accessCount: 0 }));
    const late = usageScore(entry({ accessCount: 40 })) - usageScore(entry({ accessCount: 38 }));
    assert.ok(early > late);
  });

  it('scores relevance from tags, entities and free text', () => {
    const memory = entry({
      content: 'The iron seam under the northern ridge was already emptied.',
      tags: ['iron', 'northern ridge'],
      relatedEntities: ['goal_000004'],
    });

    assert.equal(relevanceScore(memory, { tags: ['iron', 'northern ridge'] }), 1);
    assert.equal(relevanceScore(memory, { entities: ['goal_000004'] }), 1);
    assert.ok(relevanceScore(memory, { text: 'where can I mine iron' }) > 0);
    assert.equal(relevanceScore(memory, { tags: ['fishing'] }), 0);
  });

  it('scores a half-matching tag list at half relevance', () => {
    const memory = entry({ tags: ['iron'] });
    assert.equal(relevanceScore(memory, { tags: ['iron', 'northern ridge'] }), 0.5);
  });

  it('is relevance-blind when the query says nothing', () => {
    // An empty query is legitimate — "what is on your mind at all?" — and must
    // rank on the other three terms rather than dividing by zero.
    const memory = entry({ tags: ['iron'] });
    assert.equal(relevanceScore(memory, {}), 0);
    assert.equal(relevanceScore(memory, { tags: [], entities: [], text: '  ' }), 0);
  });
});

describe('ranking', () => {
  it('prefers a relevant old memory over an irrelevant fresh and important one', () => {
    const relevant = entry({
      id: 'mem_000001' as MemoryEntry['id'],
      content: 'I found no iron on the northern ridge.',
      tags: ['iron', 'northern ridge'],
      importance: 0.3,
      createdAtTicks: 1_000,
      lastAccessedAtTicks: 1_000,
    });
    const loud = entry({
      id: 'mem_000002' as MemoryEntry['id'],
      content: 'I gathered a great deal of timber by the river.',
      tags: ['wood'],
      importance: 0.9,
      createdAtTicks: 20_000,
      lastAccessedAtTicks: 20_000,
    });

    const ranked = scoreMemories([loud, relevant], { tags: ['iron', 'northern ridge'] }, {
      atTicks: 20_000,
    });
    assert.deepEqual(ranked.map((scored) => scored.memory.id), ['mem_000001', 'mem_000002']);
  });

  it('honours the retrieval limit, which is what keeps prompts small', () => {
    const memories = Array.from({ length: 30 }, (_, index) =>
      entry({ id: `mem_${String(index).padStart(6, '0')}` as MemoryEntry['id'] }),
    );
    assert.equal(scoreMemories(memories, {}, { atTicks: 1_000 }).length, 10);
    assert.equal(scoreMemories(memories, {}, { atTicks: 1_000, limit: 3 }).length, 3);
  });

  it('drops memories not worth a prompt slot', () => {
    const faint = entry({ importance: 0.01, createdAtTicks: 0, lastAccessedAtTicks: 0 });
    assert.equal(scoreMemories([faint], {}, { atTicks: 500_000, minScore: 0.1 }).length, 0);
    assert.equal(scoreMemories([faint], {}, { atTicks: 500_000 }).length, 1);
  });

  it('orders identical scores the same way every time', () => {
    // Irreproducible agent behaviour for no benefit is the failure mode here.
    const twins = [
      entry({ id: 'mem_000002' as MemoryEntry['id'] }),
      entry({ id: 'mem_000001' as MemoryEntry['id'] }),
    ];
    const first = scoreMemories(twins, {}, { atTicks: 5_000 }).map((s) => s.memory.id);
    const second = scoreMemories([...twins].reverse(), {}, { atTicks: 5_000 }).map((s) => s.memory.id);
    assert.deepEqual(first, second);
    assert.deepEqual(first, ['mem_000001', 'mem_000002']);
  });

  it('lets the caller re-weight the terms', () => {
    const useful = entry({ id: 'mem_000001' as MemoryEntry['id'], accessCount: 10 });
    const unused = entry({ id: 'mem_000002' as MemoryEntry['id'], accessCount: 0 });
    const onUsage = scoreMemories([unused, useful], {}, {
      atTicks: 1_000,
      weights: { recency: 0, importance: 0, relevance: 0, usage: 1 },
    });
    assert.equal(onUsage[0]?.memory.id, 'mem_000001');
    assert.equal(onUsage[0]?.score, usageScore(useful));
  });

  it('reports every term, so a surprising retrieval can be explained', () => {
    const memory = entry({ tags: ['iron'], importance: 0.4, accessCount: 2 });
    const [scored] = scoreMemories([memory], { tags: ['iron'] }, { atTicks: 1_000 });
    assert.ok(scored !== undefined);
    assert.equal(scored.components.relevance, 1);
    assert.equal(scored.components.importance, 0.4);
    assert.equal(scored.components.recency, 1);
    assert.ok(scored.components.usage > 0);
    // The weighted mean of the components, by definition.
    const expected =
      (1 * DEFAULT_WEIGHTS.relevance +
        0.4 * DEFAULT_WEIGHTS.importance +
        1 * DEFAULT_WEIGHTS.recency +
        scored.components.usage * DEFAULT_WEIGHTS.usage) /
      (DEFAULT_WEIGHTS.relevance +
        DEFAULT_WEIGHTS.importance +
        DEFAULT_WEIGHTS.recency +
        DEFAULT_WEIGHTS.usage);
    assert.ok(Math.abs(scored.score - expected) < 1e-9);
    assert.match(explainRetrieval(scored), /relevance 100%/);
  });
});

describe('consolidated memories', () => {
  it('keeps the evidence behind a belief retrievable, below the belief itself', () => {
    const store = storeWithAgents();
    const evidence = remember(
      store,
      { type: 'episodic', content: 'The ridge gave me nothing.', importance: 0.6, tags: ['ridge'] },
      1_000,
    );
    const belief = remember(
      store,
      { type: 'semantic', content: 'The ridge is barren.', importance: 0.6, tags: ['ridge'] },
      1_000,
    );
    store.memories.markConsolidated(MIRA, [evidence.id], belief.id);

    const retrieved = retrieve(store, MIRA, { tags: ['ridge'] }, { atTicks: 1_000 });
    // Requirement 12: the belief leads, but its evidence is still reachable.
    assert.deepEqual(retrieved.map((scored) => scored.memory.id), [belief.id, evidence.id]);
    assert.equal(retrieved[1]?.consolidated, true);
    assert.ok((retrieved[1]?.score ?? 0) > 0, 'evidence must not be scored away entirely');
    store.close();
  });

  it('can be told exactly how far to deprioritise superseded evidence', () => {
    const store = storeWithAgents();
    const evidence = remember(store, { type: 'episodic', content: 'raw', importance: 0.6 }, 1_000);
    const belief = remember(store, { type: 'semantic', content: 'belief', importance: 0.6 }, 1_000);
    store.memories.markConsolidated(MIRA, [evidence.id], belief.id);

    const retrieved = retrieve(store, MIRA, {}, { atTicks: 1_000, consolidatedWeight: 0.25 });
    const raw = retrieved.find((scored) => scored.memory.id === evidence.id);
    const top = retrieved.find((scored) => scored.memory.id === belief.id);
    assert.ok(raw !== undefined && top !== undefined);
    assert.ok(Math.abs(raw.score - top.score * 0.25) < 1e-9);
    store.close();
  });
});

describe('retrieve against the store', () => {
  it('cannot see another agent\'s memories', () => {
    const store = storeWithAgents();
    remember(store, { type: 'episodic', content: 'I hid the food.', importance: 0.9 }, 1_000);
    remember(
      store,
      { agentId: ELIAS, type: 'episodic', content: 'I am hungry.', importance: 0.9 },
      1_000,
    );

    // The agentId argument is the knowledge boundary (ADR-0007).
    const eliasSees = retrieve(store, ELIAS, { text: 'food' }, { atTicks: 1_000 });
    assert.deepEqual(retrievedContents(eliasSees), ['I am hungry.']);
    store.close();
  });

  it('records that the memories it returned were used', () => {
    const store = storeWithAgents();
    const memory = remember(store, { type: 'episodic', content: 'useful', importance: 0.5 }, 1_000);

    retrieve(store, MIRA, {}, { atTicks: 5_000 });
    const afterOnce = store.memories.find(MIRA, memory.id);
    assert.equal(afterOnce?.accessCount, 1);
    assert.equal(afterOnce?.lastAccessedAtTicks, 5_000);

    retrieve(store, MIRA, {}, { atTicks: 6_000 });
    assert.equal(store.memories.find(MIRA, memory.id)?.accessCount, 2);
    store.close();
  });

  it('can look without touching, so inspecting an agent does not change it', () => {
    const store = storeWithAgents();
    const memory = remember(store, { type: 'episodic', content: 'useful', importance: 0.5 }, 1_000);
    retrieve(store, MIRA, {}, { atTicks: 5_000, markAccessed: false });
    assert.equal(store.memories.find(MIRA, memory.id)?.accessCount, 0);
    store.close();
  });

  it('narrows to the types the caller asked for', () => {
    const store = storeWithAgents();
    remember(store, { type: 'episodic', content: 'an episode', importance: 0.5 }, 1_000);
    remember(store, { type: 'semantic', content: 'a belief', importance: 0.5 }, 1_000);

    const beliefs = retrieve(store, MIRA, {}, { atTicks: 1_000, types: ['semantic'] });
    assert.deepEqual(retrievedContents(beliefs), ['a belief']);
    store.close();
  });

  it('hands back ids for the decision row and contents for the prompt', () => {
    const store = storeWithAgents();
    const memory = remember(store, { type: 'episodic', content: 'a thing', importance: 0.5 }, 1_000);
    const retrieved = retrieve(store, MIRA, {}, { atTicks: 1_000 });
    assert.deepEqual(retrievedIds(retrieved), [memory.id]);
    assert.deepEqual(retrievedContents(retrieved), ['a thing']);
    store.close();
  });

  it('returns nothing, rather than failing, for an agent with no memories', () => {
    const store = storeWithAgents();
    assert.deepEqual(retrieve(store, MIRA, { text: 'anything' }, { atTicks: 1_000 }), []);
    store.close();
  });
});

describe('place tags', () => {
  it('gives nearby positions the same handle, so "here" survives a few steps', () => {
    // A cell, not a radius: two positions in the same cell agree, and elevation
    // is ignored because a deposit two blocks lower is the same site.
    assert.equal(placeTag(position(100, 64, -50)), placeTag(position(103, 70, -52)));
    assert.notEqual(placeTag(position(100, 64, -50)), placeTag(position(400, 64, -50)));
  });

  it('is stable across the negative axis, where flooring is easy to get wrong', () => {
    assert.equal(placeTag(position(-1, 64, -1)), placeTag(position(-16, 64, -16)));
    assert.notEqual(placeTag(position(-1, 64, -1)), placeTag(position(0, 64, 0)));
  });

  it('takes a coarser cell when a caller wants a whole region to count as one place', () => {
    assert.equal(placeTag(position(0, 64, 0), 128), placeTag(position(120, 64, 120), 128));
  });
});
