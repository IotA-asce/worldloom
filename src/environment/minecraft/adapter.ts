/**
 * `MinecraftEnvironment` — the Environment port over the `minecraft-mcp` bridge.
 *
 * This is where Worldloom's intent becomes Minecraft operations, and where every
 * constraint documented in docs/minecraft-integration.md gets handled:
 *
 *  - C1/C2  Agents are logical; world mutation uses the player-less commands and
 *           movement is validated against real terrain (ADR-0003).
 *  - C5     `fill` fails *silently* on unloaded chunks, so every region is
 *           `forceload`ed first and every write is verified by reading back.
 *  - C6     `fill` is capped at 32768 blocks, so volumes are split.
 *  - C8     Survival `break_block` costs a fixed 1s per block, so bulk removal
 *           goes through `fill ... replace` instead.
 */

import type { AgentView } from '../../agents/agent.ts';
import { fail, ok, type Result } from '../../core/result.ts';
import {
  blueprintRegion,
  distance,
  horizontalDistance,
  positionKey,
  regionVolume,
  type Blueprint,
  type BuildMaterial,
  type Position,
  type Region,
  type ResourceBundle,
  type ResourceKind,
  type SurfaceKind,
  type SurveyCell,
  type TerrainSurvey,
  type WorldTime,
  type Weather,
} from '../../core/world.ts';
import { isDaylight, phaseOf, TICKS_PER_DAY } from '../../persistence/repositories/simulation.ts';
import {
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
import type { BridgeClient } from './bridge-client.ts';
import {
  chunkRange,
  isSolid,
  materialMatches,
  MATERIAL_BLOCK,
  parseFilledCount,
  RESOURCE_BLOCKS,
  resourceFromBlock,
  SAFE_FILL_BLOCKS,
  surfaceFromBlock,
} from './blocks.ts';

const MIN_ELEVATION = -64;
const MAX_ELEVATION = 320;
/** The bridge caps a heightmap at 16384 cells. */
const MAX_SURVEY_CELLS = 16_384;

/** Terrain an agent can traverse in one step. */
const MAX_STEP_UP = 1;
const MAX_STEP_DOWN = 4;

/** Hostile entity types worth reacting to. */
const HOSTILE_TYPES = new Set([
  'zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'husk',
  'stray', 'drowned', 'pillager', 'vindicator', 'ravager', 'phantom',
  'cave_spider', 'zombie_villager', 'slime', 'silverfish', 'zoglin',
]);

export interface MinecraftEnvironmentOptions {
  readonly bridge: BridgeClient;
  readonly world?: string;
  readonly embodiment?: 'logical' | 'piloted';
  /** Summon a named marker entity per agent so a human can watch. Cosmetic. */
  readonly visibleMarkers?: boolean;
  /** Upper bound on `get_block_at` probes per operation — the round-trip budget. */
  readonly probeBudget?: number;
}

interface HeightmapResult {
  x0: number;
  z0: number;
  step: number;
  cells: { x: number; z: number; y: number; block: string }[];
}

export class MinecraftEnvironment implements Environment {
  private readonly bridge: BridgeClient;
  private readonly world: string | undefined;
  private readonly embodiment: 'logical' | 'piloted';
  private readonly visibleMarkers: boolean;
  private readonly probeBudget: number;
  /** Marker entity ids, so a moved agent's marker follows it. */
  private readonly markers = new Map<string, number>();
  /** Surface heights already read this run, to spend fewer round trips. */
  private readonly heightCache = new Map<string, number>();

  constructor(options: MinecraftEnvironmentOptions) {
    this.bridge = options.bridge;
    this.world = options.world;
    this.embodiment = options.embodiment ?? 'logical';
    this.visibleMarkers = options.visibleMarkers ?? true;
    this.probeBudget = options.probeBudget ?? 48;
  }

  describe(): EnvironmentInfo {
    return {
      kind: 'minecraft',
      embodiment: this.embodiment,
      elevationRange: { min: MIN_ELEVATION, max: MAX_ELEVATION },
      maxSurveyCells: MAX_SURVEY_CELLS,
    };
  }

  async connect(): Promise<Result<EnvironmentInfo>> {
    const hello = await this.bridge.connect();
    if (!hello.ok) return hello;
    // Prove the world is actually queryable, not merely that a socket opened.
    const time = await this.worldTime();
    if (!time.ok) return time;
    return ok(this.describe());
  }

  async disconnect(): Promise<void> {
    this.bridge.close();
  }

  async worldTime(): Promise<Result<WorldTime>> {
    const result = await this.send('get_time_weather', this.withWorld({}));
    if (!result.ok) return result;

    const raw = result.value as { time_ticks?: number; weather?: string; is_day?: boolean };
    const ticks = typeof raw.time_ticks === 'number' ? raw.time_ticks : 0;
    const weather: Weather =
      raw.weather === 'rain' || raw.weather === 'thunder' ? raw.weather : 'clear';

    // `time_ticks` wraps daily; the monotonic total and day live in the
    // simulation repository, which folds this in (ADR-0011).
    return ok({
      totalTicks: ticks,
      day: Math.floor(ticks / TICKS_PER_DAY),
      phase: phaseOf(ticks),
      isDay: typeof raw.is_day === 'boolean' ? raw.is_day : isDaylight(ticks),
      weather,
    });
  }

  async surveyRegion(region: Region, resolution: number): Promise<Result<TerrainSurvey>> {
    const step = Math.max(1, Math.min(32, Math.floor(resolution)));
    const width = Math.floor((region.max.x - region.min.x) / step) + 1;
    const depth = Math.floor((region.max.z - region.min.z) / step) + 1;
    if (width * depth > MAX_SURVEY_CELLS) {
      return fail(
        'BAD_ARGS',
        `survey of ${width * depth} cells exceeds the bridge's ${MAX_SURVEY_CELLS} cell limit; ` +
          'use a coarser resolution or a smaller region',
      );
    }

    const result = await this.send(
      'get_heightmap',
      this.withWorld({
        x0: Math.floor(region.min.x),
        z0: Math.floor(region.min.z),
        x1: Math.floor(region.max.x),
        z1: Math.floor(region.max.z),
        step,
      }),
    );
    if (!result.ok) return result;

    const raw = result.value as HeightmapResult;
    const cells: SurveyCell[] = (raw.cells ?? []).map((cell) => {
      this.heightCache.set(`${cell.x},${cell.z}`, cell.y);
      return { x: cell.x, z: cell.z, y: cell.y, surface: surfaceFromBlock(cell.block) };
    });

    return ok({ region, resolution: step, cells });
  }

  async inspect(position: Position): Promise<Result<BlockInfo>> {
    const block = await this.blockAt(position);
    if (!block.ok) return block;
    return ok({
      position,
      surface: surfaceFromBlock(block.value),
      yields: resourceFromBlock(block.value),
      solid: isSolid(block.value),
    });
  }

  async observe(agent: AgentView, radius: number): Promise<Result<Observation>> {
    const time = await this.worldTime();
    if (!time.ok) return time;

    const bounded = Math.max(8, Math.min(64, Math.floor(radius)));
    const region: Region = {
      min: { x: agent.position.x - bounded, y: MIN_ELEVATION, z: agent.position.z - bounded },
      max: { x: agent.position.x + bounded, y: MAX_ELEVATION, z: agent.position.z + bounded },
    };

    // One coarse heightmap is the cheap wide sensor; step 2 keeps a 64-radius
    // observation to ~4k cells rather than 16k.
    const survey = await this.surveyRegion(region, bounded > 24 ? 3 : 2);
    if (!survey.ok) return survey;

    const entities = await this.nearbyEntities(agent, bounded);

    return ok({
      at: agent.position,
      time: time.value,
      terrain: survey.value,
      visibleResources: this.visibleResources(survey.value),
      nearbyAgents: entities.agents,
      nearbyEntities: entities.others,
      sheltered: await this.isSheltered(agent.position),
    });
  }

  async moveAgent(agent: AgentView, to: Position): Promise<Result<MoveResult>> {
    const from = agent.position;
    const total = horizontalDistance(from, to);
    if (total < 1) return ok({ from, to: from, distance: 0, arrived: true });

    // Read the real height profile along the route. An agent may not walk
    // through a mountain just because Worldloom moved a number (ADR-0003).
    const profile = await this.routeProfile(from, to);
    if (!profile.ok) return profile;

    let current = from;
    for (const step of profile.value) {
      const climb = step.y - current.y;
      if (climb > MAX_STEP_UP || climb < -MAX_STEP_DOWN) {
        const travelled = horizontalDistance(from, current);
        if (travelled < 1) {
          return fail(
            'PATH_BLOCKED',
            `impassable terrain ahead: a ${climb > 0 ? 'rise' : 'drop'} of ${Math.abs(climb)} blocks at ` +
              `(${step.x}, ${step.y}, ${step.z})`,
            { observed: { blockedAt: step, climb } },
          );
        }
        // Partial progress is a success the planner can build on.
        await this.placeMarker(agent, current);
        return ok({ from, to: current, distance: travelled, arrived: false });
      }
      current = { x: step.x, y: step.y, z: step.z };
    }

    if (this.embodiment === 'piloted') {
      // A real player can actually walk; the bridge's move_to is steering rather
      // than pathfinding (C4), so the terrain check above still did the routing.
      const walked = await this.send('move_to', { x: current.x, y: current.y, z: current.z });
      if (!walked.ok) return walked;
    }

    await this.placeMarker(agent, current);
    return ok({
      from,
      to: current,
      distance: horizontalDistance(from, current),
      arrived: horizontalDistance(current, to) <= 1.5,
    });
  }

  async harvest(
    _agent: AgentView,
    region: Region,
    resource: ResourceKind,
    maxBlocks: number,
  ): Promise<Result<HarvestResult>> {
    if (maxBlocks <= 0) return fail('BAD_ARGS', 'maxBlocks must be positive');

    const loaded = await this.forceload(region);
    if (!loaded.ok) return loaded;

    try {
      // 1. Look before digging: probe a bounded sample to find real deposits.
      const found = await this.probeFor(region, resource);
      if (!found.ok) return found;
      if (found.value.positions.length === 0) {
        return fail('RESOURCE_UNAVAILABLE', `no ${resource} found in the surveyed region`, {
          observed: { region, resource, probes: found.value.probes },
          retryable: false,
        });
      }

      // 2. Remove in slabs sized from the observed density, so wanting 12 logs
      //    does not level an entire forest.
      const removal = await this.removeInSlabs(region, resource, maxBlocks, found.value);
      if (!removal.ok) return removal;

      // 3. Verify: credit only blocks confirmed gone (ADR-0004). C5 means a
      //    silent no-op is a real possibility, so this is not optional.
      const sample = found.value.positions.slice(0, verificationSampleSize(found.value.positions.length));
      let confirmed = 0;
      for (const position of sample) {
        const block = await this.blockAt(position);
        if (block.ok && !isSolid(block.value)) confirmed++;
      }

      if (confirmed === 0) {
        return fail(
          'VERIFICATION_FAILED',
          `issued removal of ${resource} but none of the ${sample.length} sampled blocks changed ` +
            '(unloaded chunks or a protected region?)',
          { observed: { sample: sample.length, region } },
        );
      }

      const ratio = confirmed / sample.length;
      const credited = Math.max(1, Math.min(maxBlocks, Math.round(removal.value.removed * ratio)));
      const gained: ResourceBundle = { [resource]: credited };

      return ok({
        gained,
        blocksRemoved: credited,
        verifiedSample: sample.length,
        exhausted: removal.value.exhausted ? [found.value.positions[0]!] : [],
      });
    } finally {
      await this.releaseForceload(region);
    }
  }

  async clearRegion(_agent: AgentView, region: Region): Promise<Result<BuildResult>> {
    const loaded = await this.forceload(region);
    if (!loaded.ok) return loaded;

    try {
      const filled = await this.fillVolume(region, 'air');
      if (!filled.ok) return filled;

      // Sample the volume to confirm it actually emptied.
      const corners = this.samplePositions(region, 8);
      let clear = 0;
      for (const position of corners) {
        const block = await this.blockAt(position);
        if (block.ok && !isSolid(block.value)) clear++;
      }
      if (clear === 0) {
        return fail('VERIFICATION_FAILED', 'the site did not clear — chunks may not be loaded', {
          observed: { region },
        });
      }

      return ok({
        region,
        blocksPlaced: filled.value,
        blocksFailed: 0,
        verifiedSample: corners.length,
        complete: clear === corners.length,
      });
    } finally {
      await this.releaseForceload(region);
    }
  }

  async build(
    _agent: AgentView,
    blueprint: Blueprint,
    origin: Position,
  ): Promise<Result<BuildResult>> {
    const region = blueprintRegion(blueprint, origin);
    if (region.min.y < MIN_ELEVATION || region.max.y >= MAX_ELEVATION) {
      return fail('TARGET_CHANGED', 'the structure would fall outside the world', {
        observed: { region },
        retryable: false,
      });
    }

    const loaded = await this.forceload(region);
    if (!loaded.ok) return loaded;

    try {
      // Group into axis-aligned runs so a wall is one `fill`, not 40 setblocks.
      for (const run of blueprintRuns(blueprint, origin)) {
        const block = MATERIAL_BLOCK[run.material];
        const command =
          run.length === 1
            ? `setblock ${run.x0} ${run.y} ${run.z} ${block}`
            : `fill ${run.x0} ${run.y} ${run.z} ${run.x1} ${run.y} ${run.z} ${block}`;
        const issued = await this.runCommand(command);
        if (!issued.ok) return issued;
      }

      return await this.verifyBuild(blueprint, origin);
    } finally {
      await this.releaseForceload(region);
    }
  }

  async verifyBuild(blueprint: Blueprint, origin: Position): Promise<Result<BuildResult>> {
    const region = blueprintRegion(blueprint, origin);
    // Only structural blocks matter; a missing `empty` is not a defect.
    const structural = blueprint.blocks.filter((block) => block.material !== 'empty');
    if (structural.length === 0) {
      return ok({ region, blocksPlaced: 0, blocksFailed: 0, verifiedSample: 0, complete: true });
    }

    const sampleSize = Math.min(this.probeBudget, verificationSampleSize(structural.length));
    let matched = 0;
    for (let i = 0; i < sampleSize; i++) {
      const spec = structural[Math.floor((i * structural.length) / sampleSize)]!;
      const position = { x: origin.x + spec.dx, y: origin.y + spec.dy, z: origin.z + spec.dz };
      const block = await this.blockAt(position);
      if (block.ok && materialMatches(spec.material, block.value)) matched++;
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
    if (!this.visibleMarkers) return ok(undefined);
    return this.placeMarker(agent, agent.position);
  }

  // ── Bridge plumbing ───────────────────────────────────────────────────────

  private send(cmd: string, args: Record<string, unknown>): Promise<Result<unknown>> {
    return this.bridge.send(cmd, args);
  }

  private withWorld(args: Record<string, unknown>): Record<string, unknown> {
    return this.world === undefined ? args : { ...args, world: this.world };
  }

  private async runCommand(command: string): Promise<Result<string>> {
    const result = await this.send('run_command', { command });
    if (!result.ok) return result;
    const raw = result.value as { output?: unknown };
    return ok(typeof raw.output === 'string' ? raw.output : '');
  }

  private async blockAt(position: Position): Promise<Result<string>> {
    const result = await this.send(
      'get_block_at',
      this.withWorld({
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z),
      }),
    );
    if (!result.ok) return result;
    const raw = result.value as { block?: unknown };
    return ok(typeof raw.block === 'string' ? raw.block : 'air');
  }

  /**
   * Keep a region's chunks loaded. Without this, `fill` silently no-ops when
   * nobody is online (constraint C5) — the single nastiest failure mode here,
   * because it looks like success.
   */
  private async forceload(region: Region): Promise<Result<void>> {
    const chunks = chunkRange(region.min.x, region.min.z, region.max.x, region.max.z);
    const result = await this.runCommand(
      `forceload add ${chunks.x0 * 16} ${chunks.z0 * 16} ${chunks.x1 * 16} ${chunks.z1 * 16}`,
    );
    if (!result.ok) return result;
    return ok(undefined);
  }

  private async releaseForceload(region: Region): Promise<void> {
    const chunks = chunkRange(region.min.x, region.min.z, region.max.x, region.max.z);
    // Best effort: leaving a region loaded costs memory but breaks nothing.
    await this.runCommand(
      `forceload remove ${chunks.x0 * 16} ${chunks.z0 * 16} ${chunks.x1 * 16} ${chunks.z1 * 16}`,
    );
  }

  /** `fill` a volume, splitting to stay under the vanilla cap (constraint C6). */
  private async fillVolume(region: Region, block: string, replace?: string): Promise<Result<number>> {
    const volume = regionVolume(region);
    if (volume > SAFE_FILL_BLOCKS) {
      // Bisect along the longest axis — the approach proven in minecraft-mcp's
      // own build scripts.
      const [a, b] = bisect(region);
      const first = await this.fillVolume(a, block, replace);
      if (!first.ok) return first;
      const second = await this.fillVolume(b, block, replace);
      if (!second.ok) return second;
      return ok(first.value + second.value);
    }

    const suffix = replace === undefined ? '' : ` replace ${replace}`;
    const result = await this.runCommand(
      `fill ${region.min.x} ${region.min.y} ${region.min.z} ` +
        `${region.max.x} ${region.max.y} ${region.max.z} ${block}${suffix}`,
    );
    if (!result.ok) return result;

    // The bridge documents that console output may be empty, so a parse failure
    // is expected rather than exceptional — verification covers us either way.
    return ok(parseFilledCount(result.value) ?? 0);
  }

  // ── Sensing helpers ───────────────────────────────────────────────────────

  private async routeProfile(
    from: Position,
    to: Position,
  ): Promise<Result<{ x: number; y: number; z: number }[]>> {
    const total = Math.ceil(horizontalDistance(from, to));
    const points: { x: number; z: number }[] = [];
    for (let i = 1; i <= total; i++) {
      const t = i / total;
      points.push({
        x: Math.round(from.x + (to.x - from.x) * t),
        z: Math.round(from.z + (to.z - from.z) * t),
      });
    }

    // One heightmap over the route's bounding box is far cheaper than a
    // get_block_at per step.
    const xs = points.map((p) => p.x);
    const zs = points.map((p) => p.z);
    const box: Region = {
      min: { x: Math.min(...xs, from.x) - 1, y: MIN_ELEVATION, z: Math.min(...zs, from.z) - 1 },
      max: { x: Math.max(...xs, from.x) + 1, y: MAX_ELEVATION, z: Math.max(...zs, from.z) + 1 },
    };
    const survey = await this.surveyRegion(box, 1);
    if (!survey.ok) return survey;

    const heights = new Map<string, number>();
    for (const cell of survey.value.cells) heights.set(`${cell.x},${cell.z}`, cell.y);

    return ok(
      points.map((p) => ({
        x: p.x,
        // Stand on top of the surface block; fall back to the origin's own
        // elevation for a cell the survey somehow missed.
        y: (heights.get(`${p.x},${p.z}`) ?? from.y - 1) + 1,
        z: p.z,
      })),
    );
  }

  private visibleResources(survey: TerrainSurvey): VisibleResource[] {
    // Cluster by surface kind on a 16-block grid, so agents perceive "woodland
    // to the north" rather than hundreds of individual blocks.
    const clusters = new Map<string, { resource: ResourceKind; position: Position; count: number }>();
    for (const cell of survey.cells) {
      const resource = resourceFromSurface(cell.surface);
      if (resource === null) continue;
      const key = `${resource}:${Math.floor(cell.x / 16)},${Math.floor(cell.z / 16)}`;
      const existing = clusters.get(key);
      if (existing === undefined) {
        clusters.set(key, { resource, position: { x: cell.x, y: cell.y, z: cell.z }, count: 1 });
      } else {
        existing.count++;
      }
    }

    return [...clusters.values()]
      .map((cluster) => ({
        resource: cluster.resource,
        position: cluster.position,
        // A canopy cell implies a trunk beneath it; scale accordingly.
        estimatedQuantity:
          cluster.resource === 'wood'
            ? cluster.count * 4 * survey.resolution
            : cluster.count * survey.resolution,
      }))
      .sort((a, b) => b.estimatedQuantity - a.estimatedQuantity);
  }

  private async nearbyEntities(
    agent: AgentView,
    radius: number,
  ): Promise<{ agents: NearbyAgent[]; others: NearbyEntity[] }> {
    const result = await this.send('get_nearby_entities', {
      radius: Math.min(64, radius),
    });
    // Entity queries need a player context in some bridge modes; treating a
    // failure as "saw nothing" keeps logical embodiment working (C1).
    if (!result.ok) return { agents: [], others: [] };

    const raw = result.value as {
      entities?: { id?: number; type?: string; name?: string; x?: number; y?: number; z?: number; distance?: number }[];
    };

    const others: NearbyEntity[] = [];
    const agents: NearbyAgent[] = [];
    for (const entity of raw.entities ?? []) {
      const type = entity.type ?? 'unknown';
      const position: Position = { x: entity.x ?? 0, y: entity.y ?? 0, z: entity.z ?? 0 };
      const d = entity.distance ?? distance(agent.position, position);

      // Marker entities are other Worldloom agents' bodies, not wildlife.
      const markerName = entity.name;
      if (markerName !== undefined && markerName.startsWith(MARKER_PREFIX)) {
        const name = markerName.slice(MARKER_PREFIX.length);
        if (name !== agent.name) {
          agents.push({ id: name, name, position, distance: d });
        }
        continue;
      }

      others.push({
        kind: type,
        position,
        distance: d,
        hostile: HOSTILE_TYPES.has(type.toLowerCase()),
      });
    }

    return { agents, others: others.sort((a, b) => a.distance - b.distance) };
  }

  /**
   * Solid cover overhead plus walls nearby. Deliberately cheap in round trips,
   * and each direction is scanned outward rather than probed at a fixed
   * distance — a small hut's interior is one block wide, so a fixed 2-block
   * probe reaches past its walls and reports open sky.
   */
  private async isSheltered(position: Position): Promise<boolean> {
    let roofed = false;
    for (let dy = 1; dy <= 4; dy++) {
      const above = await this.blockAt({ x: position.x, y: position.y + dy, z: position.z });
      if (above.ok && isSolid(above.value)) {
        roofed = true;
        break;
      }
    }
    if (!roofed) return false;

    let walls = 0;
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      for (let step = 1; step <= 3; step++) {
        const side = await this.blockAt({
          x: position.x + ax * step,
          y: position.y,
          z: position.z + az * step,
        });
        if (side.ok && isSolid(side.value)) {
          walls++;
          break;
        }
      }
    }
    return walls >= 3;
  }

  /**
   * Probe a bounded sample of the region for a resource, returning where it was
   * found and how many probes it took. The probe count is what makes the
   * resulting density estimate honest — it is recorded on the harvest event.
   */
  private async probeFor(
    region: Region,
    resource: ResourceKind,
  ): Promise<Result<{ positions: Position[]; probes: number; density: number }>> {
    const wanted = new Set(RESOURCE_BLOCKS[resource]);
    const candidates = await this.candidatePositions(region, resource);
    if (!candidates.ok) return candidates;

    const positions: Position[] = [];
    let probes = 0;
    for (const position of candidates.value) {
      if (probes >= this.probeBudget) break;
      const block = await this.blockAt(position);
      probes++;
      if (block.ok && wanted.has(block.value)) positions.push(position);
    }

    return ok({
      positions,
      probes,
      density: probes === 0 ? 0 : positions.length / probes,
    });
  }

  /**
   * Where to look for a resource. Surface resources are found from the
   * heightmap; buried ones need a vertical sweep, which is why ore prospecting
   * is expensive (gap R9 in the V0 plan).
   */
  private async candidatePositions(
    region: Region,
    resource: ResourceKind,
  ): Promise<Result<Position[]>> {
    const surfaceResources: ReadonlySet<ResourceKind> = new Set<ResourceKind>([
      'wood', 'fiber', 'food', 'soil', 'sand',
    ]);

    if (surfaceResources.has(resource)) {
      const survey = await this.surveyRegion(
        { min: { ...region.min, y: MIN_ELEVATION }, max: { ...region.max, y: MAX_ELEVATION } },
        2,
      );
      if (!survey.ok) return survey;

      const out: Position[] = [];
      for (const cell of survey.value.cells) {
        if (resource === 'wood') {
          // The heightmap's top block over a tree is canopy, so aim at the
          // trunk a couple of blocks down.
          if (cell.surface === 'vegetation' || cell.surface === 'wood') {
            out.push({ x: cell.x, y: cell.y - 2, z: cell.z });
            out.push({ x: cell.x, y: cell.y - 3, z: cell.z });
          }
        } else if (resourceFromSurface(cell.surface) === resource) {
          out.push({ x: cell.x, y: cell.y, z: cell.z });
        }
      }
      return ok(out);
    }

    // Stone and ores: sweep a vertical grid inside the region.
    const out: Position[] = [];
    const stepXZ = 4;
    const stepY = 3;
    for (let x = region.min.x; x <= region.max.x; x += stepXZ) {
      for (let z = region.min.z; z <= region.max.z; z += stepXZ) {
        for (let y = region.max.y; y >= region.min.y; y -= stepY) {
          out.push({ x, y, z });
        }
      }
    }
    return ok(out);
  }

  /**
   * Remove up to `maxBlocks` of a resource, working through the region in slabs
   * sized from the observed density. Removing the whole region at once would
   * destroy resources the agent never asked for — a settlement should not level
   * a forest to fetch twelve logs.
   */
  private async removeInSlabs(
    region: Region,
    resource: ResourceKind,
    maxBlocks: number,
    found: { positions: Position[]; probes: number; density: number },
  ): Promise<Result<{ removed: number; exhausted: boolean }>> {
    const variants = RESOURCE_BLOCKS[resource];
    const volume = regionVolume(region);
    const estimatedTotal = Math.max(found.positions.length, Math.round(found.density * volume));

    // If the region holds roughly what we want, take it in one pass.
    const slabs = estimatedTotal <= maxBlocks * 1.5 ? [region] : sliceRegion(region, Math.ceil(estimatedTotal / maxBlocks));

    let removed = 0;
    let slabsUsed = 0;
    for (const slab of slabs) {
      if (removed >= maxBlocks) break;
      slabsUsed++;
      for (const variant of variants) {
        const filled = await this.fillVolume(slab, 'air', variant);
        if (!filled.ok) return filled;
        removed += filled.value;
      }
      // Without parseable console output we cannot count as we go, so fall back
      // to the density estimate for this slab and stop.
      if (removed === 0) {
        removed = Math.min(maxBlocks, Math.max(1, Math.round(found.density * regionVolume(slab))));
        break;
      }
    }

    return ok({ removed, exhausted: slabsUsed >= slabs.length });
  }

  private samplePositions(region: Region, count: number): Position[] {
    const out: Position[] = [];
    const xs = [region.min.x, region.max.x];
    const ys = [region.min.y, region.max.y];
    const zs = [region.min.z, region.max.z];
    for (const x of xs) {
      for (const y of ys) {
        for (const z of zs) {
          if (out.length < count) out.push({ x, y, z });
        }
      }
    }
    return out;
  }

  /**
   * Put (or move) an agent's visible marker. Presentation only — a failure is
   * logged by the caller and never stops the simulation (ADR-0003).
   */
  private async placeMarker(agent: AgentView, at: Position): Promise<Result<void>> {
    if (!this.visibleMarkers) return ok(undefined);

    const label = `${MARKER_PREFIX}${agent.name}`;
    if (!this.markers.has(agent.id)) {
      const summoned = await this.send('summon_entity', {
        type: 'armor_stand',
        x: at.x,
        y: at.y,
        z: at.z,
      });
      if (!summoned.ok) return summoned;
      const raw = summoned.value as { entity_id?: number };
      if (typeof raw.entity_id === 'number') this.markers.set(agent.id, raw.entity_id);
      // Name it so observers — and nearbyEntities — can tell who is who.
      await this.runCommand(
        `execute at @e[type=armor_stand,limit=1,sort=nearest,x=${Math.floor(at.x)},y=${Math.floor(at.y)},z=${Math.floor(at.z)}] ` +
          `run data merge entity @s {CustomName:'"${label}"',CustomNameVisible:1b,NoGravity:1b,Invulnerable:1b}`,
      );
      return ok(undefined);
    }

    const moved = await this.runCommand(
      `tp @e[type=armor_stand,name="${label}",limit=1] ${Math.floor(at.x)} ${Math.floor(at.y)} ${Math.floor(at.z)}`,
    );
    if (!moved.ok) return moved;
    return ok(undefined);
  }
}

