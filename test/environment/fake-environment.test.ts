/**
 * FakeEnvironment tests.
 *
 * These matter more than usual: every other test in the suite runs against this
 * environment, so its behaviour is the definition of "the simulation works".
 * The assertions here are about *scarcity and verification* — that resources
 * must actually exist to be gathered, and that writes are checked.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentView } from '../../src/agents/agent.ts';
import type { AgentId } from '../../src/core/ids.ts';
import { expect } from '../../src/core/result.ts';
import { position, regionVolume, type Blueprint, type Region } from '../../src/core/world.ts';
import { FakeEnvironment, flatEnvironment } from '../../src/environment/fake/environment.ts';

function agentAt(x: number, y: number, z: number): AgentView {
  return { id: 'agent_000001' as AgentId, name: 'Mira', position: position(x, y, z) };
}

async function connected(env: FakeEnvironment): Promise<FakeEnvironment> {
  expect(await env.connect(), 'connect');
  return env;
}

/** Where an agent actually stands at (x, z) — one block above the surface.
 *  Derived from the world rather than assumed, so terrain tuning can't
 *  invalidate a movement test by leaving the agent buried. */
function standingAt(env: FakeEnvironment, x: number, z: number): AgentView {
  return agentAt(x, env.world.surfaceHeight(x, z) + 1, z);
}

const HUT: Blueprint = {
  name: 'hut',
  size: { width: 3, height: 3, depth: 3 },
  blocks: (() => {
    const blocks = [];
    for (let dx = 0; dx < 3; dx++) {
      for (let dz = 0; dz < 3; dz++) {
        blocks.push({ dx, dy: 0, dz, material: 'masonry' as const });
        blocks.push({ dx, dy: 3, dz, material: 'timber' as const });
      }
    }
    for (let dy = 1; dy <= 2; dy++) {
      for (const [dx, dz] of [[0, 0], [1, 0], [2, 0], [0, 2], [1, 2], [2, 2], [0, 1], [2, 1]] as const) {
        blocks.push({ dx, dy, dz, material: 'timber' as const });
      }
    }
    return blocks;
  })(),
};

describe('lifecycle', () => {
  it('refuses every operation before connect', async () => {
    const env = new FakeEnvironment();
    const result = await env.worldTime();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.kind, 'ENVIRONMENT_DISCONNECTED');
  });

  it('describes itself as a logical-embodiment environment', async () => {
    const env = await connected(new FakeEnvironment());
    const info = env.describe();
    assert.equal(info.kind, 'fake');
    assert.equal(info.embodiment, 'logical');
  });
});

