/**
 * Division of labour.
 *
 * The test that matters is the first one: five settlers, one shelter, and the
 * failure M1 left behind — everybody building their own. If the distribution
 * assertion there ever has to be loosened, the coordination model has regressed
 * and no amount of passing elsewhere makes up for it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Agent } from '../../src/agents/agent.ts';
import {
  applyRecommendation,
  asGoalChoice,
  chooseWork,
  coordinationContext,
  describeDivisionOfLabour,
  requestHelp,
  type WorkRecommendation,
} from '../../src/civilization/coordination.ts';
import { buildKind, createProject, stockpileKind } from '../../src/civilization/projects.ts';
import { costOf } from '../../src/civilization/blueprints.ts';
import { settlementOwner } from '../../src/persistence/repositories/ledger.ts';
import type { Store } from '../../src/persistence/store.ts';
import type { WorldTime } from '../../src/core/world.ts';
import { firstSettlement, ticksOf, worldTime, type Fixture } from './fixture.ts';

/** Every settler chooses in turn, announcing what it took on — which is the whole
 *  mechanism: the fourth settler decides with the first three's claims in view. */
function everyoneChooses(
  store: Store,
  agents: readonly Agent[],
  time: WorldTime,
): Map<string, WorkRecommendation> {
  const out = new Map<string, WorkRecommendation>();
  for (const agent of agents) {
    const recommendation = chooseWork(coordinationContext(store, agent, time));
    applyRecommendation(store, { agent, recommendation, time });
    out.set(agent.name, recommendation);
  }
  return out;
}

function openShelter(fixture: Fixture): void {
  createProject(fixture.store, {
    settlementId: fixture.settlementId,
    kind: buildKind('small_shelter'),
    time: ticksOf(fixture.time),
  });
}

describe('five settlers dividing one shelter between them', () => {
  it('sends exactly one settler to build it, and the rest to different work', () => {
    const fixture = firstSettlement();
    openShelter(fixture);

    const chosen = everyoneChooses(fixture.store, fixture.agents, fixture.time);
    const roles = [...chosen.values()].map((work) => work.role);

    // The failure this milestone exists to fix.
    assert.equal(
      roles.filter((role) => role === 'building').length,
      1,
      `expected one builder, got ${roles.join(', ')}`,
    );

    // The specific division, settler by settler: the Builder builds, the Miner
    // takes the masonry, the Forager and the Gatherer take the timber, and the
    // Explorer — whose skills fit none of it — goes and learns the land.
    assert.deepEqual(
      Object.fromEntries([...chosen].map(([name, work]) => [name, work.role])),
      {
        Arun: 'explore',
        Mira: 'building',
        Nadia: 'gathering:wood',
        Elias: 'gathering:wood',
        Sam: 'gathering:stone',
      },
    );

    assert.equal(new Set(roles).size, 4, 'four distinct kinds of work among five settlers');
  });

  it('has each settler doing work its own skills favour', () => {
    const fixture = firstSettlement();
    openShelter(fixture);
    const chosen = everyoneChooses(fixture.store, fixture.agents, fixture.time);

    assert.equal(chosen.get('Mira')?.goal, 'gather_resource');
    // The builder holds the build even before the materials exist — that claim is
    // what stops the other four starting a second shelter — and meanwhile fetches
    // what it is most short of.
    assert.equal(chosen.get('Mira')?.blueprint, 'small_shelter');
    assert.equal(chosen.get('Sam')?.resource, 'stone');
    assert.equal(chosen.get('Elias')?.resource, 'wood');
    assert.equal(chosen.get('Arun')?.goal, 'explore_region');
  });

  it('records who is doing what where everyone can read it', () => {
    const fixture = firstSettlement();
    openShelter(fixture);
    everyoneChooses(fixture.store, fixture.agents, fixture.time);

    const board = describeDivisionOfLabour(fixture.store);
    assert.equal(board.length, 3, board.join(' | '));
    assert.ok(board.some((line) => line.startsWith('building:')));
    assert.ok(board.some((line) => line.startsWith('gathering:stone:')));

    const claimed = fixture.store.events.query({ types: ['project_claimed'] });
    assert.equal(claimed.length, 4, 'the four settlers on the shelter each announced a role');
  });

  it('still sends only one builder when the shelter is already paid for', () => {
    const fixture = firstSettlement();
    openShelter(fixture);
    // Materials in the shared store, so nothing needs fetching and building is the
    // only role the project offers. Four settlers must find something else.
    fixture.store.ledger.credit(settlementOwner(fixture.settlementId), costOf('small_shelter'));

    const chosen = everyoneChooses(fixture.store, fixture.agents, fixture.time);
    const roles = [...chosen.values()].map((work) => work.role);

    assert.equal(roles.filter((role) => role === 'building').length, 1);
    assert.equal(chosen.get('Mira')?.role, 'building');
    assert.equal(chosen.get('Mira')?.goal, 'build_structure');
    assert.deepEqual(
      [...chosen].filter(([, work]) => work.kind === 'project').map(([name]) => name),
      ['Mira'],
    );
  });

  it('gives every settler a different role once food is also being stockpiled', () => {
    const fixture = firstSettlement();
    openShelter(fixture);
    createProject(fixture.store, {
      settlementId: fixture.settlementId,
      kind: stockpileKind('food'),
      time: ticksOf(fixture.time),
      amount: 30,
    });

    const chosen = everyoneChooses(fixture.store, fixture.agents, fixture.time);
    const roles = [...chosen.values()].map((work) => work.role);

    assert.equal(new Set(roles).size, 5, `expected five distinct roles, got ${roles.join(', ')}`);
    assert.equal(chosen.get('Nadia')?.role, 'gathering:food', 'the Forager takes the food');
    assert.equal(chosen.get('Nadia')?.goal, 'find_food');
  });
});

