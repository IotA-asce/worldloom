/**
 * Consolidation tests.
 *
 * Forgetting is the dangerous half of memory: a bug here does not crash, it
 * quietly deletes the reason an agent behaves as it does. So most of these tests
 * are about what consolidation must *not* do — lose the evidence behind a
 * belief, drop a memory that proved useful, or erase a lesson along with the
 * episodes that taught it.
 *
 * Everything runs on `HeuristicProvider`, so the summaries under test are the
 * deterministic ones ADR-0006 requires every call site to be able to fall back
 * on.
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
  consolidate,
  DEFAULT_CONSOLIDATION,
  ruleSummary,
  shouldConsolidate,
  summaryPrompt,
  SummarySchema,
  type ConsolidationOptions,
} from '../../src/memory/consolidation.ts';
import { FAILURE_TAG, SUCCESS_TAG } from '../../src/memory/reflection.ts';
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

/** Deliberately small thresholds, so a test does not need two hundred rows to
 *  reach the behaviour it is about. */
const EAGER: ConsolidationOptions = {
  threshold: 4,
  minGroupSize: 3,
  mergeBelowImportance: 0.4,
};

async function run(store: Store, atTicks: number, options: ConsolidationOptions = EAGER) {
  return expect(
    await consolidate({
      store,
      reasoning: new HeuristicProvider(),
      agent: { id: MIRA, name: 'Mira' },
      time: time(atTicks),
      options,
    }),
    'consolidate',
  );
}

/** A run of near-identical low-value episodes — what merging is for. */
function walkedNorth(store: Store, count: number, importance = 0.2): MemoryEntry[] {
  return Array.from({ length: count }, (_, index) =>
    remember(
      store,
      {
        type: 'episodic',
        content: `I walked north and saw nothing new. (${index + 1})`,
        importance,
        tags: ['travel', 'north'],
      },
      1_000 + index * 500,
    ),
  );
}

describe('the deterministic summary', () => {
  it('states what is quantitatively true about the cluster', () => {
    const store = freshStore();
    const episodes = [
      remember(store, { type: 'episodic', content: 'a', importance: 0.2, tags: ['travel', SUCCESS_TAG] }, 1_000),
      remember(store, { type: 'episodic', content: 'b', importance: 0.3, tags: ['travel', FAILURE_TAG] }, 25_000),
      remember(store, { type: 'episodic', content: 'c', importance: 0.1, tags: ['travel', FAILURE_TAG] }, 26_000),
    ];

    const summary = ruleSummary('travel', episodes);
    assert.match(summary.summary, /3 times between day 0 and day 1/);
    assert.match(summary.summary, /1 went well and 2 badly/);
    // Merging must not lose signal: the summary is as memorable as its most
    // memorable member.
    assert.equal(summary.importance, 0.3);
    assert.deepEqual(summary.tags, ['travel']);
    assert.equal(SummarySchema.safeParse(summary).success, true);
    store.close();
  });

  it('reads naturally when everything happened on one day', () => {
    const store = freshStore();
    const episodes = walkedNorth(store, 3);
    assert.match(ruleSummary('travel', episodes).summary, /3 times on day 0/);
    store.close();
  });

  it('bounds the prompt however large the cluster is', () => {
    const store = freshStore();
    const episodes = walkedNorth(store, 60);
    const prompt = summaryPrompt('Mira', 'travel', episodes);
    assert.equal(prompt.split('\n').length, 22, 'a heading, twenty episodes, and a tally');
    assert.match(prompt, /and 40 more like these/);
    store.close();
  });
});

describe('consolidation gating', () => {
  it('leaves a small memory alone entirely', async () => {
    const store = freshStore();
    walkedNorth(store, 3);
    const report = await run(store, 30_000, { threshold: 200 });

    assert.equal(report.ran, false);
    assert.equal(report.decayed, 0);
    assert.deepEqual(report.merged, []);
    // Nothing decayed, so nothing was touched at all.
    assert.equal(store.memories.recent(MIRA)[0]?.importance, 0.2);
    store.close();
  });

  it('reports the threshold it is watching, so callers need no gate of their own', () => {
    const store = freshStore();
    walkedNorth(store, 3);
    assert.equal(shouldConsolidate(store, MIRA, 4), false);
    walkedNorth(store, 1);
    assert.equal(shouldConsolidate(store, MIRA, 4), true);
    store.close();
  });

  it('defaults to leaving memory alone until there is a lot of it', () => {
    // Consolidation is lossy; the default must not be eager.
    assert.ok(DEFAULT_CONSOLIDATION.threshold >= 100);
    assert.ok(DEFAULT_CONSOLIDATION.retainTicks >= 24_000);
    assert.ok(DEFAULT_CONSOLIDATION.decayFloor < DEFAULT_CONSOLIDATION.forgetBelowImportance,
      'decay must be able to reach the forgetting threshold, or nothing is ever dropped');
  });
});