describe('terrain and observation', () => {
  it('generates the same world from the same seed', async () => {
    const a = await connected(new FakeEnvironment({ seed: 7 }));
    const b = await connected(new FakeEnvironment({ seed: 7 }));
    const c = await connected(new FakeEnvironment({ seed: 8 }));

    const heights = (env: FakeEnvironment): number[] =>
      Array.from({ length: 20 }, (_, i) => env.world.terrainHeight(i * 5, i * 3));

    assert.deepEqual(heights(a), heights(b));
    assert.notDeepEqual(heights(a), heights(c));
  });

  it('produces varied terrain, not a flat plane', async () => {
    const env = await connected(new FakeEnvironment({ seed: 3 }));
    const heights = new Set(
      Array.from({ length: 60 }, (_, i) => env.world.terrainHeight(i * 7, i * 11)),
    );
    assert.ok(heights.size > 3, `expected varied elevation, saw ${heights.size} distinct heights`);
  });

  it('surveys a region at the requested resolution', async () => {
    const env = await connected(new FakeEnvironment());
    const region: Region = { min: position(0, 0, 0), max: position(31, 200, 31) };
    const survey = expect(await env.surveyRegion(region, 4), 'survey');
    assert.equal(survey.resolution, 4);
    assert.equal(survey.cells.length, 8 * 8);
    for (const cell of survey.cells) {
      assert.ok(cell.y > 0 && cell.y < 200, `cell elevation ${cell.y} out of range`);
    }
  });

  it('refuses a survey larger than it will sample', async () => {
    const env = await connected(new FakeEnvironment());
    const huge: Region = { min: position(0, 0, 0), max: position(5000, 200, 5000) };
    const result = await env.surveyRegion(huge, 1);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'BAD_ARGS');
      assert.match(result.failure.detail, /exceeds/);
    }
  });

  it('reports normalised surfaces, never block ids', async () => {
    const env = await connected(new FakeEnvironment());
    const survey = expect(
      await env.surveyRegion({ min: position(0, 0, 0), max: position(40, 200, 40) }, 2),
      'survey',
    );
    const valid = new Set(['water', 'stone', 'soil', 'sand', 'vegetation', 'wood', 'snow', 'unknown']);
    for (const cell of survey.cells) {
      assert.ok(valid.has(cell.surface), `unexpected surface '${cell.surface}'`);
    }
  });

  it('observes only within the requested radius', async () => {
    const env = await connected(new FakeEnvironment());
    const observation = expect(await env.observe(agentAt(0, 70, 0), 16), 'observe');
    for (const cell of observation.terrain.cells) {
      assert.ok(Math.abs(cell.x) <= 16 && Math.abs(cell.z) <= 16, 'saw beyond the radius');
    }
    assert.ok(observation.visibleResources.length > 0, 'the world should offer something visible');
  });

  it('lets agents see each other once both have been observed', async () => {
    const env = await connected(new FakeEnvironment());
    const mira = agentAt(0, 70, 0);
    const elias: AgentView = { id: 'agent_000002' as AgentId, name: 'Elias', position: position(6, 70, 4) };

    expect(await env.presentAgent(elias), 'present');
    const observation = expect(await env.observe(mira, 16), 'observe');
    assert.deepEqual(observation.nearbyAgents.map((a) => a.name), ['Elias']);
  });

  it('does not report an agent to itself', async () => {
    const env = await connected(new FakeEnvironment());
    const mira = agentAt(0, 70, 0);
    expect(await env.presentAgent(mira), 'present');
    const observation = expect(await env.observe(mira, 16), 'observe');
    assert.equal(observation.nearbyAgents.length, 0);
  });

  it('reports hostiles only at night', async () => {
    const env = await connected(new FakeEnvironment({ seed: 1 }));
    const agent = agentAt(0, 70, 0);

    env.setTicks(6_000); // noon
    const byDay = expect(await env.observe(agent, 16), 'day observe');
    assert.equal(byDay.nearbyEntities.length, 0);
    assert.equal(byDay.time.isDay, true);

    env.setTicks(18_000); // midnight
    const byNight = expect(await env.observe(agent, 16), 'night observe');
    assert.equal(byNight.time.isDay, false);
    // Position-dependent, so assert the mechanism rather than a specific count.
    assert.ok(byNight.nearbyEntities.every((entity) => entity.hostile));
  });
});

describe('movement is constrained by real terrain', () => {
  it('crosses flat ground', async () => {
    const env = await connected(flatEnvironment());
    const start = standingAt(env, 0, 0);
    const result = expect(await env.moveAgent(start, position(20, start.position.y, 0)), 'move');
    assert.ok(result.arrived, 'flat ground should be crossable');
    assert.ok(result.distance > 19);
  });

  it('treats a zero-length move as arrival, not an error', async () => {
    const env = await connected(flatEnvironment());
    const start = standingAt(env, 5, 5);
    const result = expect(await env.moveAgent(start, start.position), 'move');
    assert.ok(result.arrived);
    assert.equal(result.distance, 0);
  });

  it('refuses to walk through a wall it cannot climb', async () => {
    const env = await connected(flatEnvironment());
    const ground = env.world.terrainHeight(0, 0);
    // Build a 6-block wall across the route.
    for (let dy = 1; dy <= 6; dy++) {
      for (let z = -4; z <= 4; z++) {
        env.world.setBlock(position(5, ground + dy, z), {
          surface: 'stone',
          yields: 'stone',
          solid: true,
        });
      }
    }

    const start = agentAt(0, ground + 1, 0);
    const result = await env.moveAgent(start, position(20, ground + 1, 0));
    // Either refused outright or stopped short — never teleported through.
    if (result.ok) {
      assert.ok(!result.value.arrived, 'the agent must not pass the wall');
      assert.ok(result.value.to.x < 5, `stopped at x=${result.value.to.x}, past the wall`);
    } else {
      assert.equal(result.failure.kind, 'PATH_BLOCKED');
    }
  });

  it('reports a partial move as success so the planner can continue', async () => {
    const env = await connected(flatEnvironment());
    const ground = env.world.terrainHeight(0, 0);
    for (let dy = 1; dy <= 6; dy++) {
      for (let z = -4; z <= 4; z++) {
        env.world.setBlock(position(12, ground + dy, z), { surface: 'stone', yields: 'stone', solid: true });
      }
    }

    const result = expect(
      await env.moveAgent(agentAt(0, ground + 1, 0), position(30, ground + 1, 0)),
      'move',
    );
    assert.ok(!result.arrived);
    assert.ok(result.distance > 5, `expected real progress, got ${result.distance}`);
  });

  it('fails with PATH_BLOCKED when blocked immediately', async () => {
    const env = await connected(flatEnvironment());
    const ground = env.world.terrainHeight(0, 0);
    for (let dy = 1; dy <= 8; dy++) {
      for (let x = 1; x <= 3; x++) {
        for (let z = -3; z <= 3; z++) {
          env.world.setBlock(position(x, ground + dy, z), { surface: 'stone', yields: 'stone', solid: true });
        }
      }
    }
    const result = await env.moveAgent(agentAt(0, ground + 1, 0), position(10, ground + 1, 0));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'PATH_BLOCKED');
      // The failure must say where, so the agent can learn from it.
      assert.ok(result.failure.observed !== undefined);
    }
  });
});

