/**
 * Communication between agents, as first-class events (requirements 10 and 14).
 *
 * This module is the *only* way knowledge crosses from one agent to another
 * (ADR-0007). There is no shared world model and no visibility filter to forget:
 * if Nadia knows where the iron is and Arun does not, the sole route from her
 * beliefs to his is a message she chose to send and he chose to read. That is
 * what makes requirement 35's knowledge-transfer criterion a demonstration rather
 * than a formality.
 *
 * Four rules the design turns on:
 *
 *  - **Messages have a functional purpose.** `MessageIntent` has three variants —
 *    a discovery, a request, an offer — and no fourth. There is no way to compose
 *    small talk, because small talk generates no coordination and costs tokens to
 *    interpret.
 *  - **Second-hand knowledge is weaker than first-hand.** A told deposit is
 *    entered at a fraction of the confidence of a seen one, scaled by how much
 *    the recipient trusts the teller. Divergence between Arun's rumour and
 *    Mira's own eyes is correct behaviour, not a bug to reconcile.
 *  - **Interpretation is model-gated with a mandatory rule fallback** (ADR-0006).
 *    The rule reads the canonical prose the composers here produce, so the whole
 *    social layer works with no API key.
 *  - **The recipient's own row is the only thing written.** Draining an inbox
 *    reads the sender's *name* — which is observable — and nothing else about it.
 */

import { z } from 'zod';
import { clamp01 } from './agent.ts';
import type { AgentId, EventId, MessageId } from '../core/ids.ts';
import { fail, ok, type Result } from '../core/result.ts';
import {
  formatPosition,
  horizontalDistance,
  RESOURCE_KINDS,
  type Position,
  type ResourceKind,
  type WorldTime,
} from '../core/world.ts';
import type { NewEvent, WorldEvent } from '../events/types.ts';
import {
  describeRelationship,
  LOCATION_KINDS,
  toldBy,
  type LocationKind,
  type Message,
} from '../memory/types.ts';
import type { ReasoningProvider } from '../reasoning/provider.ts';
import type { Store } from '../persistence/store.ts';
import { applyEffects, effectOf, relationshipEffectsOf } from '../civilization/relationships.ts';

// ── What a message may be for ───────────────────────────────────────────────

export const MESSAGE_PURPOSES = ['discovery', 'request', 'offer', 'unclear'] as const;
export type MessagePurpose = (typeof MESSAGE_PURPOSES)[number];

/**
 * A message worth sending. Closed on purpose: every variant carries something the
 * recipient can act on, which is the "no small talk" rule expressed as a type
 * rather than as a guideline in a prompt.
 */
export type MessageIntent =
  | {
      readonly kind: 'discovery';
      /** What the news is about, e.g. `iron`, `the ridge to the north`. */
      readonly subject: string;
      readonly at?: Position;
      readonly resource?: ResourceKind;
      readonly location?: LocationKind;
      readonly estimatedQuantity?: number;
    }
  | {
      readonly kind: 'request';
      /** What is needed, e.g. `20 wood`, `help clearing the site`. */
      readonly need: string;
    }
  | {
      readonly kind: 'offer';
      /** What is on offer, e.g. `12 stone`, `a hand with the shelter`. */
      readonly offering: string;
    };

/**
 * Render an intent as prose.
 *
 * The wording is canonical so the rule-based interpreter can read it back, but it
 * is deliberately *prose* rather than an encoded payload: a message composed by a
 * model will be prose too, and an interpreter that only understands a private
 * encoding would silently learn nothing from every real sentence.
 */
export function composeMessage(intent: MessageIntent): string {
  switch (intent.kind) {
    case 'discovery': {
      const what = intent.resource ?? intent.location?.replace(/_/g, ' ') ?? intent.subject;
      if (intent.at === undefined) {
        return `I found ${what}. I do not have its exact position.`;
      }
      const amount =
        intent.estimatedQuantity === undefined
          ? ''
          : ` — about ${Math.round(intent.estimatedQuantity)} there`;
      return `I found ${what} at ${formatPosition(intent.at)}${amount}.`;
    }
    case 'request':
      return `I need ${intent.need}. Can you help?`;
    case 'offer':
      return `I can offer ${intent.offering}.`;
  }
}