/** Prefix distinguishing Worldloom agent markers from ordinary armour stands. */
export const MARKER_PREFIX = 'wl:';

/** Which resource a normalised surface kind implies, for cheap wide sensing. */
function resourceFromSurface(surface: SurfaceKind): ResourceKind | null {
  switch (surface) {
    case 'wood':
      return 'wood';
    case 'stone':
      return 'stone';
    case 'sand':
      return 'sand';
    case 'vegetation':
      return 'fiber';
    case 'water':
    case 'snow':
    case 'soil':
    case 'unknown':
      return null;
  }
}

/** Split a region in two along its longest axis. */
function bisect(region: Region): [Region, Region] {
  const dx = region.max.x - region.min.x;
  const dy = region.max.y - region.min.y;
  const dz = region.max.z - region.min.z;

  if (dx >= dy && dx >= dz) {
    const mid = Math.floor((region.min.x + region.max.x) / 2);
    return [
      { min: region.min, max: { ...region.max, x: mid } },
      { min: { ...region.min, x: mid + 1 }, max: region.max },
    ];
  }
  if (dy >= dz) {
    const mid = Math.floor((region.min.y + region.max.y) / 2);
    return [
      { min: region.min, max: { ...region.max, y: mid } },
      { min: { ...region.min, y: mid + 1 }, max: region.max },
    ];
  }
  const mid = Math.floor((region.min.z + region.max.z) / 2);
  return [
    { min: region.min, max: { ...region.max, z: mid } },
    { min: { ...region.min, z: mid + 1 }, max: region.max },
  ];
}

