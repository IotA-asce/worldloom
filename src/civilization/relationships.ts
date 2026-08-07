/**
 * Relationships driven by events, never by narration (requirement 13).
 *
 * The rule this module exists to enforce is requirement 47's: **a relationship
 * never changes without an event explaining why.** So nothing here takes a bare
 * "make them friendlier" instruction. Every write is derived from a stored
 * `WorldEvent`, carries that event's id, and carries a sentence a reader can
 * check against the ledger. "Why does Nadia trust Arun?" is answerable by
 * following `last_event_id`, not by guessing.
 *
 * Three further properties:
 *
 *  - **Asymmetry.** Effects name whose *view* changes. Arun telling Nadia where
 *    the iron is moves Nadia's trust in Arun, not Arun's in Nadia. Asymmetry is
 *    where social dynamics come from.
 *  - **Familiarity only rises.** It records that contact happened, and contact
 *    cannot un-happen. A quarrel lowers trust and affinity; it does not make two
 *    people strangers again.
 *  - **Applying the same event twice is a no-op.** The batch helper exists so a
 *    caller can hand over "the last N events", and a caller that does that on
 *    every tick would otherwise compound the same interaction repeatedly.
 */

import type { AgentId, EventId } from '../core/ids.ts';
import { isId } from '../core/ids.ts';
import type { WorldTime } from '../core/world.ts';
import type { EventPayloads, NewEvent, WorldEvent } from '../events/types.ts';
import type { Relationship } from '../memory/types.ts';
import type { Store } from '../persistence/store.ts';

/** A movement in one agent's view of another. */
export interface RelationshipEffect {
  /** Whose view changes. */
  readonly agentId: AgentId;
  /** Who it changes about. */
  readonly otherAgentId: AgentId;
  /** Reliability: -1..1. Moves when someone's word turns out to be good or bad. */
  readonly trust: number;
  /** Liking: -1..1. */
  readonly affinity: number;
  /** Never negative — see the note above. */
  readonly familiarity: number;
  /** The sentence stored on the row, in the first person. */
  readonly reason: string;
  /** The event that caused this. Requirement 47's whole point. */
  readonly eventId: EventId;
}

interface Delta {
  readonly trust: number;
  readonly affinity: number;
  readonly familiarity: number;
}

/**
 * The social model, as one table.
 *
 * Keeping the magnitudes together makes the model legible and tunable, and makes
 * the shape of the intended behaviour obvious: acts of substance (handing over
 * resources, building something together) move trust several times more than
 * merely being in contact does, and no single interaction moves anything far.
 *
 * `took_resources`, `refused_to_help` and `caused_harm` are the negative half of
 * requirement 13. They are deliberately present and unwired: no event in the
 * current vocabulary attributes theft, a refusal, or an injury to a second agent,
 * so nothing can honestly produce them yet. When such an event exists, mapping it
 * is one entry in `relationshipEffectsOf` rather than a new model.
 */
export const RELATIONSHIP_DELTAS = {
  /** They told me something that turned out to be worth knowing. */
  shared_information: { trust: 0.08, affinity: 0.05, familiarity: 0.08 },
  /** They handed over resources they had gathered themselves. */
  gave_resources: { trust: 0.15, affinity: 0.12, familiarity: 0.1 },
  /** They stood with me when it was dangerous. */
  helped_in_danger: { trust: 0.2, affinity: 0.18, familiarity: 0.12 },
  /** We raised the same structure. */
  built_together: { trust: 0.1, affinity: 0.1, familiarity: 0.12 },
  /** We spoke. Contact, not evidence — familiarity only. */
  spoke: { trust: 0, affinity: 0, familiarity: 0.04 },
  /** They asked me for something. Asking is neither reliable nor unreliable. */
  asked_for_help: { trust: 0, affinity: 0, familiarity: 0.04 },
  /** They were on the ground I needed. Not a betrayal — but not nothing either. */
  blocked_my_work: { trust: 0, affinity: -0.06, familiarity: 0.03 },
  /** They took what I had gathered. */
  took_resources: { trust: -0.2, affinity: -0.15, familiarity: 0.05 },
  /** They would not help when I asked. */
  refused_to_help: { trust: -0.12, affinity: -0.1, familiarity: 0.05 },
  /** They hurt me. */
  caused_harm: { trust: -0.35, affinity: -0.3, familiarity: 0.08 },
} as const satisfies Record<string, Delta>;

