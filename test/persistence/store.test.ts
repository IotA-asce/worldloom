import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  NEUTRAL_PERSONALITY,
  NO_SKILLS,
  STARTING_NEEDS,
  type Agent,
} from '../../src/agents/agent.ts';
import { sequentialIdFactory, type AgentId, type GoalId, type PlanId } from '../../src/core/ids.ts';
import { position } from '../../src/core/world.ts';
import { makeStep, type Plan } from '../../src/goals/plan.ts';
import type { Goal } from '../../src/goals/goal.ts';
import { OBSERVED, toldBy } from '../../src/memory/types.ts';
import { MIGRATIONS, SCHEMA_VERSION, assertSchemaCompatible, migrate } from '../../src/persistence/migrations.ts';
import { openDatabase } from '../../src/persistence/db.ts';
import { agentOwner } from '../../src/persistence/repositories/ledger.ts';
import { Store } from '../../src/persistence/store.ts';

const CTX = { day: 1, worldTicks: 1000 };

function freshStore(): Store {
  const store = Store.openMemory(sequentialIdFactory());
  store.simulation.initialise('test-scenario', 1, 1_700_000_000_000);
  return store;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent_000001' as AgentId,
    name: 'Mira',
    role: 'Builder',
    personality: NEUTRAL_PERSONALITY,
    skills: { ...NO_SKILLS, building: 0.8 },
    needs: STARTING_NEEDS,
    position: position(100, 64, -50),
    health: 1,
    status: 'idle',
    phase: 'observe',
    currentGoalId: null,
    lastTickAt: 0,
    activity: '',
    spawnedAtDay: 0,
    ...overrides,
  };
}

function makeGoal(id: string, agentId: AgentId): Goal {
  return {
    id: id as GoalId,
    agentId,
    kind: 'gather_resource',
    params: { resource: 'wood', quantity: 48 },
    state: 'active',
    priority: 0.7,
    reason: 'the shelter needs timber',
    parentGoalId: null,
    createdAtDay: 1,
    createdAtTicks: 1000,
    resolvedAtTicks: null,
    outcome: null,
  };
}

describe('migrations', () => {
  it('applies every migration on a fresh database and is idempotent', () => {
    const db = openDatabase(':memory:');
    const applied = migrate(db);
    assert.deepEqual(applied, MIGRATIONS.map((m) => m.version));
    // A second call must be a no-op, since startup always calls it.
    assert.deepEqual(migrate(db), []);
    db.close();
  });

  it('refuses to open a database from a newer build', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      SCHEMA_VERSION + 5,
      'from-the-future',
      Date.now(),
    );
    // Downgrading would silently drop columns the old code cannot write.
    assert.throws(() => assertSchemaCompatible(db), /schema is version 6, but this build understands up to 1/);
    db.close();
  });

  it('accepts a database at exactly the current version', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    assert.doesNotThrow(() => assertSchemaCompatible(db));
    db.close();
  });
});

describe('transactions', () => {
  it('rolls back on throw', () => {
    const store = freshStore();
    store.agents.insert(makeAgent());
    assert.throws(() => {
      store.transaction(() => {
        store.ledger.credit(agentOwner('agent_000001' as AgentId), { wood: 10 });
        throw new Error('boom');
      });
    }, /boom/);
    assert.deepEqual(store.ledger.balance(agentOwner('agent_000001' as AgentId)), {});
    store.close();
  });

  it('supports nesting via savepoints', () => {
    const store = freshStore();
    store.agents.insert(makeAgent());
    const owner = agentOwner('agent_000001' as AgentId);

    store.transaction(() => {
      store.ledger.credit(owner, { wood: 5 });
      // An inner failure must not take the outer transaction down with it.
      try {
        store.transaction(() => {
          store.ledger.credit(owner, { stone: 99 });
          throw new Error('inner');
        });
      } catch {
        /* handled */
      }
      store.ledger.credit(owner, { wood: 5 });
    });

    assert.deepEqual(store.ledger.balance(owner), { wood: 10 });
    store.close();
  });
});

describe('agents', () => {
  it('round-trips every field', () => {
    const store = freshStore();
    const agent = makeAgent({ activity: 'surveying the ridge', status: 'exploring', health: 0.75 });
    store.agents.insert(agent);
    assert.deepEqual(store.agents.get(agent.id), agent);
    store.close();
  });

  it('finds by name case-insensitively, for CLI convenience', () => {
    const store = freshStore();
    store.agents.insert(makeAgent());
    assert.equal(store.agents.findByName('mira')?.name, 'Mira');
    assert.equal(store.agents.findByName('nobody'), null);
    store.close();
  });

  it('excludes the dead from the living roster', () => {
    const store = freshStore();
    store.agents.insert(makeAgent());
    store.agents.insert(
      makeAgent({ id: 'agent_000002' as AgentId, name: 'Elias', status: 'dead', health: 0 }),
    );
    assert.equal(store.agents.count(), 2);
    assert.deepEqual(store.agents.living().map((a) => a.name), ['Mira']);
    store.close();
  });

  it('refuses to update an agent that does not exist', () => {
    const store = freshStore();
    assert.throws(() => store.agents.update(makeAgent()), /unknown agent/);
    store.close();
  });
});