describe('choosing work', () => {
  it('prefers a role nobody has taken to one already crowded', () => {
    const fixture = firstSettlement();
    openShelter(fixture);
    const mira = fixture.settler('Mira');

    const beforeAnyone = chooseWork(coordinationContext(fixture.store, mira, fixture.time));
    assert.equal(beforeAnyone.role, 'building');

    // Someone else takes the build; Mira has to want something else next time.
    applyRecommendation(fixture.store, {
      agent: fixture.settler('Elias'),
      recommendation: beforeAnyone,
      time: fixture.time,
    });
    const afterwards = chooseWork(coordinationContext(fixture.store, mira, fixture.time));
    assert.notEqual(afterwards.role, 'building');
  });

  it('keeps a settler on the role it announced rather than reconsidering every tick', () => {
    const fixture = firstSettlement();
    openShelter(fixture);
    const sam = fixture.settler('Sam');

    const first = chooseWork(coordinationContext(fixture.store, sam, fixture.time));
    applyRecommendation(fixture.store, { agent: sam, recommendation: first, time: fixture.time });

    const later = worldTime({ totalTicks: 2_400 });
    const second = chooseWork(coordinationContext(fixture.store, sam, later));
    assert.equal(second.role, first.role);
    assert.ok(second.score > first.score, 'continuing what you announced is worth something');
  });

  it('falls back to solo work when nothing open suits the settler', () => {
    const fixture = firstSettlement();
    // No projects at all: there is no shared work to claim.
    const arun = fixture.settler('Arun');
    const work = chooseWork(coordinationContext(fixture.store, arun, fixture.time));

    assert.equal(work.kind, 'solo');
    assert.equal(work.role, 'explore');
    assert.equal(work.projectId, null);
  });

  it('sends the settler who notices food to look for it when the store is bare', () => {
    const fixture = firstSettlement();
    const nadia = fixture.settler('Nadia');
    // Starving, and nothing to claim.
    const hungry: Agent = { ...nadia, needs: { ...nadia.needs, food: 0.05 } };
    const work = chooseWork(coordinationContext(fixture.store, hungry, fixture.time));

    assert.equal(work.role, 'forage');
    assert.equal(work.goal, 'find_food');
  });

  it('pulls the cooperative toward a request for help and leaves the heads-down working', () => {
    const fixture = firstSettlement();
    openShelter(fixture);
    const mira = fixture.settler('Mira');
    // Mira has the build and is short of timber, so she asks the settlement.
    applyRecommendation(fixture.store, {
      agent: mira,
      recommendation: chooseWork(coordinationContext(fixture.store, mira, fixture.time)),
      time: fixture.time,
    });
    requestHelp(fixture.store, {
      agent: mira,
      need: 'timber',
      detail: 'the shelter is short of timber',
      time: fixture.time,
    });

    const asked = worldTime({ totalTicks: fixture.time.totalTicks + 100 });
    // Nadia is the most cooperative settler; Sam the least.
    const nadia = chooseWork(coordinationContext(fixture.store, fixture.settler('Nadia'), asked));
    const sam = chooseWork(coordinationContext(fixture.store, fixture.settler('Sam'), asked));

    assert.equal(nadia.role, 'assist');
    assert.equal(nadia.targetAgentId, fixture.settler('Mira').id);
    assert.notEqual(sam.role, 'assist');
  });

  it('ignores a request for help that has gone stale', () => {
    const fixture = firstSettlement();
    requestHelp(fixture.store, {
      agent: fixture.settler('Mira'),
      need: 'timber',
      detail: 'the shelter is short of timber',
      time: fixture.time,
    });

    const muchLater = worldTime({ totalTicks: fixture.time.totalTicks + 24_000, day: 2 });
    const nadia = chooseWork(coordinationContext(fixture.store, fixture.settler('Nadia'), muchLater));
    assert.notEqual(nadia.role, 'assist');
  });

  it('is deterministic: the same board produces the same choice', () => {
    const fixture = firstSettlement();
    openShelter(fixture);
    const elias = fixture.settler('Elias');

    const first = chooseWork(coordinationContext(fixture.store, elias, fixture.time));
    const second = chooseWork(coordinationContext(fixture.store, elias, fixture.time));
    assert.deepEqual(first, second);
  });

  it('explains itself with the alternatives it weighed', () => {
    const fixture = firstSettlement();
    openShelter(fixture);
    const work = chooseWork(
      coordinationContext(fixture.store, fixture.settler('Sam'), fixture.time),
    );

    assert.ok(work.considered.length > 1, 'more than one option was weighed');
    assert.equal(work.considered[0]?.role, work.role, 'the chosen role scored highest');
    assert.match(work.reason, /stone/);
  });
});