/** Cut a region into `count` slabs along its longest horizontal axis. */
function sliceRegion(region: Region, count: number): Region[] {
  const slabs = Math.max(1, Math.min(32, Math.floor(count)));
  if (slabs === 1) return [region];

  const dx = region.max.x - region.min.x;
  const dz = region.max.z - region.min.z;
  const alongX = dx >= dz;
  const span = alongX ? dx : dz;
  const width = Math.max(1, Math.floor((span + 1) / slabs));

  const out: Region[] = [];
  for (let offset = 0; offset <= span; offset += width) {
    const lo = (alongX ? region.min.x : region.min.z) + offset;
    const hi = Math.min(lo + width - 1, alongX ? region.max.x : region.max.z);
    out.push(
      alongX
        ? { min: { ...region.min, x: lo }, max: { ...region.max, x: hi } }
        : { min: { ...region.min, z: lo }, max: { ...region.max, z: hi } },
    );
  }
  return out;
}

interface BlockRun {
  readonly material: BuildMaterial;
  readonly y: number;
  readonly z: number;
  readonly x0: number;
  readonly x1: number;
  readonly length: number;
}

/**
 * Collapse a blueprint into maximal x-runs per (material, y, z), so a 20-block
 * wall becomes one `fill` instead of twenty `setblock`s. Later blocks win on a
 * duplicated position — the last-wins dedupe from minecraft-mcp's builder.
 */
