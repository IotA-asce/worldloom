/**
 * Reflection: episodic runs become semantic beliefs.
 *
 * An agent that only ever holds episodes ("I dug at (142, 68, -91) and found
 * nothing") never learns anything. What changes behaviour is the generalisation
 * drawn from a run of them ("the ground north of camp is barren") — a shorter,
 * longer-lived statement that survives the decay of the episodes behind it.
 *
 * Three properties this file is careful about:
 *
 *  - **The belief points at its evidence.** Its `source` is `inferred` from the
 *    episode ids, and those episodes are marked `consolidated_into` the belief
 *    rather than deleted, so "why do you believe that?" is a query
 *    (ADR-0007, requirement 12).
 *  - **The rule is genuinely usable.** Every `ReasoningRequest` must carry a
 *    deterministic fallback (ADR-0006), and the whole test suite runs on
 *    `HeuristicProvider` — so `ruleReflection` *is* the behaviour most of the
 *    time, not a placeholder. It generalises over the structured signals a
 *    memory already carries (tags, entities, outcome) instead of trying to
 *    parse prose, which is the only way a rule can do this honestly.
 *  - **Reflecting is bounded.** Only unconsolidated episodes are considered, and
 *    the ones a belief was drawn from are marked, so the same evidence cannot
 *    produce the same belief twice.
 */

import { z } from 'zod';
import { clamp01 } from '../agents/agent.ts';
import type { AgentId, MemoryId } from '../core/ids.ts';
import { ok, type Result } from '../core/result.ts';
import type { WorldTime } from '../core/world.ts';
import type { Store } from '../persistence/store.ts';
import type { AnswerSource, ReasoningProvider } from '../reasoning/provider.ts';
import { inferredFrom, type MemoryEntry } from './types.ts';

/**
 * What a reflection produces. Flat and small: the model has the least possible
 * room to return something unusable, and a rule can fill every field
 * (ADR-0006's discipline on schema design).
 */
export const ReflectionSchema = z.object({
  /** The generalisation, in the agent's own voice. One or two sentences. */
  belief: z.string().min(1).max(240),
  /** What the belief is about — a tag, a place, a resource, another agent. */
  subject: z.string().min(1).max(60),
  importance: z.number().min(0).max(1),
  /** How firmly it is held. Mixed evidence should produce a lower number. */
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string().min(1).max(48)).max(6),
});

export type Reflection = z.infer<typeof ReflectionSchema>;

export const REFLECTION_SYSTEM_PROMPT = [
  'A settler is looking back over what has happened to them recently.',
  'From the episodes given, state one general belief they can now hold —',
  'something more durable than any single episode, and useful for deciding what to do next.',
  'Prefer a belief about a place, a resource, or another settler over a vague mood.',
  'Only claim what the episodes support, and lower the confidence when they disagree.',
].join(' ');

/** Fewer episodes than this is an anecdote, not a pattern. */
export const MIN_EPISODES_TO_REFLECT = 2;

/** How many recent episodes a single reflection may generalise over. */
export const DEFAULT_REFLECTION_WINDOW = 24;

// ── How an episode turned out ───────────────────────────────────────────────

export type EpisodeOutcome = 'failure' | 'success' | 'neutral';

/**
 * Tags that state how an episode turned out.
 *
 * Writers of memories are encouraged to apply one, because it lets the
 * rule-based path be as reliable as the model's: reading a tag cannot
 * misinterpret anything, and reading prose can.
 */
export const FAILURE_TAG = 'outcome:failure';
export const SUCCESS_TAG = 'outcome:success';

export function outcomeTag(succeeded: boolean): string {
  return succeeded ? SUCCESS_TAG : FAILURE_TAG;
}

/** Tags that describe an outcome rather than a subject, so they never become
 *  what a belief is *about*. */
const OUTCOME_TAGS: ReadonlySet<string> = new Set([FAILURE_TAG, SUCCESS_TAG]);

