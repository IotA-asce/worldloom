/**
 * `FakeEnvironment` — the Environment port over an in-memory voxel world.
 *
 * Every test runs against this, which is why it implements real behaviour rather
 * than stubs: harvesting genuinely removes blocks and verifies them, building
 * genuinely fails when the ledger's blocks can't be placed, and movement is
 * genuinely refused by a cliff. Bugs found here are bugs that would have
 * happened in Minecraft.
 */

import type { AgentView } from '../../agents/agent.ts';
import { fail, ok, type Result } from '../../core/result.ts';
import {
  blueprintRegion,
  distance,
  MATERIAL_COST,
  regionPositions,
  regionVolume,
  type Blueprint,
  type BuildMaterial,
  type Position,
  type Region,
  type ResourceBundle,
  type ResourceKind,
  type SurveyCell,
  type TerrainSurvey,
  type WorldTime,
} from '../../core/world.ts';
import { phaseOf, isDaylight, TICKS_PER_DAY } from '../../persistence/repositories/simulation.ts';
import {
  boundVisibleResources,
  BUILD_COMPLETION_THRESHOLD,
  verificationSampleSize,
  type BlockInfo,
  type BuildResult,
  type Environment,
  type EnvironmentInfo,
  type HarvestResult,
  type MoveResult,
  type NearbyAgent,
  type NearbyEntity,
  type Observation,
  type VisibleResource,
} from '../port.ts';
import { traverse } from '../traversal.ts';
import { AIR, FakeWorld, MAX_ELEVATION, MIN_ELEVATION, type FakeBlock } from './world.ts';

/** Placed materials, mirroring what the Minecraft adapter maps to blocks. */
const MATERIAL_BLOCKS: Readonly<Record<BuildMaterial, FakeBlock>> = {
  timber: { surface: 'wood', yields: 'wood', solid: true },
  masonry: { surface: 'stone', yields: 'stone', solid: true },
  packed_soil: { surface: 'soil', yields: 'soil', solid: true },
  thatch: { surface: 'vegetation', yields: 'fiber', solid: true },
  glass: { surface: 'unknown', yields: 'sand', solid: true },
  light: { surface: 'unknown', yields: null, solid: false },
  door: { surface: 'wood', yields: 'wood', solid: false },
  empty: AIR,
};

/**
 * How far below a column's surface an agent can tell what is there.
 *
 * Deep enough to include the rock under the soil — which is common knowledge,
 * not clairvoyance — and shallow enough that ore must still be dug for.
 */
const PERCEPTION_DEPTH = 6;
/** The same limits the router uses, so what it plans is what the world allows. */
const WALK_STEP_UP = 1;
const WALK_STEP_DOWN = 4;

export interface FakeEnvironmentOptions {
  readonly seed?: number;
  readonly amplitude?: number;
  /** Starting world tick, so tests can begin at dusk or night. */
  readonly startTicks?: number;
  /** Ticks the clock advances per `worldTime()` call. */
  readonly ticksPerQuery?: number;
  /** Hostiles the environment reports near agents at night. */
  readonly hostilesAtNight?: boolean;
}

export class FakeEnvironment implements Environment {
  readonly world: FakeWorld;
  private ticks: number;
  private readonly ticksPerQuery: number;
  private readonly hostilesAtNight: boolean;
  private connected = false;
  /** Positions of agents, so they can observe each other. */
  private readonly agentPositions = new Map<string, { name: string; position: Position }>();

  constructor(options: FakeEnvironmentOptions = {}) {
    const worldOptions =
      options.amplitude === undefined
        ? { seed: options.seed ?? 1 }
        : { seed: options.seed ?? 1, amplitude: options.amplitude };
    this.world = new FakeWorld(worldOptions);
    this.ticks = options.startTicks ?? 1_000;
    this.ticksPerQuery = options.ticksPerQuery ?? 0;
    this.hostilesAtNight = options.hostilesAtNight ?? true;
  }

  describe(): EnvironmentInfo {
    return {
      kind: 'fake',
      embodiment: 'logical',
      elevationRange: { min: MIN_ELEVATION, max: MAX_ELEVATION },
      maxSurveyCells: 16_384,
      observationRadius: 32,
    };
  }

