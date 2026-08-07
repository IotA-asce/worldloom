/**
 * The First Settlement scenario (requirement 34).
 *
 * Five settlers, minimal supplies, and a shared objective. They start knowing
 * almost nothing: no surveyed terrain, no located resources, no structures. Every
 * belief they hold by day three has to have been observed or been told to them,
 * which is what makes the run worth watching rather than staged.
 *
 * The personalities and skills exist to make five agents behave differently
 * rather than as identical workers (requirement 6) — they weight goal scoring and
 * how long an agent persists on a failing plan.
 */

import {
  NEUTRAL_PERSONALITY,
  NO_SKILLS,
  STARTING_NEEDS,
  type Agent,
  type Personality,
  type Skills,
} from '../agents/agent.ts';
import type { AgentId, IdFactory, SettlementId } from '../core/ids.ts';
import type { Position } from '../core/world.ts';
import type { NewEvent } from '../events/types.ts';
import { startingNeeds } from '../agents/needs.ts';
import type { Store } from '../persistence/store.ts';
import { agentOwner } from '../persistence/repositories/ledger.ts';
import type { Rng } from '../core/rng.ts';

export interface SettlerTemplate {
  readonly name: string;
  readonly role: string;
  readonly personality: Partial<Personality>;
  readonly skills: Partial<Skills>;
  /** Where this settler's instincts point them first. */
  readonly disposition: string;
}

/**
 * The five. Skills and personality are picked so that the rule-based goal
 * scoring alone produces different first choices — the differences have to be
 * legible in behaviour, not just in a data sheet.
 */
export const SETTLERS: readonly SettlerTemplate[] = [
  {
    name: 'Arun',
    role: 'Explorer',
    personality: { curiosity: 0.9, riskTolerance: 0.75, independence: 0.8, sociability: 0.5 },
    skills: { exploration: 0.9, gathering: 0.5, combat: 0.5 },
    disposition: 'walks further than anyone thinks wise, and comes back with news',
  },
  {
    name: 'Mira',
    role: 'Builder',
    personality: { persistence: 0.9, cooperativeness: 0.8, curiosity: 0.4, riskTolerance: 0.3 },
    skills: { building: 0.9, mining: 0.5, gathering: 0.4 },
    disposition: 'wants a roof over everyone before anything else',
  },
  {
    name: 'Nadia',
    role: 'Forager',
    personality: { sociability: 0.85, cooperativeness: 0.9, curiosity: 0.6 },
    skills: { farming: 0.85, gathering: 0.8, exploration: 0.5 },
    disposition: 'notices what can be eaten, and who has not eaten',
  },
  {
    name: 'Elias',
    role: 'Gatherer',
    personality: { persistence: 0.75, independence: 0.6, sociability: 0.4 },
    skills: { gathering: 0.9, building: 0.5, farming: 0.4 },
    disposition: 'works steadily at whatever the settlement is short of',
  },
  {
    name: 'Sam',
    role: 'Miner',
    personality: { riskTolerance: 0.8, persistence: 0.8, curiosity: 0.5, sociability: 0.3 },
    skills: { mining: 0.9, combat: 0.6, building: 0.4 },
    disposition: 'would rather be underground',
  },
];

export const SETTLEMENT_OBJECTIVE = 'Establish a self-sustaining settlement';

export interface ScenarioSetup {
  readonly settlementId: SettlementId;
  readonly settlementName: string;
  readonly center: Position;
  readonly agents: readonly Agent[];
}

export interface FoundOptions {
  readonly store: Store;
  readonly ids: IdFactory;
  readonly rng: Rng;
  /** Where the settlers arrive. */
  readonly center: Position;
  readonly settlementName?: string;
  readonly agentCount?: number;
  readonly day?: number;
  readonly worldTicks?: number;
  /** Supplies the settlers arrive with. Deliberately meagre. */
  readonly startingSupplies?: { readonly food: number };
  /**
   * Ground level at a position, from the environment.
   *
   * Required in practice: settlers spread out around the camp, and the ground
   * there is not the ground at its centre. Without this they can be placed
   * inside a hillside and then be unable to take a single step.
   */
  readonly surfaceAt?: (x: number, z: number) => number | null;
}

/**
 * Create the settlement and its settlers, and record their arrival in the
 * ledger. Idempotent: a restart finds the agents already there and leaves them
 * alone, which is what lets `worldloom run` be re-run on an existing world.
 */
