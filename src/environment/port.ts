/**
 * The Environment port — the boundary that keeps Worldloom's core portable.
 *
 * Nothing in this file mentions Minecraft. A Godot or Webots adapter implements
 * the same interface, and agent logic doesn't change. Two implementations exist
 * today: `MinecraftEnvironment` and `FakeEnvironment` (in-memory, used by every
 * test).
 *
 * Every method returns a `Result`, never throws, and never returns a bare
 * boolean for failure — failures are structured values the planner reacts to
 * (ADR-0008).
 */

import type { AgentView } from '../agents/agent.ts';
import type { Result } from '../core/result.ts';
import type {
  Blueprint,
  Position,
  Region,
  ResourceBundle,
  ResourceKind,
  SurfaceKind,
  TerrainSurvey,
  WorldTime,
} from '../core/world.ts';

/** What an agent can perceive from where it stands. Deliberately bounded —
 *  agents are not omniscient (requirement 9). */
export interface Observation {
  readonly at: Position;
  readonly time: WorldTime;
  /** Terrain within the observation radius, already normalised. */
  readonly terrain: TerrainSurvey;
  /** Resources visible from here, with rough positions. */
  readonly visibleResources: readonly VisibleResource[];
  /** Other agents within sight. */
  readonly nearbyAgents: readonly NearbyAgent[];
  /** Hostiles and other notable entities. */
  readonly nearbyEntities: readonly NearbyEntity[];
  /** Whether the agent is currently under cover — feeds the shelter need. */
  readonly sheltered: boolean;
}

export interface VisibleResource {
  readonly resource: ResourceKind;
  readonly position: Position;
  /** Blocks of this resource seen in the immediate cluster. */
  readonly estimatedQuantity: number;
}

export interface NearbyAgent {
  readonly id: string;
  readonly name: string;
  readonly position: Position;
  readonly distance: number;
}

export interface NearbyEntity {
  readonly kind: string;
  readonly position: Position;
  readonly distance: number;
  readonly hostile: boolean;
}

export interface BlockInfo {
  readonly position: Position;
  readonly surface: SurfaceKind;
  /** The resource this block yields when removed, if any. */
  readonly yields: ResourceKind | null;
  readonly solid: boolean;
}

export interface MoveResult {
  readonly from: Position;
  readonly to: Position;
  /** Distance actually travelled — a partial move is a success, not a failure. */
  readonly distance: number;
  /** True when the agent reached the requested destination. */
  readonly arrived: boolean;
}

export interface HarvestResult {
  /**
   * What the ledger may be credited — counted from blocks *verified* to have
   * changed, not from what was requested (ADR-0004).
   */
  readonly gained: ResourceBundle;
  /** Blocks confirmed removed. */
  readonly blocksRemoved: number;
  /** How many positions were re-read to confirm the change. Recorded on the
   *  event so the confidence in a large harvest is explicit. */
  readonly verifiedSample: number;
  /** Positions now exhausted, so the agent can correct its knowledge. */
  readonly exhausted: readonly Position[];
}

export interface BuildResult {
  readonly region: Region;
  readonly blocksPlaced: number;
  /** Blueprint positions that did not end up as intended. */
  readonly blocksFailed: number;
  readonly verifiedSample: number;
  /** True when verification found the structure substantially as designed. */
  readonly complete: boolean;
}

export interface EnvironmentInfo {
  /** e.g. 'minecraft', 'fake'. Recorded on the run for reproducibility. */
  readonly kind: string;
  /** How agents are embodied, which affects what actions are available. */
  readonly embodiment: 'logical' | 'piloted';
  /** Lowest and highest buildable elevation. */
  readonly elevationRange: { readonly min: number; readonly max: number };
  /** Largest region the adapter will survey in one call. */
  readonly maxSurveyCells: number;
  /**
   * How far an agent can sensibly perceive here. The environment owns this
   * because it depends on the medium — a piloted body sees less than a
   * server-side survey — and the core must not have to ask what kind of world
   * it is in to decide.
   */
  readonly observationRadius: number;
}

