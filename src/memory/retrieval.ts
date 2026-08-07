/**
 * Selective retrieval.
 *
 * An agent brings the memories *relevant to the decision in front of it* — not
 * everything it has ever recorded. That is requirement 11 (memory must actually
 * inform behaviour) and requirement 29 (prompts stay small) meeting in one
 * place: a prompt built from every memory is both expensive and useless, because
 * the one line that mattered is buried in fifty that didn't.
 *
 * Scoring is deliberately deterministic and cheap. Four terms, each answering a
 * different question about a memory:
 *
 *  - **recency** — was this recently in mind? Decays with elapsed world ticks,
 *    so a long-running civilization forgets the texture of last week.
 *  - **importance** — did it matter when it happened?
 *  - **relevance** — is it about *this*? Tag, entity and keyword overlap with
 *    the query. Without this term retrieval is just "the last N things".
 *  - **usage** — has it proved useful before? An access count keeps a memory
 *    that has repeatedly helped reachable after its recency has gone.
 *
 * No model is involved. Retrieval scoring is exactly the sort of repetitive
 * work ADR-0006 keeps deterministic.
 */

import { clamp01 } from '../agents/agent.ts';
import type { AgentId, MemoryId } from '../core/ids.ts';
import type { Position } from '../core/world.ts';
import type { MemoryFilter } from '../persistence/repositories/memories.ts';
import type { Store } from '../persistence/store.ts';
import type { MemoryEntry, MemoryType } from './types.ts';

/**
 * What the agent is currently thinking about.
 *
 * Structured rather than a bare string so relevance can be computed without
 * guessing: `tags` and `entities` are exact signals the writer of the memory
 * chose, and `text` is the loose one. A query that supplies none of them still
 * works — it just ranks on recency, importance and usage alone.
 */
export interface RetrievalQuery {
  /** Tags to match against `MemoryEntry.tags`, e.g. `['iron', 'northern ridge']`. */
  readonly tags?: readonly string[];
  /** Agents, goals, structures or places the decision concerns. */
  readonly entities?: readonly string[];
  /** Free text — the goal, the failure, the question being asked. */
  readonly text?: string;
}

export interface RetrievalWeights {
  readonly recency: number;
  readonly importance: number;
  readonly relevance: number;
  readonly usage: number;
}

/**
 * Relevance leads. Retrieval exists to be selective, and a set weighted mainly
 * on recency would return the same recent memories for every decision — which
 * is the behaviour this module exists to replace.
 */
export const DEFAULT_WEIGHTS: RetrievalWeights = {
  recency: 0.3,
  importance: 0.25,
  relevance: 0.35,
  usage: 0.1,
};

/** One world day. A memory a day old counts half as fresh as a new one. */
export const RECENCY_HALF_LIFE_TICKS = 24_000;

/** Access count at which the usage term reaches half its maximum. Low, because
 *  the difference between "never used" and "used twice" is the informative one. */
export const USAGE_HALF_SATURATION = 3;

/**
 * Multiplier for memories already folded into a higher-level belief.
 *
 * Not zero: requirement 12 keeps the evidence behind a belief retrievable, so
 * "why do you think that?" is answerable. It is simply outranked by the belief
 * itself, which is the point of having formed one.
 */
export const CONSOLIDATED_WEIGHT = 0.5;

/** Matches the `memory.retrieval_limit` default; pass the configured value. */
export const DEFAULT_RETRIEVAL_LIMIT = 10;

export interface RetrievalOptions {
  /** Current world time. Required — recency is meaningless without it. */
  readonly atTicks: number;
  readonly limit?: number;
  readonly weights?: Partial<RetrievalWeights>;
  /** Narrow the candidate set, e.g. to `['semantic']` for beliefs only. */
  readonly types?: readonly MemoryType[];
  readonly minImportance?: number;
  /** Score below which a memory is not worth a prompt slot. */
  readonly minScore?: number;
  readonly halfLifeTicks?: number;
  readonly consolidatedWeight?: number;
  /** Whether retrieval counts as use. Default true; the CLI turns it off so
   *  inspecting an agent's memory does not change that agent's future. */
  readonly markAccessed?: boolean;
}

export interface ScoreComponents {
  readonly recency: number;
  readonly importance: number;
  readonly relevance: number;
  readonly usage: number;
}