export function foundSettlement(options: FoundOptions): ScenarioSetup {
  const { store, ids, rng } = options;
  const day = options.day ?? 0;
  const worldTicks = options.worldTicks ?? 0;
  const context = { day, worldTicks };

  const existing = store.agents.all();
  if (existing.length > 0) {
    const founded = store.events.query({ types: ['settlement_founded'], limit: 1 })[0];
    const payload = founded?.payload as
      | { settlementId?: SettlementId; name?: string; center?: Position }
      | undefined;
    return {
      settlementId: payload?.settlementId ?? (ids.next('stmt') as SettlementId),
      settlementName: payload?.name ?? 'the settlement',
      center: payload?.center ?? options.center,
      agents: existing,
    };
  }

  const settlementId = ids.next('stmt') as SettlementId;
  const settlementName = options.settlementName ?? 'Aurelian Reach';
  const count = Math.max(1, Math.min(SETTLERS.length, options.agentCount ?? SETTLERS.length));
  const templates = SETTLERS.slice(0, count);

  const agents: Agent[] = templates.map((template, index) =>
    buildAgent(template, index, options.center, ids, rng, day, options.surfaceAt),
  );

  store.transaction(() => {
    store.events.appendAll(
      [
        {
          type: 'settlement_founded',
          actorId: null,
          payload: {
            settlementId,
            name: settlementName,
            center: options.center,
            objective: SETTLEMENT_OBJECTIVE,
          },
        },
      ],
      context,
    );

    const spawnEvents: NewEvent[] = [];
    for (const agent of agents) {
      store.agents.insert(agent);
      // Arriving with a couple of days' food and nothing else: enough to have a
      // chance, not enough to skip the first crisis.
      store.ledger.credit(agentOwner(agent.id), { food: options.startingSupplies?.food ?? 4 });
      spawnEvents.push({
        type: 'agent_spawned',
        actorId: agent.id,
        payload: { agentId: agent.id, name: agent.name, role: agent.role, at: agent.position },
      });
    }
    store.events.appendAll(spawnEvents, context);

    // Each settler knows the one thing they were told on arrival: where the camp
    // is. Everything else they have to find out (ADR-0007).
    for (const agent of agents) {
      store.knowledge.rememberLocation({
        agentId: agent.id,
        position: options.center,
        kind: 'settlement',
        confidence: 1,
        source: { kind: 'innate' },
        label: settlementName,
        discoveredAtDay: day,
        lastSeenAtTicks: worldTicks,
      });
      store.memories.insert(
        {
          agentId: agent.id,
          type: 'semantic',
          content: `We came here to ${SETTLEMENT_OBJECTIVE.toLowerCase()}. Our camp is ${settlementName}.`,
          importance: 0.9,
          source: { kind: 'innate' },
          tags: ['settlement', 'objective'],
        },
        context,
      );
    }
  });

  return { settlementId, settlementName, center: options.center, agents };
}

function buildAgent(
  template: SettlerTemplate,
  index: number,
  center: Position,
  ids: IdFactory,
  rng: Rng,
  day: number,
  surfaceAt?: (x: number, z: number) => number | null,
): Agent {
  // Spread the arrivals around the camp so they observe slightly different
  // ground and don't all reach the same conclusion from the same viewpoint.
  const angle = (index / Math.max(1, SETTLERS.length)) * Math.PI * 2;
  const spread = 4;
  const x = Math.round(center.x + Math.cos(angle) * spread);
  const z = Math.round(center.z + Math.sin(angle) * spread);
  const ground = surfaceAt?.(x, z) ?? null;
  const position: Position = {
    x,
    // Stand on the ground here, not at the camp centre's elevation.
    y: ground === null ? center.y : ground + 1,
    z,
  };

  return {
    id: ids.next('agent') as AgentId,
    name: template.name,
    role: template.role,
    personality: { ...NEUTRAL_PERSONALITY, ...template.personality },
    skills: { ...NO_SKILLS, ...template.skills },
    // A little jitter so five agents don't hit the same crisis on the same tick.
    needs: startingNeeds(STARTING_NEEDS, rng.next() * 0.1 - 0.05),
    position,
    health: 1,
    status: 'idle',
    phase: 'observe',
    currentGoalId: null,
    lastTickAt: 0,
    activity: 'taking in the surroundings',
    spawnedAtDay: day,
  };
}

/** A one-line introduction, for the run banner. */
export function describeSettler(template: SettlerTemplate): string {
  return `${template.name} (${template.role}) — ${template.disposition}`;
}
