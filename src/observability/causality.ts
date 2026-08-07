/**
 * Tracing a decision to its consequences, and an event back to its cause.
 *
 * This is the payoff of ADR-0008. Because every reasoning-influenced decision
 * persists what the agent saw, which memories it retrieved, the prompt, the
 * response and the action chosen, "why did Mira abandon the farm project?" is a
 * join rather than an afternoon spent reading interleaved log lines.
 *
 * The one wrinkle the data forces on us: a decision is written *before* the
 * events it causes exist, so `decisions.event_id` is usually null. The forward
 * link is therefore reconstructed from world time — an agent's decision owns
 * what that agent did from the tick it was made until the tick of its next
 * decision. Every chain says which link it used (`reconstructed` or `explicit`),
 * because a view that quietly guesses is worse than no view.
 *
 * Formatting is the CLI's job. Everything here is data.
 */

import type { ReasoningCategory } from '../core/config.ts';
import type { AgentId, DecisionId, EventId, GoalId, MemoryId } from '../core/ids.ts';
import type { DecisionRecord } from '../persistence/repositories/metrics.ts';
import type { Store } from '../persistence/store.ts';
import { answerSourceOf, type DecisionAnswerSource } from './metrics.ts';
import {
  agentNameIndex,
  eventView,
  goalView,
  memoryView,
  planView,
  type ActorView,
  type EventView,
  type GoalView,
  type MemoryView,
  type PlanView,
} from './views.ts';

/** How a decision was tied to an event. */
export type CausalLink =
  /** The decision row names the event. */
  | 'explicit'
  /** Matched by world time — the decision in force when the event happened. */
  | 'reconstructed'
  /** No decision could be tied to it: a deterministic consequence, or a
   *  reasoning category that does not record decisions. */
  | 'none';

export interface DecisionView {
  readonly id: string;
  readonly agent: ActorView;
  readonly category: ReasoningCategory;
  readonly day: number;
  readonly worldTicks: number;
  readonly model: string;
  readonly answeredBy: DecisionAnswerSource;
  /** What the agent did about it, in the words of whatever chose it. */
  readonly chosenAction: string;
  /** The normalised situation the agent acted on. */
  readonly observation: unknown;
  readonly retrievedMemoryIds: readonly string[];
  /** The rendered prompt and the raw response, when this world stores them. */
  readonly prompt: string | null;
  readonly response: string | null;
  readonly eventId: string | null;
  readonly llmCallId: string | null;
}

/** One event a decision led to, and what the agent made of it. */
export interface ConsequenceView {
  readonly event: EventView;
  /** The memory that recorded it — the last link of the causal chain. */
  readonly memories: readonly MemoryView[];
}

export interface CausalChainView {
  readonly decision: DecisionView;
  readonly link: CausalLink;
  /** The span of world time this decision is held responsible for. `untilTicks`
   *  is null when it is the agent's most recent decision — still in force. */
  readonly window: { readonly fromTicks: number; readonly untilTicks: number | null };
  /** The memories the decision cites, resolved. */
  readonly retrievedMemories: readonly MemoryView[];
  /** Cited memory ids that no longer resolve — forgotten, or consolidated away. */
  readonly forgottenMemoryIds: readonly string[];
  readonly consequences: readonly ConsequenceView[];
}

export interface EventExplanationView {
  readonly event: EventView;
  readonly agent: ActorView | null;
  readonly decision: DecisionView | null;
  readonly link: CausalLink;
  readonly retrievedMemories: readonly MemoryView[];
  /** The goal the event names, or the one its actor was pursuing. */
  readonly goal: GoalView | null;
  readonly plan: PlanView | null;
  /** What the actor remembered of this event. */
  readonly memories: readonly MemoryView[];
  /** What the same actor did immediately before, oldest first — the lead-up. */
  readonly precedingEvents: readonly EventView[];
}

export interface ChainOptions {
  /** How many consequent events to follow. */
  readonly consequences?: number;
}

export function decisionView(
  decision: DecisionRecord,
  names: ReadonlyMap<string, string>,
  textRecorded: boolean,
): DecisionView {
  return {
    id: decision.id,
    agent: { id: decision.agentId, name: names.get(decision.agentId) ?? null },
    category: decision.category,
    day: decision.day,
    worldTicks: decision.worldTicks,
    model: decision.model,
    answeredBy: answerSourceOf(decision, textRecorded),
    chosenAction: decision.chosenAction,
    observation: decision.observation,
    retrievedMemoryIds: decision.memoryIds,
    prompt: decision.prompt,
    response: decision.response,
    eventId: decision.eventId,
    llmCallId: decision.llmCallId,
  };
}

/**
 * The full chain for one decision: observation → memories → decision → events →
 * memories.
 *
 * Returns null for an unknown id rather than throwing.
 */
export function causalChain(
  store: Store,
  decisionId: DecisionId | string,
  options: ChainOptions = {},
): CausalChainView | null {
  const decision = store.decisions.find(decisionId as DecisionId);
  if (decision === null) return null;
  return chainFor(store, decision, agentNameIndex(store), store.decisions.textRecorded(), options);
}