describe('event ledger', () => {
  it('assigns increasing sequence numbers', () => {
    const store = freshStore();
    store.agents.insert(makeAgent());
    const first = store.events.append(
      { type: 'agent_spawned', actorId: 'agent_000001' as AgentId, payload: { agentId: 'agent_000001' as AgentId, name: 'Mira', role: 'Builder', at: position(0, 64, 0) } },
      CTX,
    );
    const second = store.events.append(
      { type: 'day_began', actorId: null, payload: { day: 2 } },
      { day: 2, worldTicks: 25_000 },
    );
    assert.ok(second.seq > first.seq);
    assert.equal(store.events.latestSeq(), second.seq);
    assert.equal(store.events.latestDay(), 2);
    store.close();
  });

  it('applies the default importance for a type, and honours an override', () => {
    const store = freshStore();
    const routine = store.events.append({ type: 'agent_moved', actorId: null, payload: { agentId: 'agent_000001' as AgentId, from: position(0, 0, 0), to: position(1, 0, 0) } }, CTX);
    assert.equal(routine.importance, 0.1);

    const notable = store.events.append(
      { type: 'agent_moved', actorId: null, payload: { agentId: 'agent_000001' as AgentId, from: position(0, 0, 0), to: position(1, 0, 0) }, importance: 0.9 },
      CTX,
    );
    assert.equal(notable.importance, 0.9);
    store.close();
  });

  it('queries by day, type, actor and importance', () => {
    const store = freshStore();
    store.agents.insert(makeAgent());
    const actor = 'agent_000001' as AgentId;

    store.events.append({ type: 'resource_discovered', actorId: actor, payload: { agentId: actor, resource: 'iron', at: position(142, 68, -91), estimatedQuantity: 12 } }, { day: 3, worldTicks: 72_000 });
    store.events.append({ type: 'agent_moved', actorId: actor, payload: { agentId: actor, from: position(0, 0, 0), to: position(1, 0, 0) } }, { day: 3, worldTicks: 72_100 });
    store.events.append({ type: 'day_began', actorId: null, payload: { day: 4 } }, { day: 4, worldTicks: 96_000 });

    assert.equal(store.events.query({ day: 3 }).length, 2);
    assert.equal(store.events.query({ types: ['resource_discovered'] }).length, 1);
    assert.equal(store.events.query({ actorId: actor }).length, 2);
    assert.equal(store.events.query({ minImportance: 0.5 }).length, 1);
    assert.equal(store.events.query({ day: 3, minImportance: 0.5 }).length, 1);
    store.close();
  });

  it('returns events in sequence order, and recent() in reverse', () => {
    const store = freshStore();
    for (let day = 1; day <= 3; day++) {
      store.events.append({ type: 'day_began', actorId: null, payload: { day } }, { day, worldTicks: day * 24_000 });
    }
    const ascending = store.events.query();
    assert.deepEqual(ascending.map((e) => (e.payload as { day: number }).day), [1, 2, 3]);
    assert.deepEqual(store.events.recent(2).map((e) => (e.payload as { day: number }).day), [3, 2]);
    store.close();
  });

  it('preserves typed payloads through JSON', () => {
    const store = freshStore();
    store.agents.insert(makeAgent());
    const stored = store.events.append(
      {
        type: 'structure_completed',
        actorId: 'agent_000001' as AgentId,
        payload: {
          structureId: 'struct_000001' as never,
          type: 'shelter',
          region: { min: position(0, 64, 0), max: position(5, 68, 5) },
          builders: ['agent_000001' as AgentId],
          purpose: 'sleeping',
        },
      },
      CTX,
    );
    const read = store.events.find(stored.id);
    assert.deepEqual(read?.payload, stored.payload);
    store.close();
  });

  it('counts by type', () => {
    const store = freshStore();
    store.events.append({ type: 'day_began', actorId: null, payload: { day: 1 } }, CTX);
    store.events.append({ type: 'day_began', actorId: null, payload: { day: 2 } }, CTX);
    assert.equal(store.events.countsByType().get('day_began'), 2);
    store.close();
  });
});