describe('merging', () => {
  it('replaces a cluster of near-identical episodes with one summary', async () => {
    const store = freshStore();
    const episodes = walkedNorth(store, 5);
    const report = await run(store, 30_000);

    assert.equal(report.ran, true);
    assert.equal(report.merged.length, 1);
    const [merged] = report.merged;
    assert.ok(merged !== undefined);
    assert.equal(merged.subject, 'travel');
    assert.deepEqual(merged.from, episodes.map((memory) => memory.id));
    assert.equal(merged.source, 'heuristic');
    assert.match(merged.summary.content, /5 times/);
    store.close();
  });

  it('keeps the merged episodes, pointing at the summary', async () => {
    const store = freshStore();
    const episodes = walkedNorth(store, 5);
    const report = await run(store, 30_000);
    const summaryId = report.merged[0]?.summary.id;

    for (const episode of episodes) {
      const stored = store.memories.find(MIRA, episode.id);
      assert.ok(stored !== null, 'a merged episode is superseded, not deleted');
      assert.equal(stored.consolidatedInto, summaryId);
    }
    store.close();
  });

  it('leaves the summary retrievable in place of what it replaced', async () => {
    const store = freshStore();
    walkedNorth(store, 5);
    const report = await run(store, 30_000);

    const retrieved = retrieve(store, MIRA, { tags: ['travel'] }, { atTicks: 30_000, limit: 3 });
    assert.equal(retrieved[0]?.memory.id, report.merged[0]?.summary.id);
    assert.equal(retrieved[0]?.consolidated, false);
    assert.ok(retrieved.slice(1).every((scored) => scored.consolidated));
    store.close();
  });

  it('will not merge away a memory that mattered', async () => {
    const store = freshStore();
    walkedNorth(store, 4);
    const notable = remember(
      store,
      {
        type: 'episodic',
        content: 'I walked north and was attacked.',
        importance: 0.9,
        tags: ['travel', 'north'],
      },
      5_000,
    );

    const report = await run(store, 30_000);
    assert.ok(!report.merged[0]?.from.includes(notable.id));
    assert.equal(store.memories.find(MIRA, notable.id)?.consolidatedInto, null);
    store.close();
  });

  it('never merges a belief, which is the thing worth keeping', async () => {
    const store = freshStore();
    walkedNorth(store, 4);
    const beliefs = ['travel', 'travel', 'travel'].map((tag, index) =>
      remember(store, { type: 'semantic', content: `belief ${index}`, importance: 0.1, tags: [tag] }, 6_000),
    );

    await run(store, 30_000);
    for (const belief of beliefs) {
      assert.equal(store.memories.find(MIRA, belief.id)?.consolidatedInto, null);
    }
    store.close();
  });

  it('leaves a cluster too small to be worth collapsing', async () => {
    const store = freshStore();
    walkedNorth(store, 2);
    remember(store, { type: 'episodic', content: 'x', importance: 0.2, tags: ['fishing'] }, 7_000);
    remember(store, { type: 'episodic', content: 'y', importance: 0.2, tags: ['fishing'] }, 7_500);

    const report = await run(store, 30_000);
    assert.deepEqual(report.merged, []);
    store.close();
  });

  it('ignores memories with no handle to cluster them by', async () => {
    const store = freshStore();
    for (let i = 0; i < 6; i++) {
      remember(store, { type: 'episodic', content: `untagged ${i}`, importance: 0.2 }, 1_000 + i * 100);
    }
    const report = await run(store, 30_000);
    // Guessing a subject out of prose would produce nonsense merges.
    assert.deepEqual(report.merged, []);
    store.close();
  });

  it('bounds how many clusters one pass will collapse', async () => {
    const store = freshStore();
    for (const subject of ['travel', 'fishing', 'digging', 'building']) {
      for (let i = 0; i < 3; i++) {
        remember(
          store,
          { type: 'episodic', content: `${subject} ${i}`, importance: 0.2, tags: [subject] },
          1_000 + i * 100,
        );
      }
    }
    const report = await run(store, 30_000, { ...EAGER, maxGroups: 2 });
    assert.equal(report.merged.length, 2, 'a pass must not fan out into unbounded model calls');
    store.close();
  });

  it('collapses the same clusters however the memories were written', async () => {
    const counts: number[] = [];
    for (const seedOrder of [1, -1]) {
      const store = freshStore();
      const subjects = seedOrder === 1 ? ['travel', 'fishing'] : ['fishing', 'travel'];
      for (const subject of subjects) {
        for (let i = 0; i < 3; i++) {
          remember(store, { type: 'episodic', content: `${subject} ${i}`, importance: 0.2, tags: [subject] }, 1_000 + i * 100);
        }
      }
      const report = await run(store, 30_000, { ...EAGER, maxGroups: 1 });
      counts.push(report.merged.length);
      assert.equal(report.merged[0]?.subject, 'fishing', 'ties break alphabetically, not by insertion order');
      store.close();
    }
    assert.deepEqual(counts, [1, 1]);
  });
});

