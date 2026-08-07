/**
 * Stage 2 of the chronicle pipeline: one factual sentence per event
 * (ADR-0009 step 2).
 *
 * This is the load-bearing stage. It must produce a correct, if dry, chronicle
 * with **no model at all** — that is what makes the whole test suite exercise a
 * real chronicle under `HeuristicProvider`, and what the verifier falls back to
 * when a model drifts. Every claim a sentence here makes comes from the event's
 * own payload; there is no other source of information in this file.
 *
 * `RENDERERS` is an exhaustive record over `EventType`, so adding an event to
 * the vocabulary without deciding how history describes it is a compile error
 * rather than a gap discovered six days into a run.
 */

import type { AgentId } from '../core/ids.ts';
import {
  formatBundle,
  formatPosition,
  formatRegion,
  type Position,
  type Region,
} from '../core/world.ts';
import type { EventType, WorldEvent } from '../events/types.ts';

/**
 * Agent ids resolved to names.
 *
 * An unknown id renders as the id itself. That reads badly, and it is the right
 * behaviour: inventing "a settler" for an id we cannot resolve would put an
 * unattributable claim into the historical record.
 */
export interface NameBook {
  nameOf(id: AgentId | string): string;
}

export function nameBook(
  agents: readonly { readonly id: AgentId; readonly name: string }[],
): NameBook {
  const names = new Map<string, string>(agents.map((agent) => [agent.id, agent.name]));
  return { nameOf: (id) => names.get(id) ?? id };
}

/** A rendered fact and the evidence behind it. */
export interface RenderedFact {
  readonly eventId: string;
  readonly type: EventType;
  readonly day: number;
  readonly seq: number;
  readonly importance: number;
  readonly sentence: string;
}

type Renderer<T extends EventType> = (event: WorldEvent<T>, names: NameBook) => string;

type RendererMap = { readonly [T in EventType]: Renderer<T> };

// ── Small formatting helpers ────────────────────────────────────────────────

/**
 * Terminate a sentence exactly once, however the payload text ended. A closing
 * quote after the stop counts as terminated: a quoted message that ends in a
 * full stop should not collect a second one outside the quotes.
 */
function sentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return /[.!?]["'’”]?$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** `gather_resource` → `gather resource`. Identifiers are not prose. */
function humanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').trim().toLowerCase();
}

function percent(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}

function signed(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return rounded >= 0 ? `+${String(rounded)}` : String(rounded);
}

/** Structures are placed over a region; history cites the corner they were
 *  anchored at, which is the coordinate a reader can go and stand on. */
function anchorOf(region: Region): Position {
  return region.min;
}

function listNames(ids: readonly AgentId[], names: NameBook): string {
  const resolved = ids.map((id) => names.nameOf(id));
  if (resolved.length === 0) return 'The settlers';
  if (resolved.length === 1) return resolved[0] ?? 'The settlers';
  return `${resolved.slice(0, -1).join(', ')} and ${String(resolved[resolved.length - 1])}`;
}

// ── One renderer per event type ─────────────────────────────────────────────