describe('goals and plans', () => {
  it('round-trips a goal and its plan', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);
    const goal = makeGoal('goal_000001', agent.id);
    store.goals.insert(goal);

    const plan: Plan = {
      id: 'plan_000001' as PlanId,
      goalId: goal.id,
      agentId: agent.id,
      steps: [
        makeStep(0, 'locate_resource', { resource: 'wood', searchRadius: 48 }),
        makeStep(1, 'harvest_resource', { resource: 'wood', quantity: 48 }),
      ],
      currentStep: 0,
      state: 'active',
      createdAtTicks: 1000,
      revision: 0,
    };
    store.plans.insert(plan);

    assert.deepEqual(store.goals.get(goal.id), goal);
    assert.deepEqual(store.plans.activeForGoal(goal.id), plan);
    assert.deepEqual(store.plans.activeForAgent(agent.id), plan);
    store.close();
  });

  it('separates active, blocked and resolved goals', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);

    store.goals.insert(makeGoal('goal_000001', agent.id));
    store.goals.insert({ ...makeGoal('goal_000002', agent.id), state: 'blocked' });
    store.goals.insert({ ...makeGoal('goal_000003', agent.id), state: 'completed' });

    assert.deepEqual(store.goals.activeFor(agent.id).map((g) => g.id), ['goal_000001']);
    assert.deepEqual(store.goals.blockedFor(agent.id).map((g) => g.id), ['goal_000002']);
    assert.equal(store.goals.allFor(agent.id).length, 3);
    store.close();
  });

  it('orders active goals by priority', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);
    store.goals.insert({ ...makeGoal('goal_000001', agent.id), priority: 0.2 });
    store.goals.insert({ ...makeGoal('goal_000002', agent.id), priority: 0.9 });
    assert.deepEqual(store.goals.activeFor(agent.id).map((g) => g.id), ['goal_000002', 'goal_000001']);
    store.close();
  });

  it('keeps superseded plans for the audit trail', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);
    const goal = makeGoal('goal_000001', agent.id);
    store.goals.insert(goal);

    const first: Plan = {
      id: 'plan_000001' as PlanId,
      goalId: goal.id,
      agentId: agent.id,
      steps: [makeStep(0, 'rest', { ticks: 10 })],
      currentStep: 0,
      state: 'active',
      createdAtTicks: 1000,
      revision: 0,
    };
    store.plans.insert(first);
    store.plans.supersedeForGoal(goal.id);
    store.plans.insert({ ...first, id: 'plan_000002' as PlanId, revision: 1 });

    assert.equal(store.plans.activeForGoal(goal.id)?.id, 'plan_000002');
    // The abandoned attempt is still on record.
    assert.equal(store.plans.historyForGoal(goal.id).length, 2);
    assert.equal(store.plans.find('plan_000001' as PlanId)?.state, 'superseded');
    store.close();
  });

  it('links sub-goals to their parent', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);
    const parent = makeGoal('goal_000001', agent.id);
    store.goals.insert(parent);
    store.goals.insert({ ...makeGoal('goal_000002', agent.id), parentGoalId: parent.id });
    assert.deepEqual(store.goals.childrenOf(parent.id).map((g) => g.id), ['goal_000002']);
    store.close();
  });

  it('cascades goals and plans when an agent is deleted', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);
    const goal = makeGoal('goal_000001', agent.id);
    store.goals.insert(goal);
    store.db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
    assert.equal(store.goals.find(goal.id), null);
    store.close();
  });
});

