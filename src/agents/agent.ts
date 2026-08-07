/**
 * The agent: persistent structured state, not a conversation transcript.
 *
 * Everything an agent is lives in these fields and in its rows elsewhere
 * (memories, knowledge, relationships, goals). Nothing important lives on a
 * call stack, which is what makes restarting mid-plan possible (ADR-0001).
 */

import type { AgentId, GoalId } from '../core/ids.ts';
import type { Position } from '../core/world.ts';

/**
 * Personality dimensions, each 0..1.
 *
 * These are not a psychological model. They exist to make five agents behave
 * differently — they weight goal scoring, how readily an agent shares
 * information, and how long it persists on a failing plan (requirement 6).
 */
export const PERSONALITY_TRAITS = [
  'riskTolerance',
  'sociability',
  'cooperativeness',
  'curiosity',
  'persistence',
  'independence',
] as const;

export type PersonalityTrait = (typeof PERSONALITY_TRAITS)[number];
export type Personality = Record<PersonalityTrait, number>;

/** Competencies, each 0..1. Influence task preference and execution efficiency. */
export const SKILLS = [
  'exploration',
  'building',
  'mining',
  'farming',
  'gathering',
  'combat',
] as const;

export type Skill = (typeof SKILLS)[number];
export type Skills = Record<Skill, number>;

/**
 * Needs, each a 0..1 *satisfaction* level — 1 is fully met, 0 is critical.
 * Needs decay against world time, not tick count, so a slow scheduler can't
 * make an agent immortal (ADR-0011).
 */
export const NEEDS = ['food', 'safety', 'shelter', 'energy', 'social'] as const;
export type NeedKind = (typeof NEEDS)[number];
export type Needs = Record<NeedKind, number>;

/** What the agent is visibly doing. Surfaced directly in the dashboard/CLI. */
export const AGENT_STATUSES = [
  'idle',
  'exploring',
  'traveling',
  'gathering',
  'building',
  'resting',
  'talking',
  'blocked',
  'dead',
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

/**
 * Position in the tick state machine. Persisted, so a process killed mid-tick
 * resumes at the right phase instead of restarting the agent's turn.
 */
export const TICK_PHASES = ['observe', 'integrate', 'assess', 'plan', 'act', 'record'] as const;
export type TickPhase = (typeof TICK_PHASES)[number];

export interface Agent {
  readonly id: AgentId;
  readonly name: string;
  /** Self-description used in prompts and shown in the CLI, e.g. "Builder". */
  readonly role: string;
  readonly personality: Personality;
  readonly skills: Skills;
  readonly needs: Needs;
  readonly position: Position;
  /** 0..1. Reaching 0 means dead. */
  readonly health: number;
  readonly status: AgentStatus;
  readonly phase: TickPhase;
  readonly currentGoalId: GoalId | null;
  /** World tick at which this agent last completed a tick. */
  readonly lastTickAt: number;
  /** Free-text note on what the agent is doing now — its working memory summary. */
  readonly activity: string;
  readonly spawnedAtDay: number;
}

/** The subset of agent state the environment needs. Keeps the port narrow. */
export interface AgentView {
  readonly id: AgentId;
  readonly name: string;
  readonly position: Position;
}

export function agentView(agent: Agent): AgentView {
  return { id: agent.id, name: agent.name, position: agent.position };
}

export const NEUTRAL_PERSONALITY: Personality = {
  riskTolerance: 0.5,
  sociability: 0.5,
  cooperativeness: 0.5,
  curiosity: 0.5,
  persistence: 0.5,
  independence: 0.5,
};

export const NO_SKILLS: Skills = {
  exploration: 0.3,
  building: 0.3,
  mining: 0.3,
  farming: 0.3,
  gathering: 0.3,
  combat: 0.3,
};

/** Agents start rested and fed but with no shelter — the scenario's premise. */
export const STARTING_NEEDS: Needs = {
  food: 0.8,
  safety: 0.7,
  shelter: 0.1,
  energy: 0.9,
  social: 0.6,
};

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function isAlive(agent: Agent): boolean {
  return agent.status !== 'dead' && agent.health > 0;
}

/** The skill that matters for a kind of work, used for preference and efficiency. */
export function skillLevel(agent: Agent, skill: Skill): number {
  return clamp01(agent.skills[skill]);
}

/**
 * A one-line summary of an agent, for logs and the CLI. Deliberately terse:
 * five of these should fit on a screen.
 */
export function describeAgent(agent: Agent): string {
  return `${agent.name} (${agent.role}) — ${agent.status}: ${agent.activity}`;
}
