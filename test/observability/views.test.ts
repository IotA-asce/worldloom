/**
 * The view models.
 *
 * These tests are the guarantee behind requirement 24: the same objects a CLI
 * renders can be handed to a dashboard unchanged. So they check three things —
 * that the numbers are right, that the structures survive JSON, and that an
 * agent's view contains nobody else's mind (ADR-0007).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sequentialIdFactory } from '../../src/core/ids.ts';
import {
  agentView,
  civilizationView,
  failureView,
  liveFeedView,
  resolveAgent,
} from '../../src/observability/views.ts';
import { Store } from '../../src/persistence/store.ts';
import { ARUN_PRIVATE_MARKER, assertJsonSafe, seedWorld } from './seed.ts';

describe('the civilization view', () => {
  it('describes an empty database without throwing', () => {
    const store = Store.openMemory(sequentialIdFactory());
    const view = civilizationView(store);

    assert.equal(view.initialised, false, 'a database nobody has run is not initialised');
    assert.equal(view.scenario, null);
    assert.equal(view.settlement, null);
    assert.equal(view.population.total, 0);
    assert.equal(view.events.total, 0);
    assert.equal(view.territory.bounds, null);
    assert.deepEqual(view.resources.total, {});
    assertJsonSafe(view, 'empty civilizationView');
    store.close();
  });

  it('reports the day, the phase and the settlement', () => {
    const world = seedWorld();
    const view = civilizationView(world.store);

    assert.equal(view.initialised, true);
    assert.equal(view.scenario, 'first-settlement');
    assert.equal(view.status, 'running');
    assert.equal(view.time.day, 1, 'the clock advanced through one wraparound');
    assert.equal(view.time.phase, 'day');
    assert.equal(view.settlement?.name, 'Riverbend');
    assert.equal(view.settlement?.foundingDay, 0);
    world.close();
  });

  it('counts the population and says what each settler is doing', () => {
    const world = seedWorld();
    const { population } = civilizationView(world.store);

    assert.equal(population.total, 2);
    assert.equal(population.living, 2);
    assert.equal(population.dead, 0);

    const mira = population.agents.find((agent) => agent.name === 'Mira');
    assert.ok(mira !== undefined);
    assert.equal(mira.goal?.kind, 'build_structure');
    assert.equal(mira.goal?.summary, 'build shelter');
    assert.match(mira.goal?.reason ?? '', /nightfall/);
    assert.deepEqual(mira.planProgress, { done: 1, total: 4 });
    world.close();
  });

  it('lists structures, projects and who has claimed them', () => {
    const world = seedWorld();
    const view = civilizationView(world.store);

    assert.deepEqual(view.structures.standingTypes, ['storage']);
    assert.equal(view.structures.items[0]?.verified, true);
    assert.deepEqual(view.structures.items[0]?.builders.map((builder) => builder.name), ['Mira']);

    assert.equal(view.projects.total, 1);
    assert.equal(view.projects.open, 1);
    const claims = view.projects.items[0]?.claims ?? [];
    assert.deepEqual(
      claims.map((claim) => `${claim.agent.name ?? '?'}:${claim.role}`).sort(),
      ['Arun:gathering', 'Mira:building'],
    );
    world.close();
  });

  it('totals the whole economy, whoever is holding it', () => {
    const world = seedWorld();
    const { resources } = civilizationView(world.store);

    // 18 wood with Arun plus 30 in the settlement store.
    assert.deepEqual(resources.total, { wood: 48, stone: 18, food: 6 });
    assert.deepEqual(resources.settlement, { wood: 30, stone: 6 });
    const mira = resources.agents.find((holding) => holding.owner.name === 'Mira');
    assert.deepEqual(mira?.holding, { stone: 12, food: 4 });
    world.close();
  });

  it('measures known territory as an aggregate, not as anyone beliefs', () => {
    const world = seedWorld();
    const { territory } = civilizationView(world.store);

    assert.equal(territory.knownLocations, 2, 'one place each, and they are different places');
    assert.equal(territory.knownResourceSites, 2);
    assert.deepEqual(territory.bounds, {
      min: { x: -24, y: 60, z: -8 },
      max: { x: 10, y: 70, z: 18 },
    });
    assert.equal(territory.spanBlocks, 35 * 27);
    assert.equal(territory.byAgent.length, 2);
    world.close();
  });

  it('survives a JSON round trip', () => {
    const world = seedWorld();
    assertJsonSafe(civilizationView(world.store), 'civilizationView');
    world.close();
  });
});

describe('the agent view', () => {
  it('returns null for an id that is not an agent', () => {
    const world = seedWorld();
    assert.equal(agentView(world.store, 'agent_nobody'), null);
    world.close();
  });

  it('shows the goal, its reason, and every plan step with its status', () => {
    const world = seedWorld();
    const view = agentView(world.store, world.mira.id);
    assert.ok(view !== null);

    assert.equal(view.goal?.summary, 'build shelter');
    assert.match(view.goal?.reason ?? '', /nobody has anywhere to sleep/);
    assert.deepEqual(
      view.plan?.steps.map((step) => step.status),
      ['completed', 'failed', 'active', 'pending'],
    );
    assert.equal(view.plan?.progress.done, 1);
    assert.equal(view.plan?.revision, 1);

    // A failed step carries the failure that caused it, as data.
    const failed = view.plan?.steps[1];
    assert.equal(failed?.failure?.kind, 'RESOURCE_UNAVAILABLE');
    assert.equal(failed?.failure?.retryable, false);
    assert.match(failed?.failure?.detail ?? '', /stand of trees/);
    world.close();
  });

  it('puts the most pressing need first', () => {
    const world = seedWorld();
    const view = agentView(world.store, world.mira.id);

    assert.equal(view?.needs[0]?.kind, 'shelter', 'she has nowhere to sleep');
    assert.equal(view?.needs[0]?.critical, true);
    assert.equal(view?.needs.length, 5, 'every need is reported, not only the urgent ones');
    world.close();
  });

  it('carries inventory, memories, relationships and correspondence', () => {
    const world = seedWorld();
    const view = agentView(world.store, world.mira.id);
    assert.ok(view !== null);

    assert.deepEqual(view.inventory, { stone: 12, food: 4 });
    assert.equal(view.memoryCounts.total, 4);
    assert.equal(view.memories.length, 4);
    assert.equal(view.knownLocations.length, 1);
    assert.equal(view.knownResources.length, 1);
    assert.equal(view.messages.length, 1);
    assert.equal(view.messages[0]?.from.name, 'Arun');
    assert.equal(view.decisions, 2);
    assert.deepEqual(
      view.projectClaims.map((claim) => claim.role),
      ['building'],
    );
    world.close();
  });

  it('says why each relationship last moved, and what moved it', () => {
    const world = seedWorld();
    const view = agentView(world.store, world.mira.id);

    const arun = view?.relationships[0];
    assert.equal(arun?.other.name, 'Arun');
    assert.equal(arun?.lastReason, 'brought the timber he promised');
    assert.equal(arun?.lastEventType, 'resource_collected', 'the event that explains it resolves');
    assert.ok((arun?.trust ?? 0) > 0);
    world.close();
  });

  it('keeps the goals she gave up on, with the outcome that ended them', () => {
    const world = seedWorld();
    const view = agentView(world.store, world.mira.id);

    assert.equal(view?.pastGoals.length, 1);
    assert.equal(view?.pastGoals[0]?.state, 'abandoned');
    assert.equal(view?.pastGoals[0]?.outcome, 'no soil within reach of the settlement');
    world.close();
  });

  it('never contains another agent private state', () => {
    const world = seedWorld();
    const mira = agentView(world.store, world.mira.id);
    const arun = agentView(world.store, world.arun.id);
    assert.ok(mira !== null && arun !== null);

    // Arun's own view has the marker; Mira's must not, anywhere in it.
    assert.match(JSON.stringify(arun), new RegExp(ARUN_PRIVATE_MARKER));
    assert.doesNotMatch(
      JSON.stringify(mira),
      new RegExp(ARUN_PRIVATE_MARKER),
      "Mira's view leaked one of Arun's beliefs",
    );

    // And structurally: nothing in the view came from another agent's rows.
    for (const memory of mira.memories) {
      assert.ok(!memory.content.includes(ARUN_PRIVATE_MARKER));
    }
    assert.deepEqual(
      mira.knownLocations.map((place) => place.label),
      ['flat ground east of the river'],
    );
    world.close();
  });

  it('survives a JSON round trip', () => {
    const world = seedWorld();
    assertJsonSafe(agentView(world.store, world.mira.id), 'agentView');
    assertJsonSafe(agentView(world.store, world.arun.id), 'agentView (Arun)');
    world.close();
  });
});

describe('the live feed', () => {
  it('is newest first, and bounded by the limit asked for', () => {
    const world = seedWorld();
    const view = liveFeedView(world.store, 3);

    assert.equal(view.entries.length, 3);
    assert.equal(view.entries[0]?.seq, view.latestSeq, 'the newest event heads the feed');
    assert.ok((view.entries[0]?.seq ?? 0) > (view.entries[1]?.seq ?? 0));
    assert.equal(view.day, 1);
    world.close();
  });

  it('names the actor behind each event', () => {
    const world = seedWorld();
    const view = liveFeedView(world.store, 50);

    const spawned = view.entries.filter((entry) => entry.type === 'agent_spawned');
    assert.equal(spawned.length, 2);
    assert.deepEqual(spawned.map((entry) => entry.actor?.name).sort(), ['Arun', 'Mira']);

    const founded = view.entries.find((entry) => entry.type === 'settlement_founded');
    assert.equal(founded?.actor, null, 'the settlement was founded by nobody in particular');
    world.close();
  });

  it('can be polled incrementally from the last sequence seen', () => {
    const world = seedWorld();
    const first = liveFeedView(world.store, 5);
    const oldest = first.entries[first.entries.length - 1]!.seq;

    const since = liveFeedView(world.store, 50, { sinceSeq: oldest });
    assert.ok(since.entries.every((entry) => entry.seq > oldest));
    assert.equal(since.entries.length, first.latestSeq - oldest);
    world.close();
  });

  it('takes the newest matches when a filtered feed is limited', () => {
    // The trap this guards: an ascending query with a LIMIT returns the *oldest*
    // matches, so a filtered live panel would show the start of the run forever.
    const world = seedWorld();
    const all = liveFeedView(world.store, 50, { types: ['action_failed'] });
    const latest = liveFeedView(world.store, 2, { types: ['action_failed'] });

    assert.equal(all.entries.length, 3);
    assert.deepEqual(
      latest.entries.map((entry) => entry.seq),
      all.entries.slice(0, 2).map((entry) => entry.seq),
    );
    world.close();
  });

  it('filters to the events worth narrating', () => {
    const world = seedWorld();
    const view = liveFeedView(world.store, 50, { minImportance: 0.9 });

    assert.ok(view.entries.length > 0);
    assert.ok(view.entries.every((entry) => entry.importance >= 0.9));
    world.close();
  });

  it('survives a JSON round trip', () => {
    const world = seedWorld();
    assertJsonSafe(liveFeedView(world.store, 10), 'liveFeedView');
    world.close();
  });
});

describe('the failure view', () => {
  it('groups repeated failures by kind, most common first', () => {
    const world = seedWorld();
    const view = failureView(world.store);

    assert.deepEqual(
      view.byKind.map((group) => `${group.kind}:${String(group.count)}`),
      ['RESOURCE_UNAVAILABLE:2', 'gather_resource:1', 'PATH_BLOCKED:1'],
    );

    const unavailable = view.byKind[0]!;
    assert.deepEqual(unavailable.agents.map((entry) => entry.agent.name), ['Mira']);
    assert.equal(unavailable.agents[0]?.count, 2);
    assert.match(unavailable.latest.detail, /eastern copse/, 'the example is the latest one');
    world.close();
  });

  it('reports whole-run totals alongside the window it grouped', () => {
    const world = seedWorld();
    const view = failureView(world.store);

    assert.deepEqual(view.totals, {
      actionFailed: 3,
      goalFailed: 1,
      goalAbandoned: 1,
      goalBlocked: 0,
    });
    assert.equal(view.windowSize, 4);
    world.close();
  });

  it('keeps the detail a developer needs on each occurrence', () => {
    const world = seedWorld();
    const blocked = failureView(world.store).recent.find((entry) => entry.kind === 'PATH_BLOCKED');

    assert.equal(blocked?.type, 'action_failed');
    assert.equal(blocked?.subject, 'travel_to');
    assert.equal(blocked?.agent?.name, 'Arun');
    assert.match(blocked?.detail ?? '', /ravine/);
    world.close();
  });

  it('is empty rather than absent when nothing has gone wrong', () => {
    const store = Store.openMemory(sequentialIdFactory());
    const view = failureView(store);

    assert.deepEqual(view.byKind, []);
    assert.deepEqual(view.recent, []);
    assert.equal(view.windowSize, 0);
    assertJsonSafe(view, 'empty failureView');
    store.close();
  });

  it('survives a JSON round trip', () => {
    const world = seedWorld();
    assertJsonSafe(failureView(world.store), 'failureView');
    world.close();
  });
});

describe('resolving an agent a human named', () => {
  it('accepts a name in any case, or an id', () => {
    const world = seedWorld();

    assert.equal(resolveAgent(world.store, 'mira')?.id, world.mira.id);
    assert.equal(resolveAgent(world.store, 'MIRA')?.id, world.mira.id);
    assert.equal(resolveAgent(world.store, world.arun.id)?.name, 'Arun');
    assert.equal(resolveAgent(world.store, 'nobody'), null);
    world.close();
  });
});