describe('memories', () => {
  it('round-trips a memory with its source and tags', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);

    const memory = store.memories.insert(
      {
        agentId: agent.id,
        type: 'semantic',
        content: 'There is iron beneath the northern ridge.',
        importance: 0.8,
        source: toldBy('agent_000002' as AgentId),
        tags: ['iron', 'northern ridge'],
        relatedEntities: ['agent_000002'],
        confidence: 0.6,
      },
      CTX,
    );

    const read = store.memories.find(agent.id, memory.id);
    assert.deepEqual(read, memory);
    assert.deepEqual(read?.source, { kind: 'told_by', agentId: 'agent_000002' });
    assert.deepEqual(read?.tags, ['iron', 'northern ridge']);
    assert.equal(read?.confidence, 0.6);
    store.close();
  });

  it('will not return another agent\'s memory', () => {
    const store = freshStore();
    const mira = makeAgent();
    const elias = makeAgent({ id: 'agent_000002' as AgentId, name: 'Elias' });
    store.agents.insert(mira);
    store.agents.insert(elias);

    const secret = store.memories.insert(
      { agentId: mira.id, type: 'episodic', content: 'I hid the food.', importance: 0.9, source: OBSERVED },
      CTX,
    );

    // The agentId argument is the knowledge boundary (ADR-0007).
    assert.equal(store.memories.find(elias.id, secret.id), null);
    assert.equal(store.memories.count(elias.id), 0);
    assert.equal(store.memories.recent(elias.id).length, 0);
    store.close();
  });

  it('filters candidates by type and importance', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);

    store.memories.insert({ agentId: agent.id, type: 'episodic', content: 'trivial', importance: 0.1, source: OBSERVED }, CTX);
    store.memories.insert({ agentId: agent.id, type: 'episodic', content: 'important', importance: 0.9, source: OBSERVED }, CTX);
    store.memories.insert({ agentId: agent.id, type: 'semantic', content: 'a fact', importance: 0.5, source: OBSERVED }, CTX);

    assert.equal(store.memories.candidates(agent.id, { types: ['episodic'] }).length, 2);
    assert.equal(store.memories.candidates(agent.id, { minImportance: 0.5 }).length, 2);
    assert.equal(store.memories.candidates(agent.id, { types: ['semantic'], minImportance: 0.5 }).length, 1);
    assert.deepEqual(store.memories.byType(agent.id, 'semantic').map((m) => m.content), ['a fact']);
    store.close();
  });

  it('tracks access, which feeds retrieval scoring', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);
    const memory = store.memories.insert(
      { agentId: agent.id, type: 'episodic', content: 'useful', importance: 0.5, source: OBSERVED },
      CTX,
    );

    store.memories.markAccessed(agent.id, [memory.id], 5000);
    store.memories.markAccessed(agent.id, [memory.id], 6000);
    const read = store.memories.find(agent.id, memory.id);
    assert.equal(read?.accessCount, 2);
    assert.equal(read?.lastAccessedAtTicks, 6000);
    store.close();
  });

  it('keeps consolidated memories retrievable but excludable', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);

    const raw = store.memories.insert({ agentId: agent.id, type: 'episodic', content: 'Arun shared food', importance: 0.5, source: OBSERVED }, CTX);
    const belief = store.memories.insert({ agentId: agent.id, type: 'semantic', content: 'Arun is dependable', importance: 0.8, source: OBSERVED }, CTX);
    store.memories.markConsolidated(agent.id, [raw.id], belief.id);

    // The evidence survives — it is just deprioritised (requirement 12).
    assert.equal(store.memories.find(agent.id, raw.id)?.consolidatedInto, belief.id);
    assert.equal(store.memories.candidates(agent.id, { excludeConsolidated: true }).length, 1);
    assert.equal(store.memories.candidates(agent.id).length, 2);
    assert.equal(store.memories.unconsolidatedCount(agent.id), 0);
    store.close();
  });

  it('decays episodic importance but leaves semantic beliefs alone', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);
    const episodic = store.memories.insert({ agentId: agent.id, type: 'episodic', content: 'a day passed', importance: 0.8, source: OBSERVED }, CTX);
    const semantic = store.memories.insert({ agentId: agent.id, type: 'semantic', content: 'iron is north', importance: 0.8, source: OBSERVED }, CTX);

    store.memories.decay(agent.id, 0.5);
    assert.equal(store.memories.find(agent.id, episodic.id)?.importance, 0.4);
    assert.equal(store.memories.find(agent.id, semantic.id)?.importance, 0.8);
    store.close();
  });

  it('never decays below the floor', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);
    const memory = store.memories.insert({ agentId: agent.id, type: 'episodic', content: 'faint', importance: 0.1, source: OBSERVED }, CTX);
    for (let i = 0; i < 20; i++) store.memories.decay(agent.id, 0.5, 0.05);
    assert.equal(store.memories.find(agent.id, memory.id)?.importance, 0.05);
    store.close();
  });

  it('only forgets consolidated, never-accessed, faded memories', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);

    const belief = store.memories.insert({ agentId: agent.id, type: 'semantic', content: 'belief', importance: 0.9, source: OBSERVED }, CTX);
    const forgettable = store.memories.insert({ agentId: agent.id, type: 'episodic', content: 'forgettable', importance: 0.01, source: OBSERVED }, CTX);
    const unconsolidated = store.memories.insert({ agentId: agent.id, type: 'episodic', content: 'still raw', importance: 0.01, source: OBSERVED }, CTX);
    const accessed = store.memories.insert({ agentId: agent.id, type: 'episodic', content: 'was useful', importance: 0.01, source: OBSERVED }, CTX);

    store.memories.markConsolidated(agent.id, [forgettable.id, accessed.id], belief.id);
    store.memories.markAccessed(agent.id, [accessed.id], 2000);

    const removed = store.memories.forget(agent.id, 0.05, 5000);
    assert.equal(removed, 1);
    assert.equal(store.memories.find(agent.id, forgettable.id), null);
    // Raw memories and ones that proved useful are retained.
    assert.ok(store.memories.find(agent.id, unconsolidated.id) !== null);
    assert.ok(store.memories.find(agent.id, accessed.id) !== null);
    store.close();
  });
});

