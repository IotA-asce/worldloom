/**
 * Terrain-following movement, shared by every environment adapter.
 *
 * Neither environment has a pathfinder of its own — `minecraft-mcp`'s `move_to`
 * is velocity steering rather than routing (constraint C4). A straight line into
 * natural terrain is blocked almost immediately, which would make agents
 * effectively immobile on any hillside.
 *
 * So this is a bounded A* over the height field. Two properties matter more than
 * optimality:
 *
 *  - **It never wedges.** Local steering — step forward, sidestep if that is too
 *    steep — cannot leave a dead end, because every candidate it considers is
 *    forward. An agent that walks into a cove fails identically every tick
 *    forever, which a 400-round run showed happening to three settlers at once:
 *    3175 action failures at a single coordinate. A search that can step
 *    *sideways and back* gets out of the cove.
 *  - **It stays honest.** The search only crosses ground the height field says is
 *    walkable, with the same per-step climb limits a player has, so the agent
 *    walks around a cliff rather than through it (ADR-0003). When the
 *    destination is genuinely unreachable within the node budget, the agent
 *    walks as far toward it as it can and says it has not arrived — a real
 *    partial journey, never a teleport.
 *
 * The node budget is the cost control: an agent thinking about its next 60 blocks
 * of walking is cheap, and a pathological world cannot make it spin.
 */

import { horizontalDistance, type Position } from '../core/world.ts';

/**
 * Ground level at a column: the elevation an agent's feet would rest *on*.
 * Returns null where the column is unknown or unwalkable (water, void).
 *
 * `fromY` is the elevation of the walker taking the step, and it is not a hint —
 * a column can have more than one floor. Inside a building the topmost solid
 * block is the roof, so a lookup that ignored the walker's own level would tell
 * an agent standing in a hut that the ground beside it is four blocks up, and it
 * would be sealed in by its own roof. Asking "what could I stand on from here"
 * is what lets an agent walk out through a doorway.
 */
export type HeightAt = (x: number, z: number, fromY: number) => number | null;

export interface TraversalOptions {
  /** Blocks the agent can climb in one step. */
  readonly maxStepUp?: number;
  /** Blocks the agent can drop in one step without harm. */
  readonly maxStepDown?: number;
  /** How far the walk may stray beyond the straight line, in blocks. Bounds both
   *  the search and how much terrain an adapter has to read. */
  readonly searchMargin?: number;
  /** Columns the search may expand before giving up and walking its best find. */
  readonly maxNodes?: number;
  /** Blocks the agent may cover in one call, so movement stays incremental. */
  readonly maxSteps?: number;
}

export interface TraversalResult {
  /** Where the agent ended up, standing on the ground. */
  readonly to: Position;
  readonly distance: number;
  readonly arrived: boolean;
  /**
   * Set only when the agent could not take a single step in any direction —
   * genuinely walled in. A route that merely failed to reach the destination is
   * partial progress, not a blockage.
   */
  readonly blockedAt: Position | null;
}

const DEFAULTS = {
  // A Minecraft player steps up one block and drops several safely.
  maxStepUp: 1,
  maxStepDown: 4,
  searchMargin: 48,
  maxNodes: 6_000,
  maxSteps: 256,
} as const;

/** How close counts as arrival. */
export const ARRIVAL_TOLERANCE = 1.5;

/** The eight neighbours of a column, with the cost of entering each. */
const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

interface Node {
  readonly x: number;
  readonly z: number;
  /** Ground the agent stands on here. */
  readonly y: number;
  readonly cost: number;
  readonly heuristic: number;
  readonly parent: Node | null;
  readonly depth: number;
}