export interface Environment {
  describe(): EnvironmentInfo;

  /** Connect and verify the environment is usable. Called once at startup. */
  connect(): Promise<Result<EnvironmentInfo>>;

  /** Release resources. Must be safe to call more than once. */
  disconnect(): Promise<void>;

  /** The world clock, in the environment's own terms (ADR-0011). */
  worldTime(): Promise<Result<WorldTime>>;

  /** What this agent can perceive right now. */
  observe(agent: AgentView, radius: number): Promise<Result<Observation>>;

  /** Coarse terrain data over a region — the cheap wide-area sensor. */
  surveyRegion(region: Region, resolution: number): Promise<Result<TerrainSurvey>>;

  inspect(position: Position): Promise<Result<BlockInfo>>;

  /**
   * Move an agent toward a destination. The adapter validates the route against
   * real terrain and may report a partial move; it fails with PATH_BLOCKED when
   * no progress is possible.
   */
  moveAgent(agent: AgentView, to: Position): Promise<Result<MoveResult>>;

  /**
   * Remove resource-bearing blocks from a region and report what was verified
   * removed. The caller credits the ledger from `gained`, never from intent.
   */
  harvest(
    agent: AgentView,
    region: Region,
    resource: ResourceKind,
    maxBlocks: number,
  ): Promise<Result<HarvestResult>>;

  /** Empty a region, so a structure has somewhere to stand. */
  clearRegion(agent: AgentView, region: Region): Promise<Result<BuildResult>>;

  /** Place a blueprint anchored at `origin`, then verify it. */
  build(agent: AgentView, blueprint: Blueprint, origin: Position): Promise<Result<BuildResult>>;

  /** Re-read a built structure to confirm it still stands as designed. */
  verifyBuild(blueprint: Blueprint, origin: Position): Promise<Result<BuildResult>>;

  /**
   * Announce an agent's presence in the world — a visible marker in Minecraft
   * (ADR-0003). Presentation only: failure must not stop the simulation.
   */
  presentAgent(agent: AgentView): Promise<Result<void>>;
}


/**
 * Bound an observation's resource list without losing scarce-but-vital kinds.
 *
 * Capping a globally-sorted list drops food behind hundreds of soil and stone
 * clusters, so an agent starves standing next to berries. Keeping the best few
 * of *each* kind bounds the total just as well and guarantees that anything
 * present is visible.
 */
export function boundVisibleResources(
  clusters: readonly VisibleResource[],
  perKind = 3,
  total = 16,
): VisibleResource[] {
  const byKind = new Map<ResourceKind, VisibleResource[]>();
  for (const cluster of [...clusters].sort((a, b) => b.estimatedQuantity - a.estimatedQuantity)) {
    const bucket = byKind.get(cluster.resource) ?? [];
    if (bucket.length < perKind) {
      bucket.push(cluster);
      byKind.set(cluster.resource, bucket);
    }
  }

  // Interleave the kinds so the cap can't starve whichever sorts last.
  const out: VisibleResource[] = [];
  for (let rank = 0; rank < perKind; rank++) {
    for (const bucket of byKind.values()) {
      const cluster = bucket[rank];
      if (cluster !== undefined && out.length < total) out.push(cluster);
    }
  }
  return out.sort((a, b) => b.estimatedQuantity - a.estimatedQuantity);
}

/** Fraction of a built structure that must verify for it to count as complete. */
export const BUILD_COMPLETION_THRESHOLD = 0.9;

/** How many positions to re-read when verifying a large volume. Verification
 *  costs round trips, so big builds are sampled rather than fully re-read; the
 *  sample size is recorded on the event so the confidence stays explicit. */
export function verificationSampleSize(blockCount: number): number {
  if (blockCount <= 32) return blockCount;
  return Math.min(64, Math.max(16, Math.ceil(Math.sqrt(blockCount) * 2)));
}