describe('world knowledge', () => {
  it('is private per agent, and spreads only by being told', () => {
    const store = freshStore();
    const arun = makeAgent({ id: 'agent_000001' as AgentId, name: 'Arun' });
    const mira = makeAgent({ id: 'agent_000002' as AgentId, name: 'Mira' });
    store.agents.insert(arun);
    store.agents.insert(mira);

    const deposit = position(142, 68, -91);
    store.knowledge.rememberResource({
      agentId: arun.id,
      resource: 'iron',
      position: deposit,
      estimatedQuantity: 24,
      confidence: 0.9,
      source: OBSERVED,
      discoveredAtDay: 3,
      lastSeenAtTicks: 72_000,
    });

    assert.equal(store.knowledge.knownResources(arun.id, 'iron').length, 1);
    assert.equal(store.knowledge.knownResources(mira.id, 'iron').length, 0, 'Mira must not know yet');

    // Arun tells Mira. She now knows, at lower confidence, sourced to him.
    store.knowledge.rememberResource({
      agentId: mira.id,
      resource: 'iron',
      position: deposit,
      estimatedQuantity: 24,
      confidence: 0.6,
      source: toldBy(arun.id),
      discoveredAtDay: 3,
      lastSeenAtTicks: 72_500,
    });

    const miraKnows = store.knowledge.knownResources(mira.id, 'iron');
    assert.equal(miraKnows.length, 1);
    assert.deepEqual(miraKnows[0]?.source, { kind: 'told_by', agentId: arun.id });
    assert.equal(miraKnows[0]?.confidence, 0.6, 'second-hand knowledge is held less firmly');
    store.close();
  });

  it('raises location confidence on re-observation instead of duplicating', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);
    const spot = position(10, 64, 10);

    for (const confidence of [0.4, 0.9, 0.5]) {
      store.knowledge.rememberLocation({
        agentId: agent.id,
        position: spot,
        kind: 'water',
        confidence,
        source: OBSERVED,
        label: 'the bay',
        discoveredAtDay: 1,
        lastSeenAtTicks: 1000,
      });
    }

    const known = store.knowledge.knownLocations(agent.id, 'water');
    assert.equal(known.length, 1);
    assert.equal(known[0]?.confidence, 0.9, 'confidence should not fall on a poorer sighting');
    assert.ok(store.knowledge.knowsLocation(agent.id, spot, 'water'));
    assert.ok(!store.knowledge.knowsLocation(agent.id, spot, 'cave'));
    store.close();
  });

  it('finds the nearest known location by horizontal distance', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);

    for (const [x, z] of [[100, 0], [10, 0], [50, 0]] as const) {
      store.knowledge.rememberLocation({
        agentId: agent.id,
        position: position(x, 64, z),
        kind: 'forest',
        confidence: 0.8,
        source: OBSERVED,
        label: '',
        discoveredAtDay: 1,
        lastSeenAtTicks: 1,
      });
    }

    const nearest = store.knowledge.nearestLocation(agent.id, 'forest', position(0, 64, 0));
    assert.equal(nearest?.position.x, 10);
    assert.equal(store.knowledge.nearestLocation(agent.id, 'cave', position(0, 64, 0)), null);
    store.close();
  });

  it('lets a failed harvest correct the belief that caused it', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);
    const deposit = position(142, 68, -91);

    store.knowledge.rememberResource({
      agentId: agent.id,
      resource: 'iron',
      position: deposit,
      estimatedQuantity: 24,
      confidence: 0.9,
      source: OBSERVED,
      discoveredAtDay: 3,
      lastSeenAtTicks: 72_000,
    });

    // The agent went there and found nothing: the vein is gone (ADR-0008).
    store.knowledge.correctResourceBelief(agent.id, 'iron', deposit, 0, 0);

    assert.equal(store.knowledge.knownResources(agent.id, 'iron').length, 0, 'exhausted deposits drop out of planning');
    assert.equal(store.knowledge.knownResources(agent.id, 'iron', 0).length, 1, 'but the row remains, so the agent remembers looking');
    store.close();
  });
});

describe('relationships', () => {
  it('starts neutral and moves only with a reason', () => {
    const store = freshStore();
    const nadia = makeAgent({ id: 'agent_000001' as AgentId, name: 'Nadia' });
    const elias = makeAgent({ id: 'agent_000002' as AgentId, name: 'Elias' });
    store.agents.insert(nadia);
    store.agents.insert(elias);

    assert.equal(store.knowledge.relationship(nadia.id, elias.id), null);

    const updated = store.knowledge.adjustRelationship(
      elias.id,
      nadia.id,
      { trust: 0.3, affinity: 0.2, familiarity: 0.4, reason: 'shared food when I was hungry' },
      5000,
    );

    assert.equal(updated.trust, 0.3);
    assert.equal(updated.interactions, 1);
    assert.equal(updated.lastReason, 'shared food when I was hungry');
    store.close();
  });

  it('is asymmetric — each direction is its own row', () => {
    const store = freshStore();
    const a = makeAgent({ id: 'agent_000001' as AgentId, name: 'A' });
    const b = makeAgent({ id: 'agent_000002' as AgentId, name: 'B' });
    store.agents.insert(a);
    store.agents.insert(b);

    store.knowledge.adjustRelationship(a.id, b.id, { trust: 0.5, reason: 'kept a promise' }, 100);
    assert.equal(store.knowledge.relationship(a.id, b.id)?.trust, 0.5);
    assert.equal(store.knowledge.relationship(b.id, a.id), null, 'B has formed no view of A yet');
    store.close();
  });

  it('accumulates and clamps to the -1..1 range', () => {
    const store = freshStore();
    const a = makeAgent({ id: 'agent_000001' as AgentId, name: 'A' });
    const b = makeAgent({ id: 'agent_000002' as AgentId, name: 'B' });
    store.agents.insert(a);
    store.agents.insert(b);

    for (let i = 0; i < 10; i++) {
      store.knowledge.adjustRelationship(a.id, b.id, { trust: 0.3, familiarity: 0.3, reason: 'helped again' }, 100 + i);
    }
    const relationship = store.knowledge.relationship(a.id, b.id);
    assert.equal(relationship?.trust, 1, 'trust saturates rather than running away');
    assert.equal(relationship?.familiarity, 1);
    assert.equal(relationship?.interactions, 10);

    for (let i = 0; i < 30; i++) {
      store.knowledge.adjustRelationship(a.id, b.id, { trust: -0.3, reason: 'stole from me' }, 200 + i);
    }
    assert.equal(store.knowledge.relationship(a.id, b.id)?.trust, -1);
    store.close();
  });

  it('links the event that caused the change', () => {
    const store = freshStore();
    const a = makeAgent({ id: 'agent_000001' as AgentId, name: 'A' });
    const b = makeAgent({ id: 'agent_000002' as AgentId, name: 'B' });
    store.agents.insert(a);
    store.agents.insert(b);

    const event = store.events.append(
      { type: 'resource_transferred', actorId: b.id, payload: { fromAgentId: b.id, toAgentId: a.id, resources: { food: 3 }, reason: 'shared a meal' } },
      CTX,
    );
    const relationship = store.knowledge.adjustRelationship(
      a.id,
      b.id,
      { trust: 0.2, reason: 'shared a meal', eventId: event.id as never },
      CTX.worldTicks,
    );

    // Requirement 47: an opinion change must point at the event behind it.
    assert.equal(relationship.lastEventId, event.id);
    assert.equal(store.events.find(relationship.lastEventId!)?.type, 'resource_transferred');
    store.close();
  });

  it('rejects a relationship with oneself', () => {
    const store = freshStore();
    const a = makeAgent();
    store.agents.insert(a);
    assert.throws(() => store.knowledge.adjustRelationship(a.id, a.id, { reason: 'narcissism' }, 1));
    store.close();
  });
});