export function traverse(
  from: Position,
  to: Position,
  heightAt: HeightAt,
  options: TraversalOptions = {},
): TraversalResult {
  const maxStepUp = options.maxStepUp ?? DEFAULTS.maxStepUp;
  const maxStepDown = options.maxStepDown ?? DEFAULTS.maxStepDown;
  const searchMargin = options.searchMargin ?? DEFAULTS.searchMargin;
  const maxNodes = options.maxNodes ?? DEFAULTS.maxNodes;
  const maxSteps = options.maxSteps ?? DEFAULTS.maxSteps;

  if (horizontalDistance(from, to) <= ARRIVAL_TOLERANCE) {
    return { to: from, distance: 0, arrived: true, blockedAt: null };
  }

  const start: Node = {
    x: Math.round(from.x),
    z: Math.round(from.z),
    y: from.y,
    cost: 0,
    heuristic: horizontalDistance(from, to),
    parent: null,
    depth: 0,
  };

  // Nothing outside this box is worth reading, let alone walking. It bounds the
  // survey an adapter has to perform as much as it bounds the search.
  const bounds = {
    minX: Math.min(start.x, Math.round(to.x)) - searchMargin,
    maxX: Math.max(start.x, Math.round(to.x)) + searchMargin,
    minZ: Math.min(start.z, Math.round(to.z)) - searchMargin,
    maxZ: Math.max(start.z, Math.round(to.z)) + searchMargin,
  };

  const open = new NodeHeap();
  const best = new Map<string, number>();
  open.push(start);
  best.set(key(start.x, start.z), 0);

  /** The closest the search ever got, walked when the goal proves unreachable. */
  let closest = start;
  let expanded = 0;
  let steppedAnywhere = false;

  while (!open.isEmpty() && expanded < maxNodes) {
    const current = open.pop()!;
    expanded++;

    if (current.heuristic < closest.heuristic) closest = current;
    if (current.heuristic <= ARRIVAL_TOLERANCE) {
      return walk(from, current, maxSteps, to);
    }

    for (const [dx, dz, stepCost] of NEIGHBOURS) {
      const nx = current.x + dx;
      const nz = current.z + dz;
      if (nx < bounds.minX || nx > bounds.maxX || nz < bounds.minZ || nz > bounds.maxZ) continue;

      const ground = heightAt(nx, nz, current.y);
      if (ground === null) continue;

      const standing = ground + 1;
      const climb = standing - current.y;
      if (climb > maxStepUp || climb < -maxStepDown) continue;

      // No cutting a diagonal across a corner the agent could not walk through
      // orthogonally — that would be stepping through the cliff, not around it.
      if (dx !== 0 && dz !== 0 && !cornerOpen(current, dx, dz, heightAt, maxStepUp, maxStepDown)) {
        continue;
      }

      steppedAnywhere = true;
      const cost = current.cost + stepCost + Math.abs(climb) * 0.5;
      const at = key(nx, nz);
      const known = best.get(at);
      if (known !== undefined && known <= cost) continue;

      best.set(at, cost);
      open.push({
        x: nx,
        z: nz,
        y: standing,
        cost,
        heuristic: horizontalDistance({ x: nx, y: standing, z: nz }, to),
        parent: current,
        depth: current.depth + 1,
      });
    }
  }

  if (!steppedAnywhere) {
    // Genuinely walled in on all eight sides. This is the only case that is a
    // failure rather than a short journey.
    return { to: from, distance: 0, arrived: false, blockedAt: aheadOf(from, to) };
  }

  // The destination is unreachable, or costs more search than it is worth. Walk
  // as far toward it as the search did manage, and report honestly.
  return walk(from, closest, maxSteps, to);
}

/**
 * Follow a node's parents back to the start and walk at most `maxSteps` of it.
 *
 * Capping the walk is what keeps movement incremental: an agent covers ground
 * over several ticks rather than crossing the map inside one action.
 */
function walk(from: Position, target: Node, maxSteps: number, to: Position): TraversalResult {
  const path: Node[] = [];
  for (let node: Node | null = target; node !== null && node.parent !== null; node = node.parent) {
    path.push(node);
  }
  path.reverse();

  if (path.length === 0) {
    return { to: from, distance: 0, arrived: false, blockedAt: null };
  }

  const reached = path[Math.min(path.length, maxSteps) - 1]!;
  const landed: Position = { x: reached.x, y: reached.y, z: reached.z };
  return {
    to: landed,
    distance: horizontalDistance(from, landed),
    arrived: horizontalDistance(landed, to) <= ARRIVAL_TOLERANCE,
    blockedAt: null,
  };
}

/** Is at least one of the two columns flanking a diagonal step walkable from here? */
function cornerOpen(
  current: Node,
  dx: number,
  dz: number,
  heightAt: HeightAt,
  maxStepUp: number,
  maxStepDown: number,
): boolean {
  for (const [ax, az] of [
    [dx, 0],
    [0, dz],
  ] as const) {
    const ground = heightAt(current.x + ax, current.z + az, current.y);
    if (ground === null) continue;
    const climb = ground + 1 - current.y;
    if (climb <= maxStepUp && climb >= -maxStepDown) return true;
  }
  return false;
}

/** The block the agent was trying to enter, for the failure's detail. */
function aheadOf(current: Position, to: Position): Position {
  const dx = to.x - current.x;
  const dz = to.z - current.z;
  const length = Math.max(1e-6, Math.hypot(dx, dz));
  return {
    x: Math.round(current.x + dx / length),
    y: current.y,
    z: Math.round(current.z + dz / length),
  };
}

function key(x: number, z: number): string {
  return `${String(x)},${String(z)}`;
}

/**
 * A binary heap ordered by `cost + heuristic`, ties broken by insertion order.
 *
 * Insertion-order tie-breaking is not a detail: it is what makes the same world
 * and the same seed produce the same walk, which is what makes a run
 * reproducible.
 */
class NodeHeap {
  private readonly items: { node: Node; f: number; seq: number }[] = [];
  private counter = 0;

  push(node: Node): void {
    this.items.push({ node, f: node.cost + node.heuristic, seq: this.counter++ });
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.less(index, parent)) {
        this.swap(index, parent);
        index = parent;
      } else break;
    }
  }

  pop(): Node | null {
    if (this.items.length === 0) return null;
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.items.length && this.less(left, smallest)) smallest = left;
        if (right < this.items.length && this.less(right, smallest)) smallest = right;
        if (smallest === index) break;
        this.swap(index, smallest);
        index = smallest;
      }
    }
    return top.node;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  private less(a: number, b: number): boolean {
    const left = this.items[a]!;
    const right = this.items[b]!;
    return left.f < right.f || (left.f === right.f && left.seq < right.seq);
  }

  private swap(a: number, b: number): void {
    const temp = this.items[a]!;
    this.items[a] = this.items[b]!;
    this.items[b] = temp;
  }
}