/** Whether an intent actually says something. Guards the send path. */
export function hasFunctionalPurpose(intent: MessageIntent): boolean {
  switch (intent.kind) {
    case 'discovery':
      return intent.subject.trim() !== '' || intent.resource !== undefined || intent.location !== undefined;
    case 'request':
      return intent.need.trim() !== '';
    case 'offer':
      return intent.offering.trim() !== '';
  }
}

// ── Sending ─────────────────────────────────────────────────────────────────

export interface SendDeps {
  readonly store: Store;
  readonly time: WorldTime;
}

export interface SendRequest {
  readonly fromAgentId: AgentId;
  readonly toAgentId: AgentId;
  readonly intent: MessageIntent;
}

/**
 * Send a message and record it in the ledger.
 *
 * Exported for the coordination layer to use; the `send_message` plan step goes
 * through the deterministic executor instead, and both land the same
 * `message_sent` event so the history reads the same either way.
 */
export function tell(deps: SendDeps, request: SendRequest): Result<Message> {
  const { store, time } = deps;

  if (request.fromAgentId === request.toAgentId) {
    return fail('BAD_ARGS', 'an agent cannot tell itself something it already knows', {
      retryable: false,
    });
  }
  if (!hasFunctionalPurpose(request.intent)) {
    // Refused rather than sent empty: a message that conveys nothing still costs
    // the recipient a reasoning call to interpret.
    return fail('BAD_ARGS', 'a message must carry a discovery, a request, or an offer', {
      retryable: false,
    });
  }
  if (store.agents.find(request.toAgentId) === null) {
    return fail('TARGET_CHANGED', 'there is no one here by that name', { retryable: false });
  }

  const content = composeMessage(request.intent);

  return ok(
    store.transaction(() => {
      const message = store.messages.send(request.fromAgentId, request.toAgentId, content, {
        day: time.day,
        worldTicks: time.totalTicks,
      });
      store.events.appendAll(
        [
          {
            type: 'message_sent',
            actorId: request.fromAgentId,
            payload: {
              messageId: message.id as MessageId,
              fromAgentId: request.fromAgentId,
              toAgentId: request.toAgentId,
              content,
            },
          },
        ],
        { day: time.day, worldTicks: time.totalTicks },
      );
      return message;
    }),
  );
}

// ── Interpretation ──────────────────────────────────────────────────────────

const PositionSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });

/**
 * What the recipient makes of a message.
 *
 * Flat and closed, with every optional field nullable rather than absent — the
 * smallest shape a model can produce and still be useful, per ADR-0006.
 */
export const MessageInterpretationSchema = z.object({
  purpose: z.enum(MESSAGE_PURPOSES),
  /** One sentence, first person, stored on the `message_received` event. */
  understanding: z.string().min(1).max(300),
  /** A fact about the world worth adding to the recipient's own beliefs. */
  learned: z
    .object({
      subject: z.string().min(1).max(120),
      resource: z.enum(RESOURCE_KINDS).nullable(),
      location: z.enum(LOCATION_KINDS).nullable(),
      at: PositionSchema.nullable(),
      estimatedQuantity: z.number().min(0).max(4096).nullable(),
    })
    .nullable(),
  /** Does this change what the recipient should be doing right now? */
  reconsiderPlan: z.boolean(),
  /** How believable the message is on its face, 0..1, before trust weighting. */
  credibility: z.number().min(0).max(1),
});

export type MessageInterpretation = z.infer<typeof MessageInterpretationSchema>;
export type LearnedFact = NonNullable<MessageInterpretation['learned']>;