describe('messages', () => {
  it('delivers to the recipient inbox and marks read', () => {
    const store = freshStore();
    const arun = makeAgent({ id: 'agent_000001' as AgentId, name: 'Arun' });
    const mira = makeAgent({ id: 'agent_000002' as AgentId, name: 'Mira' });
    store.agents.insert(arun);
    store.agents.insert(mira);

    const message = store.messages.send(arun.id, mira.id, 'I found exposed iron north of the settlement.', CTX);

    assert.equal(store.messages.inbox(mira.id).length, 1);
    assert.equal(store.messages.inbox(arun.id).length, 0, 'the sender does not receive their own message');

    store.messages.markRead([message.id as never], 1500);
    assert.equal(store.messages.inbox(mira.id).length, 0);
    // Read messages stay on record for both participants.
    assert.equal(store.messages.historyFor(mira.id).length, 1);
    assert.equal(store.messages.historyFor(arun.id).length, 1);
    store.close();
  });

  it('delivers in send order', () => {
    const store = freshStore();
    const a = makeAgent({ id: 'agent_000001' as AgentId, name: 'A' });
    const b = makeAgent({ id: 'agent_000002' as AgentId, name: 'B' });
    store.agents.insert(a);
    store.agents.insert(b);

    store.messages.send(a.id, b.id, 'first', { day: 1, worldTicks: 100 });
    store.messages.send(a.id, b.id, 'second', { day: 1, worldTicks: 200 });
    assert.deepEqual(store.messages.inbox(b.id).map((m) => m.content), ['first', 'second']);
    store.close();
  });
});