export interface ScoredMemory {
  readonly memory: MemoryEntry;
  readonly score: number;
  /** Every term, so a surprising retrieval can be explained (ADR-0008). */
  readonly components: ScoreComponents;
  /** True when the score was reduced because a belief has superseded this. */
  readonly consolidated: boolean;
}

// ── Individual terms ────────────────────────────────────────────────────────

/**
 * How fresh a memory is.
 *
 * Measured from the last time it was *in mind* — created or retrieved — rather
 * than from creation alone. A memory an agent keeps returning to is not stale
 * just because the episode was long ago.
 */
export function recencyScore(
  memory: MemoryEntry,
  atTicks: number,
  halfLifeTicks = RECENCY_HALF_LIFE_TICKS,
): number {
  const lastInMind = Math.max(memory.createdAtTicks, memory.lastAccessedAtTicks);
  const elapsed = Math.max(0, atTicks - lastInMind);
  return 0.5 ** (elapsed / Math.max(1, halfLifeTicks));
}

/** Saturating, so a memory used fifty times does not crowd out everything else. */
export function usageScore(memory: MemoryEntry): number {
  const count = Math.max(0, memory.accessCount);
  return count / (count + USAGE_HALF_SATURATION);
}

/**
 * Words too common to carry a signal. Short rather than exhaustive: a stopword
 * list that removes real content is worse than one that leaves noise in, since
 * every term is normalised by how many query words matched.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'was', 'were', 'with', 'this', 'that', 'from', 'into',
  'have', 'has', 'had', 'not', 'but', 'you', 'your', 'its', 'his', 'her',
  'there', 'here', 'when', 'then', 'than', 'they', 'them', 'their', 'about',
  'are', 'been', 'being', 'will', 'would', 'could', 'should', 'while',
]);

function normaliseTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** Content words, lowercased and deduplicated. */
function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of text.toLowerCase().split(/[^a-z0-9:_-]+/)) {
    if (token.length < 3) continue;
    if (STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

/** Everything about a memory a keyword may legitimately match. */
function searchableText(memory: MemoryEntry): string {
  return [memory.content, ...memory.tags, ...memory.relatedEntities].join(' ');
}

/**
 * Sub-weights within relevance. An exact entity match is the strongest signal
 * available — the writer named that thing — and free text the weakest.
 */
const RELEVANCE_SUB_WEIGHTS = { entities: 1, tags: 0.9, text: 0.6 } as const;

/**
 * How much this memory is about what the agent is thinking about, 0..1.
 *
 * Normalised by the parts of the query that were actually supplied, so a
 * tags-only query is not penalised for having no free text.
 */
export function relevanceScore(memory: MemoryEntry, query: RetrievalQuery): number {
  let weighted = 0;
  let total = 0;

  const wantedTags = (query.tags ?? []).map(normaliseTag).filter((tag) => tag.length > 0);
  if (wantedTags.length > 0) {
    const held = new Set(memory.tags.map(normaliseTag));
    const hits = wantedTags.filter((tag) => held.has(tag)).length;
    weighted += RELEVANCE_SUB_WEIGHTS.tags * (hits / wantedTags.length);
    total += RELEVANCE_SUB_WEIGHTS.tags;
  }

  const wantedEntities = (query.entities ?? [])
    .map(normaliseTag)
    .filter((entity) => entity.length > 0);
  if (wantedEntities.length > 0) {
    const held = new Set(memory.relatedEntities.map(normaliseTag));
    const hits = wantedEntities.filter((entity) => held.has(entity)).length;
    weighted += RELEVANCE_SUB_WEIGHTS.entities * (hits / wantedEntities.length);
    total += RELEVANCE_SUB_WEIGHTS.entities;
  }

  const wantedWords = keywords(query.text ?? '');
  if (wantedWords.size > 0) {
    const held = keywords(searchableText(memory));
    let hits = 0;
    for (const word of wantedWords) {
      if (held.has(word)) hits++;
    }
    weighted += RELEVANCE_SUB_WEIGHTS.text * (hits / wantedWords.size);
    total += RELEVANCE_SUB_WEIGHTS.text;
  }

  return total === 0 ? 0 : weighted / total;
}

// ── Combining them ──────────────────────────────────────────────────────────

export function scoreMemory(
  memory: MemoryEntry,
  query: RetrievalQuery,
  options: RetrievalOptions,
): ScoredMemory {
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const components: ScoreComponents = {
    recency: recencyScore(memory, options.atTicks, options.halfLifeTicks),
    importance: clamp01(memory.importance),
    relevance: relevanceScore(memory, query),
    usage: usageScore(memory),
  };

  const weightTotal = weights.recency + weights.importance + weights.relevance + weights.usage;
  const raw =
    weightTotal <= 0
      ? 0
      : (components.recency * weights.recency +
          components.importance * weights.importance +
          components.relevance * weights.relevance +
          components.usage * weights.usage) /
        weightTotal;

  const consolidated = memory.consolidatedInto !== null;
  const penalty = consolidated ? (options.consolidatedWeight ?? CONSOLIDATED_WEIGHT) : 1;

  return { memory, score: raw * penalty, components, consolidated };
}

/**
 * Score, rank and cut. Pure — no store, no side effects — so scoring can be
 * tested and explained on its own.
 *
 * Ties are broken by importance, then age, then id, so the same memories in the
 * same situation always produce the same ordering. A retrieval that shuffled on
 * ties would make agent behaviour irreproducible for no benefit.
 */
export function scoreMemories(
  memories: readonly MemoryEntry[],
  query: RetrievalQuery,
  options: RetrievalOptions,
): ScoredMemory[] {
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_RETRIEVAL_LIMIT));
  const minScore = options.minScore ?? 0;

  return memories
    .map((memory) => scoreMemory(memory, query, options))
    .filter((scored) => scored.score >= minScore)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.memory.importance - a.memory.importance ||
        b.memory.createdAtTicks - a.memory.createdAtTicks ||
        (a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0),
    )
    .slice(0, limit);
}