const INTERPRETATION_SYSTEM_PROMPT = [
  'You interpret one message a settler has just received from another settler.',
  'You are given only what the recipient already knows — never what the sender knows.',
  'Decide what the message is for: a discovery, a request, an offer, or unclear.',
  'If it states a fact about the world worth remembering, extract it exactly as stated;',
  'otherwise report that nothing was learned rather than inventing a fact.',
  'Being told something is weaker evidence than seeing it, so keep credibility modest.',
].join(' ');

/**
 * The ceiling on confidence in anything an agent was merely told.
 *
 * First-hand observation enters knowledge at 0.8–0.9. Hearsay must sit below
 * that whatever the teller's reputation, so an agent that walks out and looks for
 * itself always ends up with a firmer belief than one that took someone's word —
 * which is the asymmetry the whole knowledge model rests on (ADR-0007).
 */
export const HEARSAY_CEILING = 0.6;

/** Confidence in a told fact: the ceiling, discounted by credibility and trust. */
export function hearsayConfidence(credibility: number, trust: number): number {
  // Trust maps -1..1 onto a 0.5..1 multiplier: a distrusted teller is heard, but
  // half-heard. It never reaches zero, because people do act on rumours.
  const trustFactor = 0.5 + 0.5 * clamp01((trust + 1) / 2);
  return clamp01(HEARSAY_CEILING * clamp01(credibility) * trustFactor);
}

/**
 * The deterministic interpreter — the mandatory fallback for every
 * `message_interpretation` call, and the whole implementation under
 * `HeuristicProvider`.
 *
 * It reads prose, not a private format: a resource or landmark name, a coordinate
 * triple, an amount. That is enough to carry a discovery, which is the message
 * type knowledge transfer depends on.
 */
export function ruleInterpretation(content: string, senderName: string): MessageInterpretation {
  const purpose = classify(content);
  const at = parsePosition(content);
  const resource = parseResource(content);
  const location = parseLocation(content);
  const quantity = parseQuantity(content);

  // A fact is only learnable when it says *where*. "There is iron somewhere" is
  // not something an agent can act on, and storing it as knowledge would make the
  // agent's beliefs look richer than they are.
  const learnable = purpose === 'discovery' && at !== null && (resource !== null || location !== null);

  const subject =
    resource !== null
      ? `${resource} at ${at === null ? 'an unknown place' : formatPosition(at)}`
      : location !== null
        ? `${location.replace(/_/g, ' ')} at ${at === null ? 'an unknown place' : formatPosition(at)}`
        : 'their news';

  return {
    purpose,
    understanding:
      purpose === 'discovery' && learnable
        ? `${senderName} says there is ${subject}.`
        : purpose === 'request'
          ? `${senderName} needs something from me.`
          : purpose === 'offer'
            ? `${senderName} is offering to help.`
            : `${senderName} said something I could not make use of.`,
    learned: learnable
      ? {
          subject,
          resource,
          location,
          at,
          estimatedQuantity: quantity,
        }
      : null,
    // A discovery only warrants a rethink if it turns out to be news, which is
    // decided against the recipient's own knowledge when the fact is applied.
    // Asking and offering are about coordination, so they always warrant one.
    reconsiderPlan: purpose === 'request' || purpose === 'offer',
    // A discovery that names a place is checkable, so it is worth more than a
    // vague one — but never worth as much as looking.
    credibility: learnable ? 0.9 : purpose === 'unclear' ? 0.3 : 0.6,
  };
}

function classify(content: string): MessagePurpose {
  const text = content.toLowerCase();
  // Requests and offers first: "I need 20 wood" names a resource too, and reading
  // it as a discovery would have the recipient believe in a deposit that the
  // sender was actually asking for.
  if (/\bi need\b|\bcan you\b|\bplease\b|\bi am short of\b/.test(text)) return 'request';
  if (/\bi can offer\b|\bi can help\b|\bi will\b|\bto spare\b|\boffer\b/.test(text)) return 'offer';
  if (/\bi found\b|\bi saw\b|\bthere is\b|\bthere are\b|\bi know of\b/.test(text)) return 'discovery';
  return 'unclear';
}

