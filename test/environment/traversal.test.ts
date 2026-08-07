/**
 * The shared router.
 *
 * The tests that matter here are the two halves of one claim: an agent gets out
 * of a dead end, and it still cannot walk through a cliff. Local steering had the
 * second half and not the first, and a 400-round run showed what that costs —
 * three settlers stuck at one coordinate, 3175 identical failures.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { position } from '../../src/core/world.ts';
import { ARRIVAL_TOLERANCE, traverse, type HeightAt } from '../../src/environment/traversal.ts';

/** Flat ground at y=64, so a standing agent is at y=65. */
const FLAT: HeightAt = () => 64;

/** Flat ground with the given columns unwalkable. */
function withWalls(walls: (x: number, z: number) => boolean): HeightAt {
  return (x, z) => (walls(x, z) ? null : 64);
}

describe('routing over a height field', () => {
  it('crosses open ground', () => {
    const result = traverse(position(0, 65, 0), position(30, 65, 0), FLAT);
    assert.ok(result.arrived, 'flat ground is crossable');
    assert.equal(result.blockedAt, null);
    assert.ok(result.distance >= 28, `only travelled ${String(result.distance)}`);
  });

  it('treats standing on the destination as arrival', () => {
    const result = traverse(position(4, 65, 4), position(4, 65, 4), FLAT);
    assert.ok(result.arrived);
    assert.equal(result.distance, 0);
  });

  it('walks around a wall it cannot climb', () => {
    // A wall across the route with a gap far to one side.
    const heights = withWalls((x, z) => x === 10 && z > -20);
    const result = traverse(position(0, 65, 0), position(20, 65, 0), heights);

    assert.ok(result.arrived, 'a wall with a gap is a detour, not a barrier');
    assert.equal(result.blockedAt, null);
  });

  it('gets out of a dead end', () => {
    // A cove open only behind the agent: walls ahead, left and right. Local
    // steering considers only forward candidates, so this wedged it forever.
    const heights = withWalls(
      (x, z) => (x === 4 && z >= -4 && z <= 4) || (z === 4 && x >= 0 && x <= 4) || (z === -4 && x >= 0 && x <= 4),
    );
    const result = traverse(position(2, 65, 0), position(40, 65, 0), heights);

    assert.equal(result.blockedAt, null, 'a cove is not a wall');
    // It escapes by going back out of the cove's mouth and round the outside —
    // the one route open to it, and the one forward-only steering could never
    // take. Reaching the destination at all is the proof.
    assert.ok(result.arrived, `only got to ${JSON.stringify(result.to)}`);
    assert.ok(result.distance > 30, `barely moved: ${String(result.distance)}`);
  });

  it('makes partial progress toward an unreachable place, and says so', () => {
    const heights = withWalls((x) => x === 10);
    const result = traverse(position(0, 65, 0), position(40, 65, 0), heights);

    assert.ok(!result.arrived, 'an unreachable destination is not reached');
    assert.equal(result.blockedAt, null, 'stopping short is progress, not failure');
    assert.ok(result.distance > 5, `expected real progress, got ${String(result.distance)}`);
    assert.ok(result.to.x < 10, 'it stopped on the near side of the wall');
  });

  it('reports a blockage only when walled in on all sides', () => {
    const heights = withWalls((x, z) => Math.abs(x) <= 1 && Math.abs(z) <= 1 && !(x === 0 && z === 0));
    const result = traverse(position(0, 65, 0), position(20, 65, 0), heights);

    assert.notEqual(result.blockedAt, null, 'nowhere to step is the one real failure');
    assert.equal(result.distance, 0);
    assert.ok(!result.arrived);
  });

  it('will not climb more than a step, nor fall further than it survives', () => {
    // A sheer rise of 5 at x=6, everything else flat: impassable, no way round.
    const heights: HeightAt = (x) => (x >= 6 ? 69 : 64);
    const result = traverse(position(0, 65, 0), position(20, 70, 0), heights);

    assert.ok(!result.arrived, 'a 5-block rise is a cliff, not a step');
    assert.ok(result.to.x < 6, `climbed to x=${String(result.to.x)}`);
  });

  it('climbs a staircase one block at a time', () => {
    const heights: HeightAt = (x) => 64 + Math.max(0, Math.min(6, x));
    const result = traverse(position(0, 65, 0), position(10, 71, 0), heights);

    assert.ok(result.arrived, 'single-block steps are walkable');
    assert.equal(result.to.y, 71, 'and the agent ends up standing on top of them');
  });

  it('keeps each journey incremental', () => {
    const result = traverse(position(0, 65, 0), position(500, 65, 0), FLAT, { maxSteps: 20 });
    assert.ok(!result.arrived);
    assert.ok(result.distance <= 20 + ARRIVAL_TOLERANCE, `walked ${String(result.distance)} in one call`);
    assert.ok(result.distance >= 15, 'but it did cover the ground it was allowed');
  });

  it('routes the same way twice', () => {
    const heights = withWalls((x, z) => x === 12 && z > -8);
    const from = position(0, 65, 0);
    const to = position(30, 65, 3);
    const first = traverse(from, to, heights);
    const second = traverse(from, to, heights);
    assert.deepEqual(first, second, 'the same world must produce the same walk');
  });

  it('gives up on a maze rather than searching forever', () => {
    let reads = 0;
    const heights: HeightAt = (x, z) => {
      reads++;
      return x % 2 === 0 && z % 3 !== 0 ? null : 64;
    };
    const result = traverse(position(1, 65, 0), position(400, 65, 0), heights, { maxNodes: 500 });

    assert.ok(!result.arrived);
    assert.ok(reads < 50_000, `read ${String(reads)} columns — the budget is not being respected`);
  });
});