const RENDERERS: RendererMap = {
  // ── Lifecycle ─────────────────────────────────────────────────────────────
  simulation_started: (event) =>
    sentence(
      `On day ${String(event.day)}, the record of ${event.payload.scenario} began with ` +
        `${String(event.payload.agents)} settler(s)`,
    ),

  simulation_resumed: (event) =>
    sentence(
      `On day ${String(event.day)}, the record of ${event.payload.scenario} resumed from ` +
        `day ${String(event.payload.fromDay)}`,
    ),

  day_began: (event) => sentence(`Day ${String(event.payload.day)} began`),

  settlement_founded: (event) =>
    sentence(
      `On day ${String(event.day)}, the settlement of ${event.payload.name} was founded at ` +
        `${formatPosition(event.payload.center)}, to ${event.payload.objective}`,
    ),

  agent_spawned: (event) =>
    sentence(
      `${event.payload.name}, ${event.payload.role}, arrived at ` +
        `${formatPosition(event.payload.at)} on day ${String(event.day)}`,
    ),

  // ── Discovery and knowledge ───────────────────────────────────────────────
  location_discovered: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} came upon ${humanize(event.payload.kind)} at ` +
        `${formatPosition(event.payload.at)} on day ${String(event.day)}`,
    ),

  resource_discovered: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} discovered ${event.payload.resource} at ` +
        `${formatPosition(event.payload.at)} on day ${String(event.day)}, ` +
        `an estimated ${String(event.payload.estimatedQuantity)} of it`,
    ),

  knowledge_shared: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.fromAgentId)} told ` +
        `${names.nameOf(event.payload.toAgentId)} about ${humanize(event.payload.subject)} ` +
        `on day ${String(event.day)}: ${event.payload.detail}`,
    ),

  // ── Resources ─────────────────────────────────────────────────────────────
  resource_collected: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} gathered ${String(event.payload.quantity)} ` +
        `${event.payload.resource} from ${formatRegion(event.payload.from)} ` +
        `on day ${String(event.day)}`,
    ),

  resource_spent: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} spent ${formatBundle(event.payload.resources)} ` +
        `on day ${String(event.day)} for ${event.payload.reason}`,
    ),

  resource_transferred: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.fromAgentId)} handed ` +
        `${formatBundle(event.payload.resources)} to ` +
        `${names.nameOf(event.payload.toAgentId)} on day ${String(event.day)}, ` +
        `for ${event.payload.reason}`,
    ),

  resource_deposited: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} put ${formatBundle(event.payload.resources)} ` +
        `into the settlement's stores on day ${String(event.day)}`,
    ),

  // ── Goals and plans ───────────────────────────────────────────────────────
  goal_created: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} set out to ${humanize(event.payload.kind)} ` +
        `on day ${String(event.day)}, because ${event.payload.reason}`,
    ),

  goal_completed: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} finished ${humanize(event.payload.kind)} ` +
        `on day ${String(event.day)}`,
    ),

  goal_failed: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} failed at ${humanize(event.payload.kind)} ` +
        `on day ${String(event.day)}: ${event.payload.reason}`,
    ),

  goal_abandoned: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} gave up on ${humanize(event.payload.kind)} ` +
        `on day ${String(event.day)}: ${event.payload.reason}`,
    ),

  goal_blocked: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} was held up on ${humanize(event.payload.kind)} ` +
        `on day ${String(event.day)}: ${event.payload.reason}`,
    ),

  plan_created: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} laid out a plan of ` +
        `${String(event.payload.steps)} step(s) on day ${String(event.day)}`,
    ),

  plan_revised: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} reworked their plan into ` +
        `${String(event.payload.steps)} step(s) on day ${String(event.day)}: ` +
        `${event.payload.reason}`,
    ),

  action_failed: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} could not ${humanize(event.payload.action)} ` +
        `on day ${String(event.day)} — ${humanize(event.payload.failureKind)}: ` +
        `${event.payload.detail}`,
    ),

  // ── Movement and state ────────────────────────────────────────────────────
  agent_moved: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} travelled from ` +
        `${formatPosition(event.payload.from)} to ${formatPosition(event.payload.to)} ` +
        `on day ${String(event.day)}`,
    ),

  agent_injured: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} was hurt by ${humanize(event.payload.cause)} ` +
        `on day ${String(event.day)}, down to ${percent(event.payload.health)} health`,
    ),

  agent_died: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} died on day ${String(event.day)}, ` +
        `of ${humanize(event.payload.cause)}`,
    ),

  need_critical: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)}'s ${humanize(event.payload.need)} became ` +
        `critical on day ${String(event.day)}, at ${percent(event.payload.value)}`,
    ),

  agent_reflected: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} concluded on day ${String(event.day)}, ` +
        `from ${String(event.payload.fromMemories)} memories: ${event.payload.belief}`,
    ),

  // ── Construction ──────────────────────────────────────────────────────────
  structure_started: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} began a ${humanize(event.payload.type)} at ` +
        `${formatPosition(anchorOf(event.payload.region))} on day ${String(event.day)}`,
    ),

  structure_completed: (event, names) =>
    sentence(
      `${listNames(event.payload.builders, names)} completed the ` +
        `${humanize(event.payload.type)} at ` +
        `${formatPosition(anchorOf(event.payload.region))} on day ${String(event.day)}, ` +
        `for ${event.payload.purpose}`,
    ),

  structure_damaged: (event) =>
    sentence(
      `The ${humanize(event.payload.type)} was damaged on day ${String(event.day)}: ` +
        `${event.payload.detail}`,
    ),

  // ── Coordination ──────────────────────────────────────────────────────────
  project_created: (event) =>
    sentence(
      `The settlement took on ${humanize(event.payload.kind)} as shared work on ` +
        `day ${String(event.day)}, needing ${formatBundle(event.payload.requirements)}`,
    ),

  project_claimed: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} took up ${humanize(event.payload.role)} on the ` +
        `shared work on day ${String(event.day)}`,
    ),

  project_completed: (event) =>
    sentence(
      `The shared work of ${humanize(event.payload.kind)} was finished on ` +
        `day ${String(event.day)}`,
    ),

  help_requested: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} asked for help with ` +
        `${humanize(event.payload.need)} on day ${String(event.day)}: ${event.payload.detail}`,
    ),

  // ── Social ────────────────────────────────────────────────────────────────
  message_sent: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.fromAgentId)} sent word to ` +
        `${names.nameOf(event.payload.toAgentId)} on day ${String(event.day)}: ` +
        `"${event.payload.content}"`,
    ),

  message_received: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)} read that message on ` +
        `day ${String(event.day)} and took it to mean: ${event.payload.interpretation}`,
    ),

  relationship_changed: (event, names) =>
    sentence(
      `${names.nameOf(event.payload.agentId)}'s regard for ` +
        `${names.nameOf(event.payload.otherAgentId)} shifted on day ${String(event.day)} ` +
        `(trust ${signed(event.payload.trustDelta)}, ` +
        `affinity ${signed(event.payload.affinityDelta)}): ${event.payload.reason}`,
    ),

  // ── Narrative ─────────────────────────────────────────────────────────────
  chronicle_entry_written: (event) =>
    sentence(
      `The entry for day ${String(event.payload.day)} was written from ` +
        `${String(event.payload.fromEvents)} events`,
    ),
};

