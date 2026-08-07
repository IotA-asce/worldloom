/**
 * Shared work: proposing it, paying for it, and finishing it once.
 *
 * The two tests this milestone turns on are "accumulates contributions from
 * several settlers and completes once" and the rebuild at the bottom. A project
 * that could not gather contributions from several people would just be a goal
 * with extra steps, and a project row that could not be rebuilt from the ledger
 * would be a second source of truth.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { costOf } from '../../src/civilization/blueprints.ts';
import {
  buildKind,
  claimRole,
  completeFundedStockpiles,
  completeProject,
  completeProjectsFor,
  contribute,
  createProject,
  describeProject,
  openProgress,
  openRoles,
  priorityOfKind,
  progressOf,
  proposeProjects,
  reconcileCivilization,
  releaseClaimsBy,
  rolesOf,
  stockpileKind,
  withdrawForBuild,
} from '../../src/civilization/projects.ts';
import { agentOwner, settlementOwner } from '../../src/persistence/repositories/ledger.ts';
import type { Project } from '../../src/civilization/types.ts';
import { buildStructure, firstSettlement, ticksOf, worldTime, type Fixture } from './fixture.ts';

function shelterProject(fixture: Fixture): Project {
  return createProject(fixture.store, {
    settlementId: fixture.settlementId,
    kind: buildKind('small_shelter'),
    time: ticksOf(fixture.time),
  });
}

describe('proposing what the settlement lacks', () => {
  it('asks for a shelter and a food store on the first day, and nothing else', () => {
    const fixture = firstSettlement();
    const created = proposeProjects(fixture.store, {
      settlementId: fixture.settlementId,
      time: ticksOf(fixture.time),
    });

    assert.deepEqual(
      created.map((project) => project.kind).sort(),
      [buildKind('small_shelter'), stockpileKind('food')].sort(),
    );
    assert.equal(fixture.store.projects.open().length, 2);
  });

  it('does not propose work it has already proposed', () => {
    const fixture = firstSettlement();
    const options = { settlementId: fixture.settlementId, time: ticksOf(fixture.time) };
    proposeProjects(fixture.store, options);
    assert.deepEqual(proposeProjects(fixture.store, options), []);
    assert.equal(fixture.store.projects.open().length, 2);
  });

  it('asks for storage once a shelter stands', () => {
    const fixture = firstSettlement();
    buildStructure(fixture, { blueprint: 'small_shelter', builders: [fixture.settler('Mira').id] });
    // Food already in hand, so the only gap is the next structure.
    fixture.store.ledger.credit(settlementOwner(fixture.settlementId), { food: 40 });

    const created = proposeProjects(fixture.store, {
      settlementId: fixture.settlementId,
      time: ticksOf(fixture.time),
    });
    assert.deepEqual(created.map((project) => project.kind), [buildKind('storage')]);
  });

  it('prices a build from its blueprint rather than from a constant', () => {
    const fixture = firstSettlement();
    const project = shelterProject(fixture);

    assert.deepEqual(project.requirements, costOf('small_shelter'));
    assert.ok((project.requirements.wood ?? 0) > 40, 'a shelter is expensive because it is big');
    assert.equal(project.blueprint, 'small_shelter');
    assert.equal(project.state, 'proposed');
    assert.equal(describeProject(project), 'a shelter');
  });

  it('ranks a roof above a food store above a farm', () => {
    assert.ok(priorityOfKind(buildKind('small_shelter')) > priorityOfKind(stockpileKind('food')));
    assert.ok(priorityOfKind(stockpileKind('food')) > priorityOfKind(buildKind('small_farm')));
  });

  it('announces every project in the ledger', () => {
    const fixture = firstSettlement();
    shelterProject(fixture);
    const events = fixture.store.events.query({ types: ['project_created'] });
    assert.equal(events.length, 1);
    assert.deepEqual(
      (events[0]?.payload as { requirements: unknown }).requirements,
      costOf('small_shelter'),
    );
  });
});

describe('the roles a project offers', () => {
  it('offers one building role and one gathering role per material it lacks', () => {
    const fixture = firstSettlement();
    const project = shelterProject(fixture);
    const progress = progressOf(fixture.store, project.id);
    assert.ok(progress !== null);

    const roles = rolesOf(fixture.store, progress);
    const building = roles.filter((slot) => slot.role === 'building');
    assert.equal(building.length, 1);
    assert.equal(building[0]?.capacity, 1, 'only one settler builds a given structure');

    assert.deepEqual(
      roles.filter((slot) => slot.role.startsWith('gathering:')).map((slot) => slot.role).sort(),
      ['gathering:stone', 'gathering:wood'],
    );
    // Sixty timbers is worth two pairs of hands; twenty-five stones is not.
    assert.equal(roles.find((slot) => slot.role === 'gathering:wood')?.capacity, 2);
    assert.equal(roles.find((slot) => slot.role === 'gathering:stone')?.capacity, 1);
  });

  it('stops offering to fetch what the shared store already has', () => {
    const fixture = firstSettlement();
    const project = shelterProject(fixture);
    fixture.store.ledger.credit(settlementOwner(fixture.settlementId), costOf('small_shelter'));

    const roles = openRoles(fixture.store);
    assert.deepEqual(
      roles.map((slot) => slot.role),
      ['building'],
    );
    assert.equal(progressOf(fixture.store, project.id)?.funded, true);
    assert.equal(rolesOf(fixture.store, progressOf(fixture.store, project.id)!)[0]?.goal, 'build_structure');
  });

  it('gives the higher-priority project first call on the shared store', () => {
    const fixture = firstSettlement();
    shelterProject(fixture);
    createProject(fixture.store, {
      settlementId: fixture.settlementId,
      kind: buildKind('small_farm'),
      time: ticksOf(fixture.time),
    });
    // Enough stone for the shelter's floor, and no more.
    fixture.store.ledger.credit(settlementOwner(fixture.settlementId), { stone: 25 });

    const progress = openProgress(fixture.store);
    assert.equal(progress[0]?.project.kind, buildKind('small_shelter'));
    assert.equal(progress[0]?.available.stone, 25);
    // The farm must not believe the shelter's masonry is available to it.
    assert.equal(progress[1]?.available.stone, undefined);
  });
});

describe('claiming a role', () => {
  it('turns a proposed project into one being worked on', () => {
    const fixture = firstSettlement();
    const project = shelterProject(fixture);
    const claimed = claimRole(fixture.store, {
      projectId: project.id,
      agentId: fixture.settler('Mira').id,
      role: 'building',
      time: ticksOf(fixture.time),
    });

    assert.equal(claimed.ok, true);
    assert.equal(fixture.store.projects.find(project.id)?.state, 'active');
    assert.equal(fixture.store.events.query({ types: ['project_claimed'] }).length, 1);
  });

  it('refuses a role already filled, and says who has it', () => {
    const fixture = firstSettlement();
    const project = shelterProject(fixture);
    const time = ticksOf(fixture.time);
    const mira = fixture.settler('Mira');
    claimRole(fixture.store, { projectId: project.id, agentId: mira.id, role: 'building', time });

    const second = claimRole(fixture.store, {
      projectId: project.id,
      agentId: fixture.settler('Sam').id,
      role: 'building',
      time,
    });
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.failure.kind, 'TARGET_CHANGED');
      assert.deepEqual(second.failure.observed, { holders: [mira.id] });
    }
  });

  it('takes a second pair of hands for a large shortfall', () => {
    const fixture = firstSettlement();
    const project = shelterProject(fixture);
    const time = ticksOf(fixture.time);

    for (const name of ['Elias', 'Nadia']) {
      const claimed = claimRole(fixture.store, {
        projectId: project.id,
        agentId: fixture.settler(name).id,
        role: 'gathering:wood',
        time,
      });
      assert.equal(claimed.ok, true, `${name} could not join the timber crew`);
    }
    const third = claimRole(fixture.store, {
      projectId: project.id,
      agentId: fixture.settler('Sam').id,
      role: 'gathering:wood',
      time,
    });
    assert.equal(third.ok, false, 'two is enough for sixty timbers');
  });

  it('refuses a role a project does not have', () => {
    const fixture = firstSettlement();
    const project = shelterProject(fixture);
    const nonsense = claimRole(fixture.store, {
      projectId: project.id,
      agentId: fixture.settler('Sam').id,
      role: 'gathering:iron',
      time: ticksOf(fixture.time),
    });
    assert.equal(nonsense.ok, false);
  });

  it('frees everything a settler had taken on when it stands down', () => {
    const fixture = firstSettlement();
    const project = shelterProject(fixture);
    const sam = fixture.settler('Sam');
    claimRole(fixture.store, {
      projectId: project.id,
      agentId: sam.id,
      role: 'gathering:stone',
      time: ticksOf(fixture.time),
    });

    assert.equal(releaseClaimsBy(fixture.store, sam.id, 1_500), 1);
    assert.equal(fixture.store.projects.claimsFor(project.id).length, 0);
  });
});

describe('paying for shared work', () => {
  it('accumulates contributions from several settlers and completes once', () => {
    const fixture = firstSettlement();
    const project = shelterProject(fixture);
    const time = ticksOf(fixture.time);
    const price = costOf('small_shelter');

    const mira = fixture.settler('Mira');
    const elias = fixture.settler('Elias');
    const sam = fixture.settler('Sam');

    // Each settler gathered a part of it. Only what they carry can be given.
    fixture.store.ledger.credit(agentOwner(elias.id), { wood: 40 });
    fixture.store.ledger.credit(agentOwner(mira.id), { wood: (price.wood ?? 0) - 40 });
    fixture.store.ledger.credit(agentOwner(sam.id), { stone: price.stone ?? 0 });

    const first = contribute(fixture.store, { projectId: project.id, agentId: elias.id, time });
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.deepEqual(first.value.applied, { wood: 40 });
      assert.ok(first.value.progress.fraction > 0 && first.value.progress.fraction < 1);
      assert.equal(first.value.progress.funded, false);
    }

    const second = contribute(fixture.store, { projectId: project.id, agentId: sam.id, time });
    assert.equal(second.ok, true);
    if (second.ok) assert.deepEqual(second.value.applied, { stone: price.stone });

    const third = contribute(fixture.store, { projectId: project.id, agentId: mira.id, time });
    assert.equal(third.ok, true);
    if (third.ok) {
      assert.equal(third.value.progress.funded, true);
      assert.deepEqual(third.value.progress.shortfall, {});
    }

    // The resources really moved: the settlers are empty, the settlement holds it.
    assert.deepEqual(fixture.store.ledger.balance(agentOwner(elias.id)), { food: 4 });
    assert.deepEqual(fixture.store.ledger.balance(settlementOwner(fixture.settlementId)), price);
    assert.equal(fixture.store.events.query({ types: ['resource_deposited'] }).length, 3);

    // Nothing more is wanted, and offering costs nothing.
    fixture.store.ledger.credit(agentOwner(elias.id), { wood: 10 });
    const surplus = contribute(fixture.store, { projectId: project.id, agentId: elias.id, time });
    assert.equal(surplus.ok, false);
    if (!surplus.ok) assert.equal(surplus.failure.kind, 'BAD_ARGS');

    // The structure is built and verified; the project closes on that evidence.
    const structure = buildStructure(fixture, {
      blueprint: 'small_shelter',
      builders: [mira.id, elias.id, sam.id],
    });
    const closed = completeProjectsFor(fixture.store, structure, time);
    assert.deepEqual(closed.map((completed) => completed.id), [project.id]);

    const stored = fixture.store.projects.find(project.id);
    assert.equal(stored?.state, 'completed');
    assert.equal(stored?.structureId, structure.id);
    assert.equal(fixture.store.projects.claimsFor(project.id).length, 0);

    // Completing again is refused, so the chronicle cannot report two openings.
    const again = completeProject(fixture.store, { projectId: project.id, time });
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.failure.kind, 'TARGET_CHANGED');
    assert.equal(fixture.store.events.query({ types: ['project_completed'] }).length, 1);
  });

  it('takes only what the project still needs, and only what the settler has', () => {
    const fixture = firstSettlement();
    const project = shelterProject(fixture);
    const elias = fixture.settler('Elias');
    // More timber than the shelter wants, and no stone at all.
    fixture.store.ledger.credit(agentOwner(elias.id), { wood: 500 });

    const given = contribute(fixture.store, {
      projectId: project.id,
      agentId: elias.id,
      time: ticksOf(fixture.time),
    });
    assert.equal(given.ok, true);
    if (given.ok) assert.deepEqual(given.value.applied, { wood: costOf('small_shelter').wood });
    assert.equal(
      fixture.store.ledger.quantity(agentOwner(elias.id), 'wood'),
      500 - (costOf('small_shelter').wood ?? 0),
    );
  });

  it('lets the builder draw the materials the others gathered', () => {
    const fixture = firstSettlement();
    const project = shelterProject(fixture);
    const time = ticksOf(fixture.time);
    const mira = fixture.settler('Mira');
    fixture.store.ledger.credit(settlementOwner(fixture.settlementId), costOf('small_shelter'));

    const drawn = withdrawForBuild(fixture.store, { projectId: project.id, agentId: mira.id, time });
    assert.equal(drawn.ok, true);
    if (drawn.ok) assert.deepEqual(drawn.value, costOf('small_shelter'));

    // The builder can now pay for the build, and the store is empty again.
    assert.equal(fixture.store.ledger.canAfford(agentOwner(mira.id), costOf('small_shelter')), true);
    assert.deepEqual(fixture.store.ledger.balance(settlementOwner(fixture.settlementId)), {});
    // And the withdrawal is explained by an event, like every other ledger move.
    assert.equal(fixture.store.events.query({ types: ['resource_withdrawn'] }).length, 1);
  });

  it('refuses to hand out materials the shared store does not have', () => {
    const fixture = firstSettlement();
    const project = shelterProject(fixture);
    const drawn = withdrawForBuild(fixture.store, {
      projectId: project.id,
      agentId: fixture.settler('Mira').id,
      time: ticksOf(fixture.time),
    });

    assert.equal(drawn.ok, false);
    if (!drawn.ok) assert.equal(drawn.failure.kind, 'INSUFFICIENT_RESOURCES');
    assert.equal(fixture.store.events.query({ types: ['resource_withdrawn'] }).length, 0);
  });

  it('draws nothing when the builder already carries the price', () => {
    const fixture = firstSettlement();
    const project = shelterProject(fixture);
    const mira = fixture.settler('Mira');
    fixture.store.ledger.credit(agentOwner(mira.id), costOf('small_shelter'));

    const drawn = withdrawForBuild(fixture.store, {
      projectId: project.id,
      agentId: mira.id,
      time: ticksOf(fixture.time),
    });
    assert.equal(drawn.ok, true);
    if (drawn.ok) assert.deepEqual(drawn.value, {});
  });

  it('closes a food store once it is full', () => {
    const fixture = firstSettlement();
    const project = createProject(fixture.store, {
      settlementId: fixture.settlementId,
      kind: stockpileKind('food'),
      time: ticksOf(fixture.time),
      amount: 30,
    });

    assert.deepEqual(completeFundedStockpiles(fixture.store, ticksOf(fixture.time)), []);
    fixture.store.ledger.credit(settlementOwner(fixture.settlementId), { food: 30 });
    const closed = completeFundedStockpiles(fixture.store, ticksOf(fixture.time));

    assert.deepEqual(closed.map((completed) => completed.id), [project.id]);
    assert.equal(fixture.store.projects.find(project.id)?.state, 'completed');
  });
});

describe('the project projection is only a projection', () => {
  it('rebuilds projects and claims from the event ledger alone', () => {
    const fixture = firstSettlement();
    const time = ticksOf(fixture.time);
    const mira = fixture.settler('Mira');
    const sam = fixture.settler('Sam');

    const shelter = shelterProject(fixture);
    const food = createProject(fixture.store, {
      settlementId: fixture.settlementId,
      kind: stockpileKind('food'),
      time,
      amount: 30,
    });
    claimRole(fixture.store, { projectId: shelter.id, agentId: mira.id, role: 'building', time });
    claimRole(fixture.store, {
      projectId: shelter.id,
      agentId: sam.id,
      role: 'gathering:stone',
      time,
    });

    const structure = buildStructure(fixture, {
      blueprint: 'small_shelter',
      builders: [mira.id],
      time: worldTime({ totalTicks: 3_000 }),
    });
    completeProjectsFor(fixture.store, structure, { day: 1, worldTicks: 3_000 });

    const before = fixture.store.projects.all();
    const claimsBefore = fixture.store.projects.claimsFor(food.id);

    const report = reconcileCivilization(fixture.store, { wipe: true });

    assert.equal(report.projects, 2);
    assert.equal(report.claims, 2);
    assert.deepEqual(report.gaps, []);
    assert.deepEqual(fixture.store.projects.all(), before);
    assert.deepEqual(fixture.store.projects.claimsFor(food.id), claimsBefore);
    // Including which structure the finished project produced, and that its
    // claims were let go.
    const rebuilt = fixture.store.projects.find(shelter.id);
    assert.equal(rebuilt?.state, 'completed');
    assert.equal(rebuilt?.structureId, structure.id);
    assert.equal(fixture.store.projects.claimsFor(shelter.id).length, 0);
  });

  it('reports what the ledger cannot reproduce instead of inventing it', () => {
    // A released claim has no event of its own, so a rebuild shows it live again.
    // Better a known gap than a projection that quietly disagrees with the ledger.
    const fixture = firstSettlement();
    const time = ticksOf(fixture.time);
    const project = shelterProject(fixture);
    const sam = fixture.settler('Sam');
    claimRole(fixture.store, {
      projectId: project.id,
      agentId: sam.id,
      role: 'gathering:stone',
      time,
    });
    releaseClaimsBy(fixture.store, sam.id, fixture.time.totalTicks + 10);
    assert.equal(fixture.store.projects.claimsFor(project.id).length, 0);

    reconcileCivilization(fixture.store, { wipe: true });
    assert.equal(
      fixture.store.projects.claimsFor(project.id).length,
      1,
      'the rebuild shows the claim, because the ledger never recorded it ending',
    );
  });
});