/**
 * Retrieve this agent's most relevant memories, and record that they were used.
 *
 * `agentId` is the knowledge boundary: the candidate set comes from
 * `MemoryRepository.candidates`, which cannot see another agent's rows
 * (ADR-0007).
 *
 * Marking access is the feedback loop that makes the usage term mean something.
 * It also means the returned entries' `accessCount` is one behind the stored
 * row — read it back if the exact count matters.
 */
export function retrieve(
  store: Store,
  agentId: AgentId,
  query: RetrievalQuery,
  options: RetrievalOptions,
): ScoredMemory[] {
  const filter: MemoryFilter = {
    ...(options.types !== undefined ? { types: options.types } : {}),
    ...(options.minImportance !== undefined ? { minImportance: options.minImportance } : {}),
  };

  const scored = scoreMemories(store.memories.candidates(agentId, filter), query, options);

  if (options.markAccessed !== false && scored.length > 0) {
    store.memories.markAccessed(
      agentId,
      scored.map((entry) => entry.memory.id),
      options.atTicks,
    );
  }

  return scored;
}

// ── Shaping retrieved memories for their consumers ──────────────────────────

/** The lines to put in a prompt. */
export function retrievedContents(retrieved: readonly ScoredMemory[]): string[] {
  return retrieved.map((entry) => entry.memory.content);
}

/** The ids to store on the decision row, so "which memories?" is answerable. */
export function retrievedIds(retrieved: readonly ScoredMemory[]): MemoryId[] {
  return retrieved.map((entry) => entry.memory.id);
}

/** A one-line explanation of why a memory came back, for `worldloom why`. */
export function explainRetrieval(entry: ScoredMemory): string {
  const { recency, importance, relevance } = entry.components;
  const pct = (value: number): string => `${Math.round(value * 100)}%`;
  const suffix = entry.consolidated ? ', superseded by a belief' : '';
  return (
    `${entry.memory.content} ` +
    `(score ${entry.score.toFixed(2)}: relevance ${pct(relevance)}, recency ${pct(recency)}, ` +
    `importance ${pct(importance)}, used ${entry.memory.accessCount}×${suffix})`
  );
}

/**
 * A coarse, stable tag for a place.
 *
 * Memories tagged with one of these are retrievable by asking about that place,
 * which is what makes "I failed here before" reachable when the agent considers
 * the same ground again. Quantised to a cell so "the same place" tolerates the
 * few blocks an agent drifts while working, and elevation is ignored because a
 * deposit two blocks lower is the same site.
 */
export function placeTag(position: Position, cellSize = 16): string {
  const size = Math.max(1, Math.floor(cellSize));
  return `place:${Math.floor(position.x / size)},${Math.floor(position.z / size)}`;
}