export function isOutcomeTag(tag: string): boolean {
  return OUTCOME_TAGS.has(tag.trim().toLowerCase());
}

/**
 * Words that betray how an episode went, for memories written without an
 * outcome tag. Crude — a model reads intent far better — but it is a floor, not
 * a ceiling, and it is deterministic.
 */
const FAILURE_WORDS: readonly string[] = [
  'failed', 'fail', 'unable', 'could not', 'couldn\'t', 'nothing', 'empty',
  'exhausted', 'blocked', 'abandoned', 'gave up', 'ran out', 'lost', 'barren',
  'refused', 'injured', 'attacked', 'starving', 'no longer',
];

const SUCCESS_WORDS: readonly string[] = [
  'found', 'gathered', 'harvested', 'built', 'completed', 'finished', 'reached',
  'arrived', 'discovered', 'succeeded', 'shared', 'ate', 'rested', 'placed',
];

function countMatches(text: string, words: readonly string[]): number {
  let hits = 0;
  for (const word of words) {
    if (text.includes(word)) hits++;
  }
  return hits;
}

/** Outcome tag if present; otherwise a lexicon reading of the content. */
export function classifyOutcome(memory: MemoryEntry): EpisodeOutcome {
  const tags = memory.tags.map((tag) => tag.trim().toLowerCase());
  if (tags.includes(FAILURE_TAG)) return 'failure';
  if (tags.includes(SUCCESS_TAG)) return 'success';

  const text = memory.content.toLowerCase();
  const bad = countMatches(text, FAILURE_WORDS);
  const good = countMatches(text, SUCCESS_WORDS);
  if (bad > good) return 'failure';
  if (good > bad) return 'success';
  return 'neutral';
}

// ── The deterministic reflection ────────────────────────────────────────────

interface Subject {
  readonly name: string;
  readonly supporting: readonly MemoryEntry[];
}

/** Whether a memory is about `subject`, by the exact signals it carries. */
function mentions(memory: MemoryEntry, subject: string): boolean {
  const wanted = subject.toLowerCase();
  return (
    memory.tags.some((tag) => tag.trim().toLowerCase() === wanted) ||
    memory.relatedEntities.some((entity) => entity.trim().toLowerCase() === wanted)
  );
}

/**
 * What the run of episodes is mostly about.
 *
 * Tags first, because they are what a memory's writer chose to index it by;
 * related entities as a second source.
 *
 * Ties are common — a memory tagged `['northern ridge', 'iron']` votes equally
 * for both — and are broken by where the handle sits in the memory's own tag
 * list, because the writer put the primary subject first. Summed importance and
 * then alphabetical order settle the rest, so the same run always yields the
 * same subject.
 */
function dominantSubject(memories: readonly MemoryEntry[]): Subject | null {
  const counts = new Map<
    string,
    { count: number; importance: number; order: number; label: string }
  >();

  for (const memory of memories) {
    // A memory should not vote twice for the same subject.
    const seen = new Set<string>();
    let rank = 0;
    for (const raw of [...memory.tags, ...memory.relatedEntities]) {
      const key = raw.trim().toLowerCase();
      if (key.length === 0 || OUTCOME_TAGS.has(key) || seen.has(key)) continue;
      seen.add(key);

      const existing = counts.get(key);
      if (existing === undefined) {
        counts.set(key, { count: 1, importance: memory.importance, order: rank, label: raw.trim() });
      } else {
        existing.count++;
        existing.importance += memory.importance;
        existing.order += rank;
      }
      rank++;
    }
  }

  const ranked = [...counts.entries()].sort(
    (a, b) =>
      b[1].count - a[1].count ||
      a[1].order / a[1].count - b[1].order / b[1].count ||
      b[1].importance - a[1].importance ||
      (a[0] < b[0] ? -1 : 1),
  );

  const best = ranked[0];
  // One mention is an episode; a belief needs something that keeps happening.
  if (best === undefined || best[1].count < MIN_EPISODES_TO_REFLECT) return null;

  const supporting = memories.filter((memory) => mentions(memory, best[0]));
  return { name: best[1].label, supporting };
}

