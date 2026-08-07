/**
 * Civilization-level state (requirement 19).
 *
 * The distinction that matters: these are *observable public facts*, not anyone's
 * beliefs. A `Structure` row exists because a build was verified; a `Project`
 * exists because someone announced the work. Agents learn about them by being
 * present or being told, and their private opinions live in their own memory and
 * knowledge tables (ADR-0007).
 *
 * The event ledger stays authoritative. These tables are the queryable
 * projection that makes "what does this settlement have?" cheap to answer.
 */

import type { AgentId, ProjectId, SettlementId, StructureId } from '../core/ids.ts';
import type { Position, Region, ResourceBundle } from '../core/world.ts';

export interface Settlement {
  readonly id: SettlementId;
  readonly name: string;
  readonly objective: string;
  readonly foundingDay: number;
  readonly center: Position;
  readonly status: 'active' | 'abandoned';
}

export const STRUCTURE_STATES = ['planned', 'building', 'complete', 'damaged', 'ruined'] as const;
export type StructureState = (typeof STRUCTURE_STATES)[number];

export interface Structure {
  readonly id: StructureId;
  readonly settlementId: SettlementId | null;
  /** Normalised type — 'shelter', 'storage', 'farm', 'mine'. */
  readonly type: string;
  /** The blueprint it was built from, so it can be re-verified or repaired. */
  readonly blueprint: string;
  readonly region: Region;
  readonly builders: readonly AgentId[];
  readonly purpose: string;
  readonly state: StructureState;
  readonly createdAtDay: number;
  readonly createdAtTicks: number;
  /** When the world was last read back and found to match the blueprint. */
  readonly verifiedAtTicks: number | null;
}

export const PROJECT_STATES = [
  'proposed',
  'active',
  'blocked',
  'completed',
  'abandoned',
] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

/**
 * Shared work the settlement wants done.
 *
 * A project is not an agent's goal: it outlives whoever happens to be working on
 * it, which is what lets several settlers contribute to one shelter instead of
 * five people each building their own.
 */
export interface Project {
  readonly id: ProjectId;
  readonly settlementId: SettlementId;
  /** 'build' | 'stockpile' | … — what kind of work this is. */
  readonly kind: string;
  readonly blueprint: string | null;
  readonly requirements: ResourceBundle;
  readonly site: Position | null;
  readonly state: ProjectState;
  readonly priority: number;
  readonly reason: string;
  readonly createdAtDay: number;
  readonly createdAtTicks: number;
  readonly completedAtTicks: number | null;
  /** Set once the project produced something. */
  readonly structureId: StructureId | null;
}

/** A public announcement that an agent has taken on part of a project. */
export interface ProjectClaim {
  readonly projectId: ProjectId;
  readonly agentId: AgentId;
  /** What they are doing: 'gathering', 'building', 'siting', … */
  readonly role: string;
  readonly claimedAtTicks: number;
  readonly releasedAtTicks: number | null;
}

/** One day of generated history, with the evidence it was built from. */
export interface ChronicleEntry {
  readonly id: string;
  readonly day: number;
  readonly title: string;
  readonly prose: string;
  /** Ids of the events this entry describes — nothing else may be claimed. */
  readonly eventIds: readonly string[];
  /** Whether a model wrote the prose (and passed verification) or the
   *  deterministic renderer did. */
  readonly source: 'narrated' | 'rendered';
  readonly generatedAt: number;
}

export function isActive(project: Project): boolean {
  return project.state === 'proposed' || project.state === 'active';
}

export function isUsable(structure: Structure): boolean {
  return structure.state === 'complete' || structure.state === 'damaged';
}