describe('announcing and standing down', () => {
  it('frees the role for someone else when a settler turns to solo work', () => {
    const fixture = firstSettlement();
    openShelter(fixture);
    const mira = fixture.settler('Mira');

    const building = chooseWork(coordinationContext(fixture.store, mira, fixture.time));
    applyRecommendation(fixture.store, { agent: mira, recommendation: building, time: fixture.time });
    assert.equal(fixture.store.projects.claimsBy(mira.id).length, 1);

    applyRecommendation(fixture.store, {
      agent: mira,
      recommendation: { ...building, kind: 'solo', projectId: null, role: 'explore' },
      time: fixture.time,
    });
    assert.equal(fixture.store.projects.claimsBy(mira.id).length, 0);

    // And the build is available again.
    const elias = fixture.settler('Elias');
    const work = chooseWork(coordinationContext(fixture.store, elias, fixture.time));
    assert.ok(
      work.considered.some((option) => option.role === 'building'),
      'the vacated role is back on the board',
    );
  });

  it('holds one job per settler, dropping a role when it takes another', () => {
    const fixture = firstSettlement();
    openShelter(fixture);
    createProject(fixture.store, {
      settlementId: fixture.settlementId,
      kind: stockpileKind('food'),
      time: ticksOf(fixture.time),
      amount: 30,
    });
    const nadia = fixture.settler('Nadia');
    const shelter = fixture.store.projects.open().find((project) => project.blueprint !== null);
    const food = fixture.store.projects.open().find((project) => project.blueprint === null);
    assert.ok(shelter !== undefined && food !== undefined);

    const first = chooseWork(coordinationContext(fixture.store, nadia, fixture.time));
    applyRecommendation(fixture.store, {
      agent: nadia,
      recommendation: { ...first, kind: 'project', projectId: food.id, role: 'gathering:food' },
      time: fixture.time,
    });

    applyRecommendation(fixture.store, {
      agent: nadia,
      recommendation: { ...first, kind: 'project', projectId: shelter.id, role: 'gathering:wood' },
      time: fixture.time,
    });

    const claims = fixture.store.projects.claimsBy(nadia.id);
    assert.equal(claims.length, 1, 'a settler is only ever in one place');
    assert.equal(claims[0]?.projectId, shelter.id);
  });

  it('keeps the role it has when the one it reached for is taken', () => {
    const fixture = firstSettlement();
    openShelter(fixture);
    const sam = fixture.settler('Sam');
    const mira = fixture.settler('Mira');

    const stone = chooseWork(coordinationContext(fixture.store, sam, fixture.time));
    applyRecommendation(fixture.store, { agent: sam, recommendation: stone, time: fixture.time });
    const building = chooseWork(coordinationContext(fixture.store, mira, fixture.time));
    applyRecommendation(fixture.store, { agent: mira, recommendation: building, time: fixture.time });

    // Sam reaches for the build, which Mira has. He must still be on the stone.
    const refused = applyRecommendation(fixture.store, {
      agent: sam,
      recommendation: building,
      time: fixture.time,
    });
    assert.equal(refused.ok, false);
    assert.deepEqual(
      fixture.store.projects.claimsBy(sam.id).map((claim) => claim.role),
      [stone.role],
    );
  });

  it('refuses to announce a role another settler has already filled', () => {
    const fixture = firstSettlement();
    openShelter(fixture);
    const mira = fixture.settler('Mira');
    const building = chooseWork(coordinationContext(fixture.store, mira, fixture.time));
    applyRecommendation(fixture.store, { agent: mira, recommendation: building, time: fixture.time });

    const gatecrash = applyRecommendation(fixture.store, {
      agent: fixture.settler('Sam'),
      recommendation: building,
      time: fixture.time,
    });
    assert.equal(gatecrash.ok, false);
    if (!gatecrash.ok) assert.equal(gatecrash.failure.kind, 'TARGET_CHANGED');
  });
});