/**
 * An agent's recent decisions with their consequences, newest decision first.
 *
 * This is `worldloom why <agent>` with the "and what came of it" half attached.
 */
export function causalChains(
  store: Store,
  agentId: AgentId | string,
  limit = 5,
  options: ChainOptions = {},
): readonly CausalChainView[] {
  const names = agentNameIndex(store);
  const textRecorded = store.decisions.textRecorded();
  return store.decisions
    .forAgent(agentId as AgentId, limit)
    .map((decision) => chainFor(store, decision, names, textRecorded, options));
}

function chainFor(
  store: Store,
  decision: DecisionRecord,
  names: ReadonlyMap<string, string>,
  textRecorded: boolean,
  options: ChainOptions,
): CausalChainView {
  const retrieved: MemoryView[] = [];
  const forgotten: string[] = [];
  for (const id of decision.memoryIds) {
    const memory = store.memories.find(decision.agentId, id);
    if (memory === null) forgotten.push(id);
    else retrieved.push(memoryView(memory));
  }

  const next = store.decisions.firstAfter(decision.agentId, decision.worldTicks);
  const untilTicks = next?.worldTicks ?? null;

  // An explicitly linked event is the decision's own outcome; anything else in
  // the window followed from it.
  const named = decision.eventId === null ? null : store.events.find(decision.eventId);
  const window = store.events.forActorInTickRange(
    decision.agentId,
    decision.worldTicks,
    untilTicks,
    options.consequences ?? 12,
  );
  const events = named === null ? window : [named, ...window.filter((event) => event.id !== named.id)];

  return {
    decision: decisionView(decision, names, textRecorded),
    link: named === null ? 'reconstructed' : 'explicit',
    window: { fromTicks: decision.worldTicks, untilTicks },
    retrievedMemories: retrieved,
    forgottenMemoryIds: forgotten,
    consequences: events.map((event) => ({
      event: eventView(event, names),
      memories: store.memories
        .forEvent(decision.agentId, event.id as EventId)
        .map(memoryView),
    })),
  };
}

/**
 * The reverse direction: what decision produced this event.
 *
 * Most events have no decision of their own — they are the deterministic
 * consequence of one, several steps later. So the decision reported is the one
 * the actor was acting under when the event was written, which is the answer to
 * "why did this happen" even when it is not literally the row that caused it.
 * `link` distinguishes the two cases.
 */
export function explainEvent(
  store: Store,
  eventId: EventId | string,
  options: { readonly precedingEvents?: number } = {},
): EventExplanationView | null {
  const event = store.events.find(eventId);
  if (event === null) return null;

  const names = agentNameIndex(store);
  const textRecorded = store.decisions.textRecorded();
  const actorId = event.actorId;

  const explicit = store.decisions.forEvent(event.id as EventId)[0] ?? null;
  const reconstructed =
    explicit !== null || actorId === null
      ? null
      : store.decisions.latestAtOrBefore(actorId, event.worldTicks);
  const decision = explicit ?? reconstructed;

  const goal = goalOfEvent(store, event.payload, actorId);
  const plan = goal === null ? null : (store.plans.activeForGoal(goal.id) ?? latestPlan(store, goal.id));

  const retrieved: MemoryView[] = [];
  if (decision !== null) {
    for (const id of decision.memoryIds) {
      const memory = store.memories.find(decision.agentId, id as MemoryId);
      if (memory !== null) retrieved.push(memoryView(memory));
    }
  }

  return {
    event: eventView(event, names),
    agent: actorId === null ? null : { id: actorId, name: names.get(actorId) ?? null },
    decision: decision === null ? null : decisionView(decision, names, textRecorded),
    link: explicit !== null ? 'explicit' : reconstructed !== null ? 'reconstructed' : 'none',
    retrievedMemories: retrieved,
    goal: goal === null ? null : goalView(goal),
    plan: plan === null ? null : planView(plan),
    memories:
      actorId === null
        ? []
        : store.memories.forEvent(actorId, event.id as EventId).map(memoryView),
    precedingEvents:
      actorId === null
        ? []
        : store.events
            .forActorBefore(actorId, event.seq, options.precedingEvents ?? 5)
            .map((candidate) => eventView(candidate, names)),
  };
}

/** The goal an event payload names, falling back to what its actor is pursuing. */
function goalOfEvent(store: Store, payload: unknown, actorId: AgentId | null) {
  const named = (payload as { goalId?: GoalId } | null)?.goalId;
  if (typeof named === 'string') {
    const goal = store.goals.find(named);
    if (goal !== null) return goal;
  }
  if (actorId === null) return null;
  const agent = store.agents.find(actorId);
  if (agent === null || agent.currentGoalId === null) return null;
  return store.goals.find(agent.currentGoalId);
}

/** The most recent plan for a goal, active or not — a failed goal has no active
 *  plan, and its last plan is exactly the interesting one. */
function latestPlan(store: Store, goalId: GoalId) {
  const history = store.plans.historyForGoal(goalId);
  return history[history.length - 1] ?? null;
}
