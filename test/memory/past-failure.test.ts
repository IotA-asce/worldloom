/**
 * The M2 criterion: a past memory measurably changes a later decision.
 *
 * Everything else in `src/memory/` could work and this could still fail, which
 * is why it gets its own file. Memory is only real if it is *load-bearing*: the
 * lines that reach a decision have to differ because of what happened earlier,
 * and they have to differ *selectively* — the same agent considering a different
 * question must not be handed the same warning.
 *
 * So each test here carries a control: a second query, or a second agent with no
 * such history. Without one, "the retrieval returned something" proves nothing.
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
import { position, type Position, type WorldTime } from '../../src/core/world.ts';
import { describeSituation, type PlanningContext } from '../../src/goals/planner.ts';
import { consolidate } from '../../src/memory/consolidation.ts';
import { FAILURE_TAG, reflect, SUCCESS_TAG } from '../../src/memory/reflection.ts';
import {
  placeTag,
  retrieve,
  retrievedContents,
  retrievedIds,
} from '../../src/memory/retrieval.ts';
import { OBSERVED, type MemoryEntry, type NewMemory } from '../../src/memory/types.ts';
import { Store } from '../../src/persistence/store.ts';
import { HeuristicProvider } from '../../src/reasoning/heuristic.ts';

const MIRA = 'agent_000001' as AgentId;
/** No history at the ridge. The control for every "memory changed it" claim. */
const ELIAS = 'agent_000002' as AgentId;

/** Where Mira wasted a day looking for iron. */
const RIDGE: Position = position(142, 68, -91);
/** Where the timber actually was. */
const RIVER: Position = position(-40, 63, 12);