describe('a recommendation as a goal choice', () => {
  it('carries a goal, a priority in range, and a reason worth reading', () => {
    const fixture = firstSettlement();
    openShelter(fixture);
    const choice = asGoalChoice(
      chooseWork(coordinationContext(fixture.store, fixture.settler('Mira'), fixture.time)),
    );

    assert.equal(choice.goal, 'gather_resource');
    // The settlement's stake in a shelter, not Mira's enthusiasm for building.
    assert.equal(choice.priority, 0.9);
    assert.ok(choice.reason.length > 10);
    assert.equal(choice.blueprint, 'small_shelter');
  });

  it('gives solo work a priority the planner can compare with a need', () => {
    const fixture = firstSettlement();
    const choice = asGoalChoice(
      chooseWork(coordinationContext(fixture.store, fixture.settler('Arun'), fixture.time)),
    );
    assert.equal(choice.goal, 'explore_region');
    assert.ok(choice.priority < 0.5, 'exploring never outranks the settlement\'s work');
  });
});

describe('coordination stays out of other minds', () => {
  it('reads no per-agent private state', () => {
    // ADR-0007: coordination is built from public facts. A read of another
    // agent's memories or knowledge here would produce plausible behaviour while
    // quietly ending the simulation's honesty, so the absence is asserted.
    const forbidden = [
      'store.memories',
      'store.knowledge',
      'store.decisions',
      'store.goals',
      'store.plans',
      'store.messages',
    ];

    for (const file of ['coordination.ts', 'projects.ts', 'settlement.ts']) {
      const source = readFileSync(
        join(import.meta.dirname, '..', '..', 'src', 'civilization', file),
        'utf8',
      );
      for (const pattern of forbidden) {
        assert.ok(
          !source.includes(pattern),
          `${file} reads ${pattern} — civilization state is public facts only (ADR-0007)`,
        );
      }
    }
  });
});