  async connect(): Promise<Result<EnvironmentInfo>> {
    this.connected = true;
    return ok(this.describe());
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  /** Move the clock by hand, so tests can force dusk or a new day. */
  setTicks(ticks: number): void {
    this.ticks = ticks;
  }

  async worldTime(): Promise<Result<WorldTime>> {
    if (!this.connected) return fail('ENVIRONMENT_DISCONNECTED', 'fake environment not connected');
    this.ticks += this.ticksPerQuery;
    const raw = this.ticks % TICKS_PER_DAY;
    return ok({
      totalTicks: this.ticks,
      day: Math.floor(this.ticks / TICKS_PER_DAY),
      phase: phaseOf(raw),
      isDay: isDaylight(raw),
      weather: 'clear',
    });
  }

  async observe(agent: AgentView, radius: number): Promise<Result<Observation>> {
    if (!this.connected) return fail('ENVIRONMENT_DISCONNECTED', 'fake environment not connected');
    this.agentPositions.set(agent.id, { name: agent.name, position: agent.position });

    const time = await this.worldTime();
    if (!time.ok) return time;

    const bounded = Math.max(4, Math.min(64, Math.floor(radius)));
    const region: Region = {
      min: { x: agent.position.x - bounded, y: MIN_ELEVATION, z: agent.position.z - bounded },
      max: { x: agent.position.x + bounded, y: MAX_ELEVATION, z: agent.position.z + bounded },
    };

    const survey = await this.surveyRegion(region, bounded <= 16 ? 1 : 2);
    if (!survey.ok) return survey;

    return ok({
      at: agent.position,
      time: time.value,
      terrain: survey.value,
      visibleResources: this.visibleResources(survey.value),
      nearbyAgents: this.nearbyAgents(agent, bounded),
      nearbyEntities: this.nearbyEntities(agent, time.value),
      sheltered: this.isSheltered(agent.position),
    });
  }

  async surveyRegion(region: Region, resolution: number): Promise<Result<TerrainSurvey>> {
    if (!this.connected) return fail('ENVIRONMENT_DISCONNECTED', 'fake environment not connected');

    const step = Math.max(1, Math.min(32, Math.floor(resolution)));
    const width = Math.floor((region.max.x - region.min.x) / step) + 1;
    const depth = Math.floor((region.max.z - region.min.z) / step) + 1;
    const cells = width * depth;
    if (cells > this.describe().maxSurveyCells) {
      return fail(
        'BAD_ARGS',
        `survey of ${cells} cells exceeds the ${this.describe().maxSurveyCells} cell limit`,
      );
    }

    const out: SurveyCell[] = [];
    for (let x = region.min.x; x <= region.max.x; x += step) {
      for (let z = region.min.z; z <= region.max.z; z += step) {
        const y = this.world.surfaceHeight(x, z);
        out.push({ x: Math.floor(x), z: Math.floor(z), y, surface: this.world.blockAt({ x, y, z }).surface });
      }
    }
    return ok({ region, resolution: step, cells: out });
  }

  async inspect(position: Position): Promise<Result<BlockInfo>> {
    if (!this.connected) return fail('ENVIRONMENT_DISCONNECTED', 'fake environment not connected');
    const block = this.world.blockAt(position);
    return ok({ position, surface: block.surface, yields: block.yields, solid: block.solid });
  }

  async moveAgent(agent: AgentView, to: Position): Promise<Result<MoveResult>> {
    if (!this.connected) return fail('ENVIRONMENT_DISCONNECTED', 'fake environment not connected');

    // Terrain-following steering, shared with the Minecraft adapter. The agent
    // walks around a rise but cannot cross a cliff — which is what keeps its
    // position honest (ADR-0003).
    const walked = traverse(agent.position, to, (x, z, fromY) => this.walkableHeight(x, z, fromY));

    if (walked.blockedAt !== null) {
      return fail('PATH_BLOCKED', 'impassable terrain immediately ahead', {
        observed: { blockedAt: walked.blockedAt },
      });
    }

    this.agentPositions.set(agent.id, { name: agent.name, position: walked.to });
    return {
      ok: true,
      value: {
        from: agent.position,
        to: walked.to,
        distance: walked.distance,
        arrived: walked.arrived,
      },
    };
  }

  /**
   * Ground level at a column as reachable from `fromY`, or null where an agent
   * cannot stand.
   *
   * A floor near the walker's own elevation with room above it beats the
   * topmost solid block. Without that, the roof of a hut *is* the ground for
   * every column of it — so five settlers who walked inside to sleep found every
   * neighbouring column four blocks up and were sealed in by the shelter they
   * built. A run showed exactly that: all five at one coordinate, walled in.
   */
  private walkableHeight(x: number, z: number, fromY: number): number | null {
    const feetFrom = Math.floor(fromY);
    for (let feet = feetFrom + WALK_STEP_UP; feet >= feetFrom - WALK_STEP_DOWN; feet--) {
      const floor = this.world.blockAt({ x, y: feet - 1, z });
      if (!floor.solid) continue;
      // Standing in water is not walking.
      if (floor.surface === 'water') return null;
      // Feet and head both need room; a doorway has exactly that, a wall does not.
      if (this.world.blockAt({ x, y: feet, z }).solid) continue;
      if (this.world.blockAt({ x, y: feet + 1, z }).solid) continue;
      return feet - 1;
    }

    // No floor within a step of the walker: fall back to the open surface, which
    // is the right answer for ordinary terrain a long way above or below.
    const y = this.world.surfaceHeight(x, z);
    return this.world.blockAt({ x, y, z }).surface === 'water' ? null : y;
  }

  async harvest(
    _agent: AgentView,
    region: Region,
    resource: ResourceKind,
    maxBlocks: number,
  ): Promise<Result<HarvestResult>> {
    if (!this.connected) return fail('ENVIRONMENT_DISCONNECTED', 'fake environment not connected');
    if (maxBlocks <= 0) return fail('BAD_ARGS', 'maxBlocks must be positive');

    const volume = regionVolume(region);
    if (volume > 200_000) {
      return fail('BAD_ARGS', `harvest region of ${volume} blocks is too large`);
    }

    // Find candidate blocks that yield the wanted resource.
    const targets: Position[] = [];
    for (const position of regionPositions(region)) {
      if (targets.length >= maxBlocks) break;
      if (this.world.blockAt(position).yields === resource) targets.push(position);
    }

    if (targets.length === 0) {
      return fail('RESOURCE_UNAVAILABLE', `no ${resource} found in the region`, {
        observed: { region, resource },
        retryable: false,
      });
    }

    for (const position of targets) this.world.removeBlock(position);

    // Verify: re-read a sample and credit only what actually changed
    // (ADR-0004). Requesting 48 logs from 3 trees yields 3 trees' worth.
    const sampleSize = verificationSampleSize(targets.length);
    let confirmed = 0;
    for (let i = 0; i < sampleSize; i++) {
      const position = targets[Math.floor((i * targets.length) / sampleSize)]!;
      if (!this.world.blockAt(position).solid) confirmed++;
    }
    const confirmedRatio = confirmed / sampleSize;
    const credited = Math.floor(targets.length * confirmedRatio);

    if (credited === 0) {
      return fail('VERIFICATION_FAILED', `removed ${targets.length} blocks but none verified`, {
        observed: { attempted: targets.length },
      });
    }

    const gained: ResourceBundle = { [resource]: credited };
    return ok({
      gained,
      blocksRemoved: credited,
      verifiedSample: sampleSize,
      exhausted: this.exhaustedPositions(region, resource, targets),
    });
  }

  async clearRegion(_agent: AgentView, region: Region): Promise<Result<BuildResult>> {
    if (!this.connected) return fail('ENVIRONMENT_DISCONNECTED', 'fake environment not connected');
    let cleared = 0;
    for (const position of regionPositions(region)) {
      if (this.world.blockAt(position).solid) {
        this.world.removeBlock(position);
        cleared++;
      }
    }
    return ok({
      region,
      blocksPlaced: cleared,
      blocksFailed: 0,
      verifiedSample: 0,
      complete: true,
    });
  }

  async build(
    _agent: AgentView,
    blueprint: Blueprint,
    origin: Position,
  ): Promise<Result<BuildResult>> {
    if (!this.connected) return fail('ENVIRONMENT_DISCONNECTED', 'fake environment not connected');

    const region = blueprintRegion(blueprint, origin);
    if (region.min.y < MIN_ELEVATION || region.max.y >= MAX_ELEVATION) {
      return fail('TARGET_CHANGED', 'the structure would fall outside the world', {
        observed: { region },
        retryable: false,
      });
    }

    for (const block of blueprint.blocks) {
      const position = { x: origin.x + block.dx, y: origin.y + block.dy, z: origin.z + block.dz };
      this.world.setBlock(position, MATERIAL_BLOCKS[block.material]);
    }

    return this.verifyBuild(blueprint, origin);
  }

  async verifyBuild(blueprint: Blueprint, origin: Position): Promise<Result<BuildResult>> {
    if (!this.connected) return fail('ENVIRONMENT_DISCONNECTED', 'fake environment not connected');

    const region = blueprintRegion(blueprint, origin);
    // Only structural blocks are checked; a missing `empty` is not a defect.
    const structural = blueprint.blocks.filter((block) => block.material !== 'empty');
    if (structural.length === 0) {
      return ok({ region, blocksPlaced: 0, blocksFailed: 0, verifiedSample: 0, complete: true });
    }

    const sampleSize = verificationSampleSize(structural.length);
    let matched = 0;
    for (let i = 0; i < sampleSize; i++) {
      const block = structural[Math.floor((i * structural.length) / sampleSize)]!;
      const position = { x: origin.x + block.dx, y: origin.y + block.dy, z: origin.z + block.dz };
      const expected = MATERIAL_BLOCKS[block.material];
      if (this.world.blockAt(position).surface === expected.surface) matched++;
    }

    const ratio = matched / sampleSize;
    const placed = Math.round(structural.length * ratio);
    return ok({
      region,
      blocksPlaced: placed,
      blocksFailed: structural.length - placed,
      verifiedSample: sampleSize,
      complete: ratio >= BUILD_COMPLETION_THRESHOLD,
    });
  }

  async presentAgent(agent: AgentView): Promise<Result<void>> {
    this.agentPositions.set(agent.id, { name: agent.name, position: agent.position });
    return ok(undefined);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Cost of a blueprint in placed materials — mirrors MATERIAL_COST, exposed
   *  for tests that assert the environment and the ledger agree. */
  static blueprintMaterialCost(blueprint: Blueprint): ResourceBundle {
    const total: Record<string, number> = {};
    for (const block of blueprint.blocks) {
      for (const [resource, amount] of Object.entries(MATERIAL_COST[block.material])) {
        total[resource] = (total[resource] ?? 0) + (amount ?? 0);
      }
    }
    return total as ResourceBundle;
  }

  private visibleResources(survey: TerrainSurvey): VisibleResource[] {
    // Cluster surface cells by what they yield, so an agent sees "a stand of
    // trees over there" rather than 400 individual blocks.
    const clusters = new Map<string, { resource: ResourceKind; position: Position; count: number }>();
    for (const cell of survey.cells) {
      // A column offers more than one thing, and reading only its top block
      // hides most of them: over a tree the top block is canopy, and on open
      // ground it is grass with the rock everyone knows about a few blocks below.
      for (const found of this.resourcesInColumn(cell.x, cell.y, cell.z)) {
        // Cluster on a 16-block grid.
        const key = `${found.yields}:${Math.floor(cell.x / 16)},${Math.floor(cell.z / 16)}`;
        const existing = clusters.get(key);
        if (existing === undefined) {
          clusters.set(key, { resource: found.yields, position: found.position, count: 1 });
        } else {
          existing.count++;
        }
      }
    }

    const ranked = [...clusters.values()]
      .map((cluster) => ({
        resource: cluster.resource,
        position: cluster.position,
        // A canopy cell implies a whole trunk beneath it.
        estimatedQuantity: cluster.resource === 'wood' ? cluster.count * 4 : cluster.count,
      }))
      .sort((a, b) => b.estimatedQuantity - a.estimatedQuantity);

    // Bounded per kind: an observation is rendered into prompts, and a hundred
    // near-identical clusters is noise that costs tokens (requirement 29).
    return boundVisibleResources(ranked);
  }

  /**
   * Everything a column plausibly offers, looking down from its top block.
   *
   * Returns a list rather than one answer, because a column genuinely offers
   * several things and picking only the topmost hides the useful ones: the top
   * block over a forest is leaves, and on open ground it is grass sitting on the
   * rock everyone knows is underneath.
   *
   * The probe depth is what keeps this honest rather than omniscient. Stone lies
   * a few blocks down and is common knowledge; ore lies far deeper and stays
   * hidden until an agent digs for it.
   */
  private resourcesInColumn(
    x: number,
    surfaceY: number,
    z: number,
  ): { yields: ResourceKind; position: Position }[] {
    const found: { yields: ResourceKind; position: Position }[] = [];
    const seen = new Set<ResourceKind>();

    for (let dy = 0; dy <= PERCEPTION_DEPTH; dy++) {
      const y = surfaceY - dy;
      const block = this.world.blockAt({ x, y, z });
      if (block.yields === null || seen.has(block.yields)) continue;
      seen.add(block.yields);
      found.push({ yields: block.yields, position: { x, y, z } });
    }

    return found;
  }

  private nearbyAgents(agent: AgentView, radius: number): NearbyAgent[] {
    const out: NearbyAgent[] = [];
    for (const [id, other] of this.agentPositions) {
      if (id === agent.id) continue;
      const d = distance(agent.position, other.position);
      if (d <= radius) {
        out.push({ id, name: other.name, position: other.position, distance: d });
      }
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  private nearbyEntities(agent: AgentView, time: WorldTime): NearbyEntity[] {
    if (!this.hostilesAtNight || time.isDay) return [];
    // Deterministic from position and day, so a test can rely on it.
    const roll = ((Math.floor(agent.position.x) * 31 + Math.floor(agent.position.z) * 17 + time.day) % 10 + 10) % 10;
    if (roll > 3) return [];
    return [
      {
        kind: 'hostile',
        position: { x: agent.position.x + 6, y: agent.position.y, z: agent.position.z + 4 },
        distance: 7.2,
        hostile: true,
      },
    ];
  }

  /**
   * Whether there is solid cover overhead and walls close by.
   *
   * Each direction is scanned outward rather than probed at a fixed distance —
   * a small hut's interior is one block wide, so a fixed 2-block probe reaches
   * straight past its walls and reports open sky.
   */
  private isSheltered(position: Position): boolean {
    let roofed = false;
    for (let dy = 1; dy <= 4; dy++) {
      if (this.world.blockAt({ x: position.x, y: position.y + dy, z: position.z }).solid) {
        roofed = true;
        break;
      }
    }
    if (!roofed) return false;

    let walls = 0;
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      for (let step = 1; step <= 3; step++) {
        if (this.world.blockAt({ x: position.x + ax * step, y: position.y, z: position.z + az * step }).solid) {
          walls++;
          break;
        }
      }
    }
    return walls >= 3;
  }

  /** Positions where the resource is now gone, so knowledge can be corrected. */
  private exhaustedPositions(
    region: Region,
    resource: ResourceKind,
    harvested: readonly Position[],
  ): Position[] {
    for (const position of regionPositions(region)) {
      if (this.world.blockAt(position).yields === resource) {
        return []; // More remains here; nothing to correct.
      }
    }
    // Report one representative position per cluster rather than every block.
    const seen = new Set<string>();
    const out: Position[] = [];
    for (const position of harvested) {
      const key = `${Math.floor(position.x / 16)},${Math.floor(position.z / 16)}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(position);
      }
    }
    return out;
  }
}

/** Convenience for tests that want a flat, treeless world to build on. */
export function flatEnvironment(options: FakeEnvironmentOptions = {}): FakeEnvironment {
  return new FakeEnvironment({ ...options, amplitude: 0 });
}