/**
 * The factual sentence for one event.
 *
 * The cast is the one place the exhaustive map's per-type payload typing has to
 * be flattened; `RendererMap` is what guarantees the lookup exists at all.
 */
export function renderEvent(event: WorldEvent, names: NameBook): RenderedFact {
  const render = RENDERERS[event.type] as (
    event: WorldEvent<EventType>,
    names: NameBook,
  ) => string;
  return {
    eventId: event.id,
    type: event.type,
    day: event.day,
    seq: event.seq,
    importance: event.importance,
    sentence: render(event, names),
  };
}

export function renderFacts(
  events: readonly WorldEvent[],
  names: NameBook,
): RenderedFact[] {
  return events.map((event) => renderEvent(event, names));
}

/**
 * Headlines are drawn from the type of a day's most important event and mention
 * no entity at all. That keeps a deterministic title trivially grounded, and it
 * is why a title can be written without consulting the ledger twice.
 */
const HEADLINES: Partial<Record<EventType, string>> = {
  settlement_founded: 'the founding',
  agent_died: 'a death',
  agent_injured: 'an injury',
  structure_completed: 'a structure stands',
  structure_started: 'work begins',
  structure_damaged: 'damage done',
  resource_discovered: 'a discovery',
  project_completed: 'shared work finished',
  project_created: 'shared work begun',
  goal_failed: 'a setback',
  goal_completed: 'work finished',
  agent_spawned: 'an arrival',
  need_critical: 'want and hunger',
  knowledge_shared: 'word passed along',
  agent_reflected: 'a settler thinks it over',
  simulation_started: 'the first day',
  simulation_resumed: 'the record resumes',
};

/** The most consequential fact of a day: importance first, then ledger order. */
export function headlineFact(facts: readonly RenderedFact[]): RenderedFact | null {
  let best: RenderedFact | null = null;
  for (const fact of facts) {
    if (best === null || fact.importance > best.importance) best = fact;
  }
  return best;
}

export function dayTitle(day: number, facts: readonly RenderedFact[]): string {
  const headline = headlineFact(facts);
  const phrase = headline === null ? 'a quiet day' : HEADLINES[headline.type] ?? 'the day at work';
  return `Day ${String(day)}: ${phrase}`;
}

/**
 * The deterministic chronicle for a day: the facts, in order, as prose.
 *
 * Dry by design. This is the text the verifier falls back to, so it must be
 * true before it is pleasant.
 */
export function renderDayProse(facts: readonly RenderedFact[]): string {
  if (facts.length === 0) return 'Nothing worth recording happened.';
  return facts.map((fact) => fact.sentence).join(' ');
}