function parsePosition(content: string): Position | null {
  const match = /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/.exec(
    content,
  );
  if (match === null) return null;
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
}

function parseResource(content: string): ResourceKind | null {
  const text = content.toLowerCase();
  for (const kind of RESOURCE_KINDS) {
    if (new RegExp(`\\b${kind}\\b`).test(text)) return kind;
  }
  return null;
}

function parseLocation(content: string): LocationKind | null {
  const text = content.toLowerCase();
  for (const kind of LOCATION_KINDS) {
    // Underscores read badly in prose, so composed messages say "high ground".
    // Accepting either spelling means a model-written sentence parses too.
    if (new RegExp(`\\b${kind.replace(/_/g, '[ _]')}\\b`).test(text)) return kind;
  }
  return null;
}

function parseQuantity(content: string): number | null {
  const match = /\babout\s+(\d+)\b/.exec(content.toLowerCase());
  return match === null ? null : Number(match[1]);
}

// ── Draining the inbox ──────────────────────────────────────────────────────

export interface MessagingDeps {
  readonly store: Store;
  readonly reasoning: ReasoningProvider;
  readonly time: WorldTime;
  /**
   * Messages handled in one INTEGRATE. Bounded so a flooded inbox cannot make a
   * single tick unbounded — the rest waits for the next tick, unread.
   */
  readonly maxMessages?: number;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface MessageOutcome {
  readonly messageId: MessageId;
  readonly fromAgentId: AgentId;
  readonly purpose: MessagePurpose;
  readonly understanding: string;
  readonly learned: LearnedFact | null;
  /** True when the fact was something the recipient did not already believe. */
  readonly wasNews: boolean;
  /** Confidence the recipient now holds in what it was told. */
  readonly confidence: number;
  readonly reasoned: boolean;
}

export interface InboxOutcome {
  readonly agentId: AgentId;
  readonly outcomes: readonly MessageOutcome[];
  /**
   * Whether the recipient should reconsider its plan. True when it genuinely
   * learned something, or when someone asked it for something — the two cases
   * where carrying on unchanged would be wrong.
   */
  readonly shouldReconsider: boolean;
  /** True when the model was consulted for any of these messages. */
  readonly reasoned: boolean;
  readonly events: readonly WorldEvent[];
}

/**
 * Read and act on everything waiting for one agent. Called at INTEGRATE, where
 * ADR-0001 puts the message drain.
 */
export async function drainInbox(
  agentId: AgentId,
  deps: MessagingDeps,
): Promise<Result<InboxOutcome>> {
  const { store, time } = deps;
  const recipient = store.agents.find(agentId);
  if (recipient === null) {
    return fail('BAD_ARGS', `no such agent ${agentId}`, { retryable: false });
  }

  const waiting = store.messages.inbox(agentId).slice(0, Math.max(1, deps.maxMessages ?? 8));
  if (waiting.length === 0) {
    return ok({ agentId, outcomes: [], shouldReconsider: false, reasoned: false, events: [] });
  }

  const outcomes: MessageOutcome[] = [];
  const recorded: WorldEvent[] = [];
  let shouldReconsider = false;
  let reasoned = false;

  for (const message of waiting) {
    // A name is observable — you can see who is speaking to you. Nothing else
    // about the sender is read here, and there is no repository method that would
    // let it be (ADR-0007).
    const senderName = store.agents.find(message.fromAgentId)?.name ?? 'someone';
    const relationship = store.knowledge.relationship(agentId, message.fromAgentId);

    const answer = await deps.reasoning.reason({
      category: 'message_interpretation',
      agentId,
      system: INTERPRETATION_SYSTEM_PROMPT,
      prompt: describeIncoming({
        recipientName: recipient.name,
        recipientRole: recipient.role,
        senderName,
        content: message.content,
        standing: relationship === null ? 'a stranger' : describeRelationship(relationship),
        alreadyKnows: existingBeliefAbout(store, agentId, message.content),
      }),
      schema: MessageInterpretationSchema,
      fallback: () => ruleInterpretation(message.content, senderName),
    });

    const interpretation = answer.ok
      ? answer.value.value
      : ruleInterpretation(message.content, senderName);
    if (answer.ok && answer.value.source === 'model') reasoned = true;

    const confidence = hearsayConfidence(interpretation.credibility, relationship?.trust ?? 0);
    const applied = applyMessage({
      store,
      time,
      recipientId: agentId,
      senderId: message.fromAgentId,
      message,
      interpretation,
      confidence,
    });

    recorded.push(...applied.events);
    outcomes.push({
      messageId: message.id as MessageId,
      fromAgentId: message.fromAgentId,
      purpose: interpretation.purpose,
      understanding: interpretation.understanding,
      learned: interpretation.learned,
      wasNews: applied.wasNews,
      confidence,
      reasoned: answer.ok && answer.value.source === 'model',
    });

    if (applied.wasNews || interpretation.purpose === 'request') shouldReconsider = true;

    deps.log?.(`${recipient.name} heard from ${senderName}: ${interpretation.understanding}`, {
      agent: agentId,
      purpose: interpretation.purpose,
      news: applied.wasNews,
    });
  }

  return ok({ agentId, outcomes, shouldReconsider, reasoned, events: recorded });
}

interface ApplyArgs {
  readonly store: Store;
  readonly time: WorldTime;
  readonly recipientId: AgentId;
  readonly senderId: AgentId;
  readonly message: Message;
  readonly interpretation: MessageInterpretation;
  readonly confidence: number;
}

/**
 * Fold one interpreted message into the recipient's beliefs and the ledger.
 *
 * All of it in one transaction: the event that says knowledge crossed and the
 * knowledge row that proves it must not be able to diverge, or the chronicle can
 * claim a transfer that left no trace.
 */
function applyMessage(args: ApplyArgs): { wasNews: boolean; events: WorldEvent[] } {
  const { store, time, recipientId, senderId, message, interpretation, confidence } = args;
  const learned = interpretation.learned;

  return store.transaction(() => {
    const wasNews = learned === null ? false : recordLearned(args, learned);

    const pending: NewEvent[] = [
      {
        type: 'message_received',
        actorId: recipientId,
        payload: {
          messageId: message.id as MessageId,
          agentId: recipientId,
          interpretation: interpretation.understanding,
        },
      },
    ];

    // Knowledge crossing between minds is its own event — requirement 35's
    // criterion is asserted against it. Only recorded when something actually
    // crossed, so the ledger cannot overstate what the settlement learned.
    if (learned !== null && wasNews) {
      pending.push({
        type: 'knowledge_shared',
        actorId: senderId,
        payload: {
          fromAgentId: senderId,
          toAgentId: recipientId,
          subject: learned.subject,
          detail: interpretation.understanding,
        },
      });
    }

    const events = store.events.appendAll(pending, {
      day: time.day,
      worldTicks: time.totalTicks,
    });
    const firstEventId = events[0]!.id as EventId;

    // Marked read inside the same transaction as the events it produced: a
    // message that is recorded as received but left unread would be interpreted
    // again next tick, and the ledger would claim the news arrived twice.
    store.messages.markRead([message.id as MessageId], time.totalTicks);

    // What the recipient now believes, and how it came to believe it. Stored at
    // the discounted confidence so a rumour stays legible as a rumour.
    store.memories.insert(
      {
        agentId: recipientId,
        // A learned fact is a belief about the world; a message that taught
        // nothing is merely something that happened.
        type: learned !== null && wasNews ? 'semantic' : 'episodic',
        content: interpretation.understanding,
        importance: wasNews ? 0.55 : 0.25,
        source: toldBy(senderId),
        confidence,
        relatedEntities: [senderId],
        tags: taggedWith(learned),
        eventId: firstEventId,
      },
      { day: time.day, worldTicks: time.totalTicks },
    );

    // The relationship moves because of these events, and points at them. Being
    // spoken to is contact whatever was said; being told something useful is
    // evidence the teller's word is worth having.
    const effects = [
      effectOf('spoke', {
        agentId: recipientId,
        otherAgentId: senderId,
        eventId: firstEventId,
        reason: 'they spoke with me',
      }),
      ...events.flatMap((event) => relationshipEffectsOf(event)),
    ];
    applyEffects(store, effects, time);

    return { wasNews, events };
  });
}

/**
 * Write a told fact into the recipient's own knowledge, sourced `told_by:<id>`.
 * Returns whether it was actually news.
 */
function recordLearned(args: ApplyArgs, learned: LearnedFact): boolean {
  const { store, time, recipientId, senderId, confidence } = args;
  const at = learned.at;
  if (at === null) return false;

  if (learned.resource !== null) {
    const believed = store.knowledge.knownResources(recipientId, learned.resource);
    const nearby = believed.find(
      (known) => horizontalDistance(known.position, at) < 6 && Math.abs(known.position.y - at.y) < 8,
    );

    // Hearsay must never overwrite something the agent saw for itself. Without
    // this guard a rumour would quietly *lower* the confidence of a first-hand
    // belief at the same coordinates, and the agent would stop trusting its eyes.
    if (nearby !== undefined && nearby.confidence >= confidence) return false;

    store.knowledge.rememberResource({
      agentId: recipientId,
      resource: learned.resource,
      position: at,
      // An unquantified rumour is a place worth walking to, not a promised
      // amount, so it enters at the smallest useful estimate.
      estimatedQuantity: learned.estimatedQuantity ?? 1,
      confidence,
      source: toldBy(senderId),
      discoveredAtDay: time.day,
      lastSeenAtTicks: time.totalTicks,
    });
    return nearby === undefined;
  }

  if (learned.location !== null) {
    const already = store.knowledge.knowsLocation(recipientId, at, learned.location);
    store.knowledge.rememberLocation({
      agentId: recipientId,
      position: at,
      kind: learned.location,
      confidence,
      source: toldBy(senderId),
      label: learned.subject,
      discoveredAtDay: time.day,
      lastSeenAtTicks: time.totalTicks,
    });
    return !already;
  }

  return false;
}

function taggedWith(learned: LearnedFact | null): string[] {
  if (learned === null) return ['message'];
  const tags = ['message', 'hearsay'];
  if (learned.resource !== null) tags.push(learned.resource);
  if (learned.location !== null) tags.push(learned.location);
  return tags;
}

/**
 * What the recipient already believes that bears on this message. Its own
 * knowledge only — the point of showing it is so the model can tell news from
 * repetition, not so it can compare notes with the sender.
 */
function existingBeliefAbout(store: Store, agentId: AgentId, content: string): string {
  const resource = parseResource(content);
  if (resource === null) return 'nothing on this subject';
  const known = store.knowledge.knownResources(agentId, resource);
  if (known.length === 0) return `you know of no ${resource} anywhere`;
  return known
    .slice(0, 3)
    .map(
      (entry) =>
        `${resource} at ${formatPosition(entry.position)} (${Math.round(entry.confidence * 100)}% sure)`,
    )
    .join('; ');
}

function describeIncoming(parts: {
  recipientName: string;
  recipientRole: string;
  senderName: string;
  content: string;
  standing: string;
  alreadyKnows: string;
}): string {
  return [
    `You are ${parts.recipientName}, ${parts.recipientRole}.`,
    `${parts.senderName} (${parts.standing}) says: "${parts.content}"`,
    `What you already know: ${parts.alreadyKnows}.`,
  ].join('\n');
}