describe('resource ledger', () => {
  it('credits and reports a balance', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);
    const owner = agentOwner(agent.id);

    store.ledger.credit(owner, { wood: 12, stone: 4 });
    store.ledger.credit(owner, { wood: 6 });
    assert.deepEqual(store.ledger.balance(owner), { wood: 18, stone: 4 });
    assert.equal(store.ledger.quantity(owner, 'wood'), 18);
    assert.equal(store.ledger.quantity(owner, 'iron'), 0);
    store.close();
  });

  it('refuses a debit it cannot cover, and changes nothing', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);
    const owner = agentOwner(agent.id);
    store.ledger.credit(owner, { wood: 10 });

    const result = store.ledger.debit(owner, { wood: 4, stone: 8 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'INSUFFICIENT_RESOURCES');
      assert.match(result.failure.detail, /8 stone/);
      assert.equal(result.failure.retryable, false, 'retrying an unaffordable build cannot help');
    }
    // All-or-nothing: the affordable half must not have been taken.
    assert.deepEqual(store.ledger.balance(owner), { wood: 10 });
    store.close();
  });

  it('debits what it can cover', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);
    const owner = agentOwner(agent.id);
    store.ledger.credit(owner, { wood: 10, stone: 10 });

    const result = store.ledger.debit(owner, { wood: 4 });
    assert.equal(result.ok, true);
    assert.deepEqual(store.ledger.balance(owner), { wood: 6, stone: 10 });
    store.close();
  });

  it('reports affordability without side effects', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);
    const owner = agentOwner(agent.id);
    store.ledger.credit(owner, { wood: 10 });

    assert.ok(store.ledger.canAfford(owner, { wood: 10 }));
    assert.ok(!store.ledger.canAfford(owner, { wood: 11 }));
    assert.deepEqual(store.ledger.balance(owner), { wood: 10 });
    store.close();
  });

  it('conserves resources across a transfer', () => {
    const store = freshStore();
    const nadia = makeAgent({ id: 'agent_000001' as AgentId, name: 'Nadia' });
    const elias = makeAgent({ id: 'agent_000002' as AgentId, name: 'Elias' });
    store.agents.insert(nadia);
    store.agents.insert(elias);
    const from = agentOwner(nadia.id);
    const to = agentOwner(elias.id);
    store.ledger.credit(from, { food: 6 });

    assert.equal(store.ledger.transfer(from, to, { food: 4 }).ok, true);
    // Sharing costs the giver — that is what makes it a real social act.
    assert.deepEqual(store.ledger.balance(from), { food: 2 });
    assert.deepEqual(store.ledger.balance(to), { food: 4 });
    store.close();
  });

  it('leaves both balances untouched when a transfer is unaffordable', () => {
    const store = freshStore();
    const a = makeAgent({ id: 'agent_000001' as AgentId, name: 'A' });
    const b = makeAgent({ id: 'agent_000002' as AgentId, name: 'B' });
    store.agents.insert(a);
    store.agents.insert(b);
    const from = agentOwner(a.id);
    const to = agentOwner(b.id);
    store.ledger.credit(from, { food: 1 });

    assert.equal(store.ledger.transfer(from, to, { food: 5 }).ok, false);
    assert.deepEqual(store.ledger.balance(from), { food: 1 });
    assert.deepEqual(store.ledger.balance(to), {});
    store.close();
  });

  it('never lets a balance go negative', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);
    const owner = agentOwner(agent.id);
    store.ledger.credit(owner, { wood: 1 });
    store.ledger.debit(owner, { wood: 1 });
    assert.equal(store.ledger.debit(owner, { wood: 1 }).ok, false);
    assert.equal(store.ledger.quantity(owner, 'wood'), 0);
    store.close();
  });
});

describe('decisions and cost metrics', () => {
  it('stores the inputs behind a decision, making it explainable', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);
    const memory = store.memories.insert(
      { agentId: agent.id, type: 'episodic', content: 'the last farm site flooded', importance: 0.7, source: OBSERVED },
      CTX,
    );

    const decision = store.decisions.record({
      agentId: agent.id,
      category: 'goal_selection',
      worldTicks: CTX.worldTicks,
      day: CTX.day,
      observation: { nearbyWater: true, phase: 'day' },
      memoryIds: [memory.id],
      prompt: 'What should Mira do next?',
      response: '{"decision":"abandon_goal"}',
      model: 'claude-sonnet-5',
      chosenAction: 'abandon_goal',
      eventId: null,
      llmCallId: null,
    });

    const read = store.decisions.find(decision.id);
    assert.deepEqual(read?.observation, { nearbyWater: true, phase: 'day' });
    assert.deepEqual(read?.memoryIds, [memory.id]);
    assert.equal(read?.chosenAction, 'abandon_goal');
    assert.equal(read?.prompt, 'What should Mira do next?');
    assert.deepEqual(store.decisions.forAgent(agent.id).map((d) => d.id), [decision.id]);
    store.close();
  });

  it('keeps the causal row even when text recording is disabled', () => {
    const store = Store.open({ path: ':memory:', ids: sequentialIdFactory(), recordDecisionText: false });
    store.simulation.initialise('test', 1);
    const agent = makeAgent();
    store.agents.insert(agent);

    const decision = store.decisions.record({
      agentId: agent.id,
      category: 'replanning',
      worldTicks: 1,
      day: 1,
      observation: {},
      memoryIds: [],
      prompt: 'secret prompt',
      response: 'secret response',
      model: 'm',
      chosenAction: 'revise_plan',
      eventId: null,
      llmCallId: null,
    });

    const read = store.decisions.find(decision.id);
    assert.equal(read?.prompt, null);
    assert.equal(read?.response, null);
    // The link between decision and action survives regardless.
    assert.equal(read?.chosenAction, 'revise_plan');
    store.close();
  });

  it('aggregates token spend by category and agent', () => {
    const store = freshStore();
    const agent = makeAgent();
    store.agents.insert(agent);

    store.llmCalls.record({
      agentId: agent.id, category: 'goal_selection', provider: 'anthropic', model: 'claude-sonnet-5',
      inputTokens: 1000, outputTokens: 200, costUsd: 0.01, durationMs: 900, day: 1, ok: true, error: null, createdAt: 1,
    });
    store.llmCalls.record({
      agentId: agent.id, category: 'reflection', provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
      inputTokens: 500, outputTokens: 100, costUsd: 0.001, durationMs: 300, day: 1, ok: true, error: null, createdAt: 2,
    });
    store.llmCalls.record({
      agentId: null, category: 'chronicle', provider: 'anthropic', model: 'claude-sonnet-5',
      inputTokens: 800, outputTokens: 600, costUsd: 0.02, durationMs: 1500, day: 1, ok: false, error: 'timeout', createdAt: 3,
    });

    const total = store.llmCalls.total();
    assert.equal(total.calls, 3);
    assert.equal(total.inputTokens, 2300);
    assert.equal(total.outputTokens, 900);
    assert.ok(Math.abs(total.costUsd - 0.031) < 1e-9);
    assert.equal(total.failures, 1);

    assert.equal(store.llmCalls.byCategory().get('goal_selection')?.calls, 1);
    assert.equal(store.llmCalls.byAgent().get(agent.id)?.calls, 2);
    // A call with no agent (the chronicle) is still attributed somewhere.
    assert.equal(store.llmCalls.byAgent().get('(none)')?.calls, 1);
    assert.equal(store.llmCalls.byDay().get('1')?.calls, 3);
    store.close();
  });

  it('reports zeroes rather than throwing on an empty run', () => {
    const store = freshStore();
    assert.deepEqual(store.llmCalls.total(), { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, failures: 0 });
    store.close();
  });
});