export type SocialActKind = keyof typeof RELATIONSHIP_DELTAS;

export interface EffectSubject {
  readonly agentId: AgentId;
  readonly otherAgentId: AgentId;
  readonly eventId: EventId;
  readonly reason: string;
}

/** Build an effect from the table. The only way to make one, so the magnitudes
 *  cannot be invented at a call site. */
export function effectOf(kind: SocialActKind, subject: EffectSubject): RelationshipEffect {
  const delta = RELATIONSHIP_DELTAS[kind];
  return {
    agentId: subject.agentId,
    otherAgentId: subject.otherAgentId,
    trust: delta.trust,
    affinity: delta.affinity,
    // Guarded here as well as in the table: familiarity rising only is a rule
    // about the model, not a property of these particular numbers.
    familiarity: Math.max(0, delta.familiarity),
    reason: subject.reason,
    eventId: subject.eventId,
  };
}

// ── Events → effects ────────────────────────────────────────────────────────

/**
 * What one event does to the relationships of the agents involved.
 *
 * Only events that name *both* parties can produce an effect. That is a real
 * limit and a deliberate one: attributing a relationship change to an event that
 * does not identify who it was with would mean guessing, and a guessed reason is
 * exactly what requirement 47 rules out.
 */
export function relationshipEffectsOf(event: WorldEvent): RelationshipEffect[] {
  const eventId = event.id as EventId;

  switch (event.type) {
    case 'knowledge_shared': {
      const payload = event.payload as EventPayloads['knowledge_shared'];
      // The recipient learns whether the teller's word is worth having; the
      // teller only learns that they now know this person better.
      return [
        effectOf('shared_information', {
          agentId: payload.toAgentId,
          otherAgentId: payload.fromAgentId,
          eventId,
          reason: `they told me about ${payload.subject}`,
        }),
        effectOf('spoke', {
          agentId: payload.fromAgentId,
          otherAgentId: payload.toAgentId,
          eventId,
          reason: `I told them about ${payload.subject}`,
        }),
      ];
    }

    case 'resource_transferred': {
      const payload = event.payload as EventPayloads['resource_transferred'];
      return [
        effectOf('gave_resources', {
          agentId: payload.toAgentId,
          otherAgentId: payload.fromAgentId,
          eventId,
          reason: `they gave me what they had gathered — ${payload.reason}`,
        }),
        effectOf('spoke', {
          agentId: payload.fromAgentId,
          otherAgentId: payload.toAgentId,
          eventId,
          reason: `I gave them what I had gathered — ${payload.reason}`,
        }),
      ];
    }

    case 'message_sent': {
      const payload = event.payload as EventPayloads['message_sent'];
      return [
        effectOf('spoke', {
          agentId: payload.fromAgentId,
          otherAgentId: payload.toAgentId,
          eventId,
          reason: 'I spoke with them',
        }),
      ];
    }

    case 'structure_completed': {
      const payload = event.payload as EventPayloads['structure_completed'];
      // Everyone who worked on it, in both directions. Building a roof together
      // is the strongest ordinary evidence of reliability the settlement has.
      const effects: RelationshipEffect[] = [];
      for (const builder of payload.builders) {
        for (const other of payload.builders) {
          if (builder === other) continue;
          effects.push(
            effectOf('built_together', {
              agentId: builder,
              otherAgentId: other,
              eventId,
              reason: `we raised the ${payload.type} together`,
            }),
          );
        }
      }
      return effects;
    }

    case 'action_failed': {
      const payload = event.payload as EventPayloads['action_failed'];
      // A refused reservation is the one negative interaction the current event
      // vocabulary can attribute: the holder's id is in the failure detail
      // because that is the agent the planner is meant to go and negotiate with.
      if (payload.failureKind !== 'REGION_RESERVED') return [];
      const holder = firstAgentIdIn(payload.detail);
      if (holder === null || holder === payload.agentId) return [];
      return [
        effectOf('blocked_my_work', {
          agentId: payload.agentId,
          otherAgentId: holder,
          eventId,
          reason: 'they were working on the ground I needed',
        }),
      ];
    }

    // `relationship_changed` is deliberately inert: it is the *record* of an
    // effect, and mapping it back to an effect would make relationships compound
    // themselves without any new interaction happening.
    default:
      return [];
  }
}