export function blueprintRuns(blueprint: Blueprint, origin: Position): BlockRun[] {
  const byPosition = new Map<string, BuildMaterial>();
  for (const block of blueprint.blocks) {
    const position = { x: origin.x + block.dx, y: origin.y + block.dy, z: origin.z + block.dz };
    byPosition.set(positionKey(position), block.material);
  }

  // Group into rows keyed by (material, y, z), then walk each row for runs.
  const rows = new Map<string, { material: BuildMaterial; y: number; z: number; xs: number[] }>();
  for (const [key, material] of byPosition) {
    const [xs, ys, zs] = key.split(',');
    const x = Number(xs);
    const y = Number(ys);
    const z = Number(zs);
    const rowKey = `${material}:${y}:${z}`;
    const row = rows.get(rowKey);
    if (row === undefined) {
      rows.set(rowKey, { material, y, z, xs: [x] });
    } else {
      row.xs.push(x);
    }
  }

  const runs: BlockRun[] = [];
  for (const row of rows.values()) {
    row.xs.sort((a, b) => a - b);
    let start = row.xs[0]!;
    let previous = start;
    for (let i = 1; i <= row.xs.length; i++) {
      const current = row.xs[i];
      if (current !== undefined && current === previous + 1) {
        previous = current;
        continue;
      }
      runs.push({
        material: row.material,
        y: row.y,
        z: row.z,
        x0: start,
        x1: previous,
        length: previous - start + 1,
      });
      if (current !== undefined) {
        start = current;
        previous = current;
      }
    }
  }

  // Clear before building, so `empty` never erases a block placed after it.
  return runs.sort((a, b) => Number(b.material === 'empty') - Number(a.material === 'empty'));
}