describe('decay and forgetting', () => {
  it('fades episodes but leaves beliefs intact', async () => {
    const store = freshStore();
    const episode = remember(store, { type: 'episodic', content: 'an episode', importance: 0.8, tags: ['a'] }, 1_000);
    const belief = remember(store, { type: 'semantic', content: 'a belief', importance: 0.8, tags: ['a'] }, 1_000);
    walkedNorth(store, 3);

    await run(store, 30_000, { ...EAGER, decayFactor: 0.5 });

    assert.equal(store.memories.find(MIRA, episode.id)?.importance, 0.4);
    // A lesson must outlive the episodes that taught it, or forming it was
    // pointless.
    assert.equal(store.memories.find(MIRA, belief.id)?.importance, 0.8);
    store.close();
  });

  it('drops only faded, superseded, old, never-retrieved memories', async () => {
    const store = freshStore();
    const belief = remember(store, { type: 'semantic', content: 'the belief', importance: 0.9 }, 1_000);
    const faded = remember(store, { type: 'episodic', content: 'faded', importance: 0.01 }, 1_000);
    const useful = remember(store, { type: 'episodic', content: 'was useful', importance: 0.01 }, 1_000);
    const raw = remember(store, { type: 'episodic', content: 'still raw', importance: 0.01 }, 1_000);
    const recent = remember(store, { type: 'episodic', content: 'faded but recent', importance: 0.01 }, 100_000);

    store.memories.markConsolidated(MIRA, [faded.id, useful.id, recent.id], belief.id);
    store.memories.markAccessed(MIRA, [useful.id], 2_000);

    const report = await run(store, 120_000, { ...EAGER, retainTicks: 24_000 });

    assert.equal(report.forgotten, 1);
    assert.equal(store.memories.find(MIRA, faded.id), null);
    assert.ok(store.memories.find(MIRA, useful.id) !== null, 'a memory that helped once is kept');
    assert.ok(store.memories.find(MIRA, raw.id) !== null, 'nothing is dropped before it is superseded');
    assert.ok(store.memories.find(MIRA, recent.id) !== null, 'evidence is retained for a while regardless');
    assert.ok(store.memories.find(MIRA, belief.id) !== null);
    store.close();
  });

  it('does not forget what it merged in the same pass', async () => {
    const store = freshStore();
    // Faint enough to be forgettable the instant it is superseded, if the age
    // gate were not there.
    walkedNorth(store, 5, 0.02);
    const report = await run(store, 30_000, { ...EAGER, mergeBelowImportance: 0.4, retainTicks: 24_000 });

    assert.equal(report.merged.length, 1);
    assert.equal(report.forgotten, 0);
    assert.equal(report.countAfter, report.countBefore + 1);
    store.close();
  });

  it('shrinks a memory that has grown too large', async () => {
    const store = freshStore();
    // Old, faint, and about the same handful of things — the long-run shape.
    for (const subject of ['travel', 'fishing', 'digging']) {
      for (let i = 0; i < 8; i++) {
        remember(store, { type: 'episodic', content: `${subject} ${i}`, importance: 0.02, tags: [subject] }, 1_000 + i * 100);
      }
    }

    const first = await run(store, 200_000, { ...EAGER, retainTicks: 24_000 });
    assert.equal(first.merged.length, 3);
    assert.equal(first.forgotten, 0, 'the first pass only supersedes');

    const second = await run(store, 300_000, { ...EAGER, retainTicks: 24_000 });
    assert.equal(second.forgotten, 24, 'the superseded originals are dropped on a later pass');
    assert.equal(second.countAfter, 3, 'three summaries stand in for twenty-four episodes');
    store.close();
  });
});