/**
 * The rule-based reflection, used as the fallback for every reflection call and
 * as the whole implementation when running without a model.
 *
 * Returns null when there is nothing general to say — an agent should not invent
 * a belief out of a handful of unrelated episodes, and a null here means the
 * model is never asked, which is also the cheaper answer (requirement 29).
 */
export function ruleReflection(memories: readonly MemoryEntry[]): Reflection | null {
  if (memories.length < MIN_EPISODES_TO_REFLECT) return null;

  const subject = dominantSubject(memories);
  if (subject === null) return null;

  const supporting = subject.supporting;
  const total = supporting.length;
  let failures = 0;
  let successes = 0;
  for (const memory of supporting) {
    const outcome = classifyOutcome(memory);
    if (outcome === 'failure') failures++;
    else if (outcome === 'success') successes++;
  }

  const belief =
    failures >= MIN_EPISODES_TO_REFLECT && failures > successes
      ? `${subject.name} has gone badly for me: ${failures} of ${total} attempts came to nothing.`
      : successes >= MIN_EPISODES_TO_REFLECT && successes > failures
        ? `${subject.name} has been reliable for me: ${successes} of ${total} attempts went well.`
        : `${subject.name} keeps coming up in what I do — ${total} times lately, with mixed results.`;

  const meanImportance =
    supporting.reduce((sum, memory) => sum + memory.importance, 0) / Math.max(1, total);
  // A generalisation outlives the episodes behind it, so it is worth slightly
  // more than their average — otherwise decay erases the lesson with the events.
  const importance = clamp01(meanImportance + 0.15);

  const agreement = Math.max(failures, successes, total - failures - successes) / Math.max(1, total);
  const confidence = clamp01(Math.max(0.3, agreement));

  return {
    belief,
    subject: subject.name,
    importance,
    confidence,
    tags: beliefTags(subject.name, supporting),
  };
}

/** The subject plus the next most common tags, so a belief is retrievable by
 *  the same handles as its evidence. */
function beliefTags(subject: string, supporting: readonly MemoryEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const memory of supporting) {
    for (const tag of memory.tags) {
      const key = tag.trim();
      if (key.length === 0 || OUTCOME_TAGS.has(key.toLowerCase())) continue;
      if (key.toLowerCase() === subject.toLowerCase()) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const others = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 2)
    .map(([tag]) => tag);
  return [subject, ...others];
}

// ── Triggering and running a reflection ─────────────────────────────────────

/**
 * Whether enough has happened to be worth generalising about.
 *
 * Counted in *undigested* episodes, so an agent that has just reflected waits
 * for a fresh run rather than reflecting every tick.
 */
export function shouldReflect(store: Store, agentId: AgentId, interval: number): boolean {
  return store.memories.unconsolidatedCount(agentId) >= Math.max(1, Math.floor(interval));
}

export interface ReflectDeps {
  readonly store: Store;
  readonly reasoning: ReasoningProvider;
  readonly agent: { readonly id: AgentId; readonly name: string };
  readonly time: WorldTime;
  readonly window?: number;
  /** Mark the supporting episodes as folded into the belief. Default true; the
   *  only reason to turn it off is inspecting what a reflection *would* say. */
  readonly markConsolidated?: boolean;
}

export interface ReflectionOutcome {
  /** The belief formed, or null when there was nothing to generalise. */
  readonly belief: MemoryEntry | null;
  /** The episodes it was drawn from. */
  readonly from: readonly MemoryId[];
  /** Where the answer came from, or null when no reasoning call was made. */
  readonly source: AnswerSource | null;
  /** Why nothing happened, when nothing happened. */
  readonly note: string;
}