describe('harvesting credits only what was verified', () => {
  it('gathers wood that genuinely exists', async () => {
    const env = await connected(new FakeEnvironment({ seed: 5 }));
    // Find a forest rather than assuming one is at the origin.
    let region: Region | null = null;
    for (let cx = 0; cx < 400 && region === null; cx += 32) {
      const candidate: Region = { min: position(cx, 40, 0), max: position(cx + 31, 120, 31) };
      const probe = await env.harvest(agentAt(cx, 70, 0), candidate, 'wood', 8);
      if (probe.ok) {
        assert.ok(probe.value.blocksRemoved > 0);
        assert.ok((probe.value.gained.wood ?? 0) > 0);
        assert.ok(probe.value.verifiedSample > 0, 'a harvest must be verified');
        region = candidate;
      }
    }
    assert.ok(region !== null, 'the generated world should contain some forest');
  });

  it('fails honestly when the resource is not there', async () => {
    const env = await connected(flatEnvironment());
    // Deep underground where no iron is generated in a flat world's shallow band.
    const barren: Region = { min: position(0, 55, 0), max: position(8, 57, 8) };
    const result = await env.harvest(agentAt(0, 70, 0), barren, 'iron', 10);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'RESOURCE_UNAVAILABLE');
      assert.equal(result.failure.retryable, false, 'looking again will not conjure iron');
      assert.ok(result.failure.observed !== undefined, 'the agent should learn the region is barren');
    }
  });

  it('never credits more than the world contained', async () => {
    const env = await connected(flatEnvironment());
    const ground = env.world.terrainHeight(0, 0);
    // Place exactly three stone blocks in an otherwise cleared box.
    const region: Region = { min: position(0, ground + 5, 0), max: position(9, ground + 7, 9) };
    for (const p of [position(1, ground + 5, 1), position(2, ground + 5, 2), position(3, ground + 5, 3)]) {
      env.world.setBlock(p, { surface: 'stone', yields: 'stone', solid: true });
    }

    const result = expect(await env.harvest(agentAt(0, ground + 1, 0), region, 'stone', 100), 'harvest');
    // Asking for 100 yields 3, because 3 is what existed (ADR-0004).
    assert.equal(result.gained.stone, 3);
    assert.equal(result.blocksRemoved, 3);
  });

  it('respects the requested maximum', async () => {
    const env = await connected(flatEnvironment());
    const ground = env.world.terrainHeight(0, 0);
    const region: Region = { min: position(0, ground + 5, 0), max: position(9, ground + 7, 9) };
    for (let i = 0; i < 20; i++) {
      env.world.setBlock(position(i % 9, ground + 5, Math.floor(i / 9)), {
        surface: 'stone',
        yields: 'stone',
        solid: true,
      });
    }

    const result = expect(await env.harvest(agentAt(0, ground + 1, 0), region, 'stone', 5), 'harvest');
    assert.ok((result.gained.stone ?? 0) <= 5, `credited ${String(result.gained.stone)}, asked for 5`);
  });

  it('actually removes the blocks from the world', async () => {
    const env = await connected(flatEnvironment());
    const ground = env.world.terrainHeight(0, 0);
    const target = position(4, ground + 5, 4);
    env.world.setBlock(target, { surface: 'stone', yields: 'stone', solid: true });

    const region: Region = { min: position(0, ground + 5, 0), max: position(9, ground + 6, 9) };
    expect(await env.harvest(agentAt(0, ground + 1, 0), region, 'stone', 10), 'harvest');

    const after = expect(await env.inspect(target), 'inspect');
    assert.equal(after.solid, false, 'the harvested block should be gone from the world');
  });

  it('rejects a nonsensical request', async () => {
    const env = await connected(flatEnvironment());
    const region: Region = { min: position(0, 60, 0), max: position(4, 64, 4) };
    const result = await env.harvest(agentAt(0, 70, 0), region, 'wood', 0);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.kind, 'BAD_ARGS');
  });

  it('refuses an unreasonably large region rather than hanging', async () => {
    const env = await connected(flatEnvironment());
    const vast: Region = { min: position(0, 0, 0), max: position(200, 200, 200) };
    assert.ok(regionVolume(vast) > 200_000);
    const result = await env.harvest(agentAt(0, 70, 0), vast, 'stone', 10);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.kind, 'BAD_ARGS');
  });
});