function makeAgent(id: AgentId, name: string, at: Position): Agent {
  return {
    id,
    name,
    role: 'Settler',
    personality: NEUTRAL_PERSONALITY,
    skills: NO_SKILLS,
    needs: STARTING_NEEDS,
    position: at,
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
  store.agents.insert(makeAgent(MIRA, 'Mira', RIDGE));
  store.agents.insert(makeAgent(ELIAS, 'Elias', RIDGE));
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
  agentId: AgentId,
  memory: Omit<NewMemory, 'agentId' | 'source'>,
  atTicks: number,
): MemoryEntry {
  return store.memories.insert(
    { agentId, source: OBSERVED, ...memory },
    { day: Math.floor(atTicks / 24_000), worldTicks: atTicks },
  );
}

/**
 * Day 0: Mira digs at the ridge three times and finds nothing.
 * Day 1: she has a good, busy, memorable day somewhere else entirely.
 *
 * The second half is the trap. Those memories are newer and more important than
 * the failures, so a retrieval that merely returned "the best memories" would
 * bury the lesson under them.
 */
function aWastedDayAndAGoodOne(store: Store): MemoryEntry[] {
  const failures = [
    'I dug at the northern ridge and found no iron at all.',
    'The northern ridge gave me nothing a second time.',
    'A third dig at the northern ridge and still no iron.',
  ].map((content, index) =>
    remember(
      store,
      MIRA,
      {
        type: 'episodic',
        content,
        importance: 0.35,
        // The place leads, because that is what these episodes were about.
        tags: ['northern ridge', 'iron', placeTag(RIDGE), FAILURE_TAG],
      },
      2_000 + index * 2_000,
    ),
  );

  for (let index = 0; index < 8; index++) {
    remember(
      store,
      MIRA,
      {
        type: 'episodic',
        content: `I gathered a great deal of timber by the river. (${index + 1})`,
        importance: 0.8,
        tags: ['wood', 'river', placeTag(RIVER), SUCCESS_TAG],
      },
      26_000 + index * 400,
    );
  }

  return failures;
}

/** The question Mira faces on day 2, standing at the ridge again. */
const CONSIDERING_THE_RIDGE = {
  tags: ['iron', placeTag(RIDGE)],
  text: 'should I dig for iron here',
};

/** The control: a different decision, the same agent, the same store. */
const CONSIDERING_THE_RIVER = {
  tags: ['wood', placeTag(RIVER)],
  text: 'should I gather timber by the river',
};

/** Enough of a context for `describeSituation`; only `memories` varies. */
function context(agent: Agent, memories: readonly string[]): PlanningContext {
  return {
    agent,
    time: time(50_000),
    knownResources: [],
    knownShelter: null,
    settlementCenter: null,
    carrying: {},
    memories,
    claimedWork: [],
    existingStructures: [],
    work: null,
    sheltered: false,
    hostilesNearby: 0,
  };
}

describe('a past failure reaches the decision that repeats it', () => {
  it('brings back the failures at this place, ahead of newer and louder memories', () => {
    const store = freshStore();
    const failures = aWastedDayAndAGoodOne(store);

    const retrieved = retrieve(store, MIRA, CONSIDERING_THE_RIDGE, { atTicks: 50_000, limit: 5 });
    const ids = retrievedIds(retrieved);

    assert.equal(ids[0], failures[2]?.id, 'the most recent failure at this place should lead');
    for (const failure of failures) {
      assert.ok(ids.includes(failure.id), `the lesson from ${failure.id} should be on the table`);
    }
    store.close();
  });

  it('does not bring them back when she is thinking about something else', () => {
    // The control. Without this, the test above is satisfied by any retrieval
    // that returns the agent's memories at all.
    const store = freshStore();
    const failures = aWastedDayAndAGoodOne(store);

    const ids = retrievedIds(
      retrieve(store, MIRA, CONSIDERING_THE_RIVER, { atTicks: 50_000, limit: 5 }),
    );
    for (const failure of failures) {
      assert.ok(!ids.includes(failure.id), 'a wasted dig has no bearing on gathering timber');
    }
    store.close();
  });

  it('changes the situation the agent is asked to decide on', () => {
    const store = freshStore();
    aWastedDayAndAGoodOne(store);
    const mira = store.agents.get(MIRA);
    const elias = store.agents.get(ELIAS);

    const hers = describeSituation(
      context(mira, retrievedContents(retrieve(store, MIRA, CONSIDERING_THE_RIDGE, { atTicks: 50_000, limit: 3 }))),
    );
    const his = describeSituation(
      context(elias, retrievedContents(retrieve(store, ELIAS, CONSIDERING_THE_RIDGE, { atTicks: 50_000, limit: 3 }))),
    );

    // Same place, same question, same tick — and the two settlers are deciding
    // on different information, because only one of them has been here before.
    assert.match(hers, /found no iron/);
    assert.doesNotMatch(his, /found no iron/);
    assert.doesNotMatch(his, /You remember/);
    store.close();
  });

  it('proves it was used, on the decision row', () => {
    const store = freshStore();
    const failures = aWastedDayAndAGoodOne(store);

    const retrieved = retrieve(store, MIRA, CONSIDERING_THE_RIDGE, { atTicks: 50_000, limit: 3 });
    const decision = store.decisions.record({
      agentId: MIRA,
      category: 'goal_selection',
      worldTicks: 50_000,
      day: 2,
      observation: { position: RIDGE },
      memoryIds: retrievedIds(retrieved),
      prompt: describeSituation(context(store.agents.get(MIRA), retrievedContents(retrieved))),
      response: null,
      model: 'heuristic',
      chosenAction: 'gather_resource: look for iron somewhere other than the ridge',
      eventId: null,
      llmCallId: null,
    });

    // ADR-0008: "which memories did she retrieve?" is a query, not archaeology.
    const stored = store.decisions.find(decision.id);
    assert.ok(stored !== null);
    assert.ok(stored.memoryIds.includes(failures[2]!.id));
    assert.match(stored.prompt ?? '', /found no iron/);
    store.close();
  });

  it('counts the retrieval, so a lesson that keeps helping stays reachable', () => {
    const store = freshStore();
    const failures = aWastedDayAndAGoodOne(store);
    const before = store.memories.find(MIRA, failures[2]!.id)?.accessCount ?? -1;

    retrieve(store, MIRA, CONSIDERING_THE_RIDGE, { atTicks: 50_000, limit: 3 });

    const after = store.memories.find(MIRA, failures[2]!.id);
    assert.equal(before, 0);
    assert.equal(after?.accessCount, 1);
    assert.equal(after?.lastAccessedAtTicks, 50_000);
    store.close();
  });
});

describe('the lesson outlives the episodes that taught it', () => {
  it('still warns her about the place after every episode behind it is gone', async () => {
    const store = freshStore();
    const failures = aWastedDayAndAGoodOne(store);

    // Day 2: she looks back. Her most repeated experience is the good day by the
    // river, so that is what the first reflection digests; the wasted day at the
    // ridge is what remains for the second.
    const deps = {
      store,
      reasoning: new HeuristicProvider(),
      agent: { id: MIRA, name: 'Mira' },
      time: time(50_000),
    };
    const aboutTheRiver = expect(await reflect(deps), 'first reflection');
    assert.match(aboutTheRiver.belief?.content ?? '', /wood has been reliable/);

    const reflection = expect(await reflect(deps), 'second reflection');
    assert.ok(reflection.belief !== null);
    assert.match(reflection.belief.content, /northern ridge has gone badly/);

    // Days pass. The episodes fade, are superseded, and are eventually dropped.
    const housekeeping = { threshold: 4, retainTicks: 24_000, decayFactor: 0.1 };
    for (const at of [100_000, 200_000, 300_000]) {
      await consolidate({
        store,
        reasoning: new HeuristicProvider(),
        agent: { id: MIRA, name: 'Mira' },
        time: time(at),
        options: housekeeping,
      });
    }

    for (const failure of failures) {
      assert.equal(store.memories.find(MIRA, failure.id), null, 'the episodes are forgotten');
    }

    // And she is still warned, because the belief was the point of forming one.
    const retrieved = retrieve(store, MIRA, CONSIDERING_THE_RIDGE, { atTicks: 300_000, limit: 3 });
    assert.equal(retrievedIds(retrieved)[0], reflection.belief.id);
    assert.match(retrievedContents(retrieved)[0] ?? '', /northern ridge has gone badly/);

    // The control again: Elias, who never dug here, is told nothing.
    assert.deepEqual(retrieve(store, ELIAS, CONSIDERING_THE_RIDGE, { atTicks: 300_000 }), []);
    store.close();
  });
});