/**
 * Form one belief from the agent's recent undigested episodes.
 *
 * Returns a `Result`, but only ever a successful one in practice: a reflection
 * that finds no pattern is an outcome (`belief: null`), not a failure, and a
 * model that misbehaves degrades to the rule (ADR-0006, ADR-0008).
 */
export async function reflect(deps: ReflectDeps): Promise<Result<ReflectionOutcome>> {
  const { store, agent, time } = deps;

  // Newest first from the repository; reversed so the prompt reads forwards in
  // time, which is how a person recounts a run of events.
  const episodes = store.memories
    .unconsolidated(agent.id, 'episodic', deps.window ?? DEFAULT_REFLECTION_WINDOW)
    .reverse();

  if (episodes.length < MIN_EPISODES_TO_REFLECT) {
    return ok(nothing('not enough recent experience to generalise from'));
  }

  const rule = ruleReflection(episodes);
  if (rule === null) {
    // Nothing recurs, so there is nothing for a model to find either. Skipping
    // the call is both the correct answer and the cheap one.
    return ok(nothing('nothing recurring in recent experience'));
  }

  const answer = await deps.reasoning.reason({
    category: 'reflection',
    agentId: agent.id,
    system: REFLECTION_SYSTEM_PROMPT,
    prompt: reflectionPrompt(agent.name, episodes),
    schema: ReflectionSchema,
    fallback: () => rule,
  });

  const reflection = answer.ok ? answer.value.value : rule;
  const source: AnswerSource = answer.ok ? answer.value.source : 'fallback';

  // Only the episodes the belief actually rests on become its evidence. The
  // others stay undigested, because claiming them would make `consolidated_into`
  // a lie about where the belief came from.
  const supporting = episodes.filter((memory) => mentions(memory, reflection.subject));
  const evidence = (supporting.length > 0 ? supporting : episodes).map((memory) => memory.id);

  const belief = store.transaction(() => {
    const stored = store.memories.insert(
      {
        agentId: agent.id,
        type: 'semantic',
        content: reflection.belief,
        importance: clamp01(reflection.importance),
        confidence: clamp01(reflection.confidence),
        source: inferredFrom(evidence),
        tags: normaliseTags([reflection.subject, ...reflection.tags]),
        relatedEntities: relatedEntitiesOf(supporting.length > 0 ? supporting : episodes),
      },
      { day: time.day, worldTicks: time.totalTicks },
    );

    if (deps.markConsolidated !== false) {
      store.memories.markConsolidated(agent.id, evidence, stored.id);
    }

    store.events.append(
      {
        type: 'agent_reflected',
        actorId: agent.id,
        payload: {
          agentId: agent.id,
          belief: stored.content,
          fromMemories: evidence.length,
        },
      },
      { day: time.day, worldTicks: time.totalTicks },
    );

    return stored;
  });

  return ok({ belief, from: evidence, source, note: `formed a belief about ${reflection.subject}` });
}

function nothing(note: string): ReflectionOutcome {
  return { belief: null, from: [], source: null, note };
}

/** Deduplicated, non-empty, order-preserving. */
function normaliseTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const trimmed = tag.trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Bounded, so one belief cannot accumulate an unbounded entity list. */
function relatedEntitiesOf(memories: readonly MemoryEntry[], limit = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const memory of memories) {
    for (const entity of memory.relatedEntities) {
      const key = entity.trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      out.push(entity.trim());
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** The situation-specific half of the prompt. Compact by design — a reflection
 *  is cheap work routed to a cheap model (requirement 29). */
export function reflectionPrompt(agentName: string, episodes: readonly MemoryEntry[]): string {
  const lines = episodes.map((memory) => {
    const tags = memory.tags.length > 0 ? ` [${memory.tags.join(', ')}]` : '';
    return `- day ${memory.createdAtDay}: ${memory.content}${tags}`;
  });
  return [`You are ${agentName}. Recently:`, ...lines].join('\n');
}