/**
 * Turn a batch of recent events into the relationship updates they imply.
 *
 * Effects on the same pair from the same event are merged, so one event moves one
 * relationship exactly once — which is also what makes the already-applied guard
 * in `applyEffects` reliable.
 */
export function relationshipUpdatesFrom(
  events: readonly WorldEvent[],
): RelationshipEffect[] {
  const merged = new Map<string, RelationshipEffect>();
  for (const event of events) {
    for (const effect of relationshipEffectsOf(event)) {
      if (effect.agentId === effect.otherAgentId) continue;
      const key = `${effect.eventId}|${effect.agentId}|${effect.otherAgentId}`;
      const existing = merged.get(key);
      merged.set(
        key,
        existing === undefined
          ? effect
          : {
              ...existing,
              trust: existing.trust + effect.trust,
              affinity: existing.affinity + effect.affinity,
              familiarity: existing.familiarity + effect.familiarity,
              reason: `${existing.reason}; ${effect.reason}`,
            },
      );
    }
  }
  return [...merged.values()];
}

// ── Applying ────────────────────────────────────────────────────────────────

export interface RelationshipChange {
  readonly effect: RelationshipEffect;
  readonly relationship: Relationship;
}

/**
 * Write a set of effects.
 *
 * A `relationship_changed` event is appended only when trust or affinity actually
 * moved. Familiarity ticking up because two settlers exchanged a message is not
 * news, and recording it as such would bury the interactions that matter under
 * routine contact when the chronicle comes to select from the ledger.
 */
export function applyEffects(
  store: Store,
  effects: readonly RelationshipEffect[],
  time: WorldTime,
): RelationshipChange[] {
  if (effects.length === 0) return [];

  return store.transaction(() => {
    const changes: RelationshipChange[] = [];
    const events: NewEvent[] = [];

    for (const effect of effects) {
      if (effect.agentId === effect.otherAgentId) continue;
      // Both parties must exist. An effect naming someone who has been removed
      // would otherwise fail a foreign key and take the whole tick with it.
      if (store.agents.find(effect.agentId) === null) continue;
      if (store.agents.find(effect.otherAgentId) === null) continue;

      const before = store.knowledge.relationship(effect.agentId, effect.otherAgentId);
      // Already applied: the row's last event is this event. Makes handing the
      // same batch over twice harmless.
      if (before !== null && before.lastEventId === effect.eventId) continue;

      const relationship = store.knowledge.adjustRelationship(
        effect.agentId,
        effect.otherAgentId,
        {
          trust: effect.trust,
          affinity: effect.affinity,
          familiarity: Math.max(0, effect.familiarity),
          reason: effect.reason,
          eventId: effect.eventId,
        },
        time.totalTicks,
      );
      changes.push({ effect, relationship });

      if (effect.trust !== 0 || effect.affinity !== 0) {
        events.push({
          type: 'relationship_changed',
          actorId: effect.agentId,
          payload: {
            agentId: effect.agentId,
            otherAgentId: effect.otherAgentId,
            trustDelta: effect.trust,
            affinityDelta: effect.affinity,
            reason: effect.reason,
          },
        });
      }
    }

    if (events.length > 0) {
      store.events.appendAll(events, { day: time.day, worldTicks: time.totalTicks });
    }

    return changes;
  });
}

/** The usual entry point: hand over recent events, get the relationships they moved. */
export function applyRelationshipEffects(
  store: Store,
  events: readonly WorldEvent[],
  time: WorldTime,
): RelationshipChange[] {
  return applyEffects(store, relationshipUpdatesFrom(events), time);
}

/**
 * Fold every relevant event since `sinceSeq` into relationships, and report the
 * sequence reached so the next sweep can carry on from there.
 *
 * Useful for catching up after a restart, when events landed while nothing was
 * watching. Idempotent, but the cursor is what keeps it cheap.
 */
export function catchUpRelationships(
  store: Store,
  sinceSeq: number,
  time: WorldTime,
): { changes: RelationshipChange[]; throughSeq: number } {
  const events = store.events.query({ sinceSeq });
  const changes = applyRelationshipEffects(store, events, time);
  const throughSeq = events.reduce((max, event) => Math.max(max, event.seq), sinceSeq);
  return { changes, throughSeq };
}

/** The first agent id embedded in a free-text failure detail, if there is one. */
function firstAgentIdIn(text: string): AgentId | null {
  for (const token of text.split(/[\s,.:;()]+/)) {
    if (isId(token, 'agent')) return token;
  }
  return null;
}