describe('building is verified after the fact', () => {
  it('builds a hut and confirms it stands', async () => {
    const env = await connected(flatEnvironment());
    const origin = position(0, env.world.terrainHeight(0, 0) + 1, 0);
    const agent = agentAt(0, origin.y, 0);

    const result = expect(await env.build(agent, HUT, origin), 'build');
    assert.ok(result.complete, 'a freshly built hut should verify');
    assert.equal(result.blocksFailed, 0);
    assert.ok(result.verifiedSample > 0);

    // Spot-check the world directly, not just the report.
    const corner = expect(await env.inspect(origin), 'inspect');
    assert.equal(corner.surface, 'stone');
  });

  it('reports the region it occupies, for reservation bookkeeping', async () => {
    const env = await connected(flatEnvironment());
    const origin = position(10, 70, 10);
    const result = expect(await env.build(agentAt(10, 70, 10), HUT, origin), 'build');
    assert.deepEqual(result.region.min, origin);
    assert.deepEqual(result.region.max, position(12, 73, 12));
  });

  it('notices when a structure has been damaged since it was built', async () => {
    const env = await connected(flatEnvironment());
    const origin = position(0, env.world.terrainHeight(0, 0) + 1, 0);
    expect(await env.build(agentAt(0, origin.y, 0), HUT, origin), 'build');

    // Tear most of it down.
    for (const block of HUT.blocks) {
      if (block.material === 'timber') {
        env.world.removeBlock(position(origin.x + block.dx, origin.y + block.dy, origin.z + block.dz));
      }
    }

    const verified = expect(await env.verifyBuild(HUT, origin), 'verify');
    assert.ok(!verified.complete, 'a gutted structure must not verify as complete');
    assert.ok(verified.blocksFailed > 0);
  });

  it('refuses to build outside the world', async () => {
    const env = await connected(flatEnvironment());
    const result = await env.build(agentAt(0, 70, 0), HUT, position(0, 199, 0));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'TARGET_CHANGED');
      assert.equal(result.failure.retryable, false);
    }
  });

  it('clears a site and confirms it emptied', async () => {
    const env = await connected(new FakeEnvironment({ seed: 2 }));
    const ground = env.world.terrainHeight(0, 0);
    const region: Region = { min: position(0, ground - 2, 0), max: position(5, ground + 2, 5) };

    const cleared = expect(await env.clearRegion(agentAt(0, ground + 1, 0), region), 'clear');
    assert.ok(cleared.complete);
    assert.ok(cleared.blocksPlaced > 0, 'there was terrain to remove');

    const middle = expect(await env.inspect(position(2, ground, 2)), 'inspect');
    assert.equal(middle.solid, false);
  });

  it('treats an all-empty blueprint as trivially complete', async () => {
    const env = await connected(flatEnvironment());
    const empty: Blueprint = {
      name: 'nothing',
      size: { width: 1, height: 1, depth: 1 },
      blocks: [{ dx: 0, dy: 0, dz: 0, material: 'empty' }],
    };
    const result = expect(await env.build(agentAt(0, 70, 0), empty, position(0, 70, 0)), 'build');
    assert.ok(result.complete);
    assert.equal(result.blocksPlaced, 0);
  });
});

describe('shelter detection', () => {
  it('reports open ground as unsheltered', async () => {
    const env = await connected(flatEnvironment());
    const ground = env.world.terrainHeight(0, 0);
    const observation = expect(await env.observe(agentAt(0, ground + 1, 0), 8), 'observe');
    assert.equal(observation.sheltered, false);
  });

  it('reports the inside of a built hut as sheltered', async () => {
    const env = await connected(flatEnvironment());
    const ground = env.world.terrainHeight(0, 0);
    const origin = position(0, ground + 1, 0);
    expect(await env.build(agentAt(0, origin.y, 0), HUT, origin), 'build');

    // Stand in the middle of the hut's floor.
    const inside = agentAt(origin.x + 1, origin.y + 1, origin.z + 1);
    const observation = expect(await env.observe(inside, 8), 'observe');
    assert.equal(observation.sheltered, true, 'a roofed, walled structure should count as shelter');
  });
});