describe('restart persistence', () => {
  it('resumes the civilization from disk, mid-plan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worldloom-restart-'));
    const path = join(dir, 'worldloom.db');

    // ── First process: set up a civilization and get part-way through a plan.
    const first = Store.open({ path, ids: sequentialIdFactory() });
    first.simulation.initialise('first-settlement', 42, 1_700_000_000_000);
    first.simulation.advanceClock(6_000, 'clear');

    const agent = makeAgent({ activity: 'gathering timber', status: 'gathering', phase: 'act' });
    first.agents.insert(agent);

    const goal = makeGoal('goal_000001', agent.id);
    first.goals.insert(goal);
    const plan: Plan = {
      id: 'plan_000001' as PlanId,
      goalId: goal.id,
      agentId: agent.id,
      steps: [
        makeStep(0, 'locate_resource', { resource: 'wood', searchRadius: 48 }),
        makeStep(1, 'harvest_resource', { resource: 'wood', quantity: 48 }),
        makeStep(2, 'place_blueprint', { blueprint: 'small_shelter', origin: position(100, 64, -50) }),
      ],
      currentStep: 1,
      state: 'active',
      createdAtTicks: 1000,
      revision: 0,
    };
    first.plans.insert(plan);
    first.agents.update({ ...agent, currentGoalId: goal.id });

    first.ledger.credit(agentOwner(agent.id), { wood: 22 });
    first.memories.insert(
      { agentId: agent.id, type: 'semantic', content: 'Oaks grow thickly north of the camp.', importance: 0.6, source: OBSERVED, tags: ['wood'] },
      { day: 1, worldTicks: 6000 },
    );
    first.knowledge.rememberResource({
      agentId: agent.id, resource: 'wood', position: position(120, 70, -40),
      estimatedQuantity: 60, confidence: 0.9, source: OBSERVED, discoveredAtDay: 1, lastSeenAtTicks: 6000,
    });
    first.events.append(
      { type: 'goal_created', actorId: agent.id, payload: { agentId: agent.id, goalId: goal.id, kind: 'gather_resource', reason: 'the shelter needs timber', priority: 0.7 } },
      { day: 1, worldTicks: 6000 },
    );
    first.close();

    // ── Second process: a cold open of the same file.
    const second = Store.open({ path });

    const state = second.simulation.get();
    assert.equal(state.scenario, 'first-settlement');
    assert.equal(state.seed, 42);
    assert.equal(state.worldTicks, 6000, 'the world clock survives');
    assert.equal(state.lastRawTicks, 6000);

    const restored = second.agents.get(agent.id);
    assert.equal(restored.name, 'Mira');
    assert.equal(restored.activity, 'gathering timber');
    assert.equal(restored.phase, 'act', 'the tick phase resumes where it left off');
    assert.equal(restored.currentGoalId, goal.id);

    const restoredGoal = second.goals.activeFor(agent.id)[0];
    assert.equal(restoredGoal?.id, goal.id);
    assert.equal(restoredGoal?.reason, 'the shelter needs timber');

    const restoredPlan = second.plans.activeForGoal(goal.id);
    assert.equal(restoredPlan?.currentStep, 1, 'the plan resumes mid-flight, not from the start');
    assert.equal(restoredPlan?.steps[1]?.action, 'harvest_resource');

    // Cognitive and economic state carry over — the civilization does not reset
    // mentally (requirement 25).
    assert.deepEqual(second.ledger.balance(agentOwner(agent.id)), { wood: 22 });
    assert.equal(second.memories.count(agent.id), 1);
    assert.equal(second.knowledge.knownResources(agent.id, 'wood').length, 1);
    assert.equal(second.events.count(), 1);

    // The clock keeps advancing from where it stopped rather than restarting.
    const time = second.simulation.advanceClock(7_000, 'clear');
    assert.equal(time.totalTicks, 7_000);
    second.close();
  });
});
