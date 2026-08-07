/**
 * Consolidation: merging, decay, and forgetting (requirement 12).
 *
 * Reflection turns a run of episodes into a belief. Consolidation is the
 * housekeeping that keeps the rest of an agent's memory from growing without
 * bound over a long run (risk R10), in three steps that run in this order for a
 * reason:
 *
 *  1. **Merge.** Clusters of low-value episodes about the same subject — twenty
 *     variations on "I walked north" — become one summary that says the same
 *     thing in one line. The originals are marked `consolidated_into` the
 *     summary, not deleted.
 *  2. **Decay.** Everything episodic loses a little importance. Semantic beliefs
 *     are exempt: a lesson learned should outlive the episodes that taught it,
 *     which is the whole point of having formed it.
 *  3. **Forget.** Only what has faded below the floor, is old enough, was folded
 *     into something else, and was never once retrieved. Four conditions,
 *     because a memory that proved useful or that is the sole evidence for a
 *     belief must not quietly vanish.
 *
 * Merging happens before decay so a cluster is summarised at the importance it
 * currently has, and forgetting comes last — excluding whatever this pass just
 * superseded, so a summary and the memories behind it always coexist for at
 * least one pass rather than appearing and losing their evidence at once.
 *
 * Consolidated memories stay retrievable, at reduced weight
 * (`CONSOLIDATED_WEIGHT` in retrieval.ts). The belief's evidence survives.
 */

import { z } from 'zod';
import { clamp01 } from '../agents/agent.ts';
import type { AgentId, MemoryId } from '../core/ids.ts';
import { ok, type Result } from '../core/result.ts';
import type { WorldTime } from '../core/world.ts';
import type { Store } from '../persistence/store.ts';
import type { AnswerSource, ReasoningProvider } from '../reasoning/provider.ts';
import { classifyOutcome, isOutcomeTag } from './reflection.ts';
import { inferredFrom, type MemoryEntry, type MemoryType } from './types.ts';

export const SummarySchema = z.object({
  /** One line standing in for several episodes, in the agent's own voice. */
  summary: z.string().min(1).max(240),
  importance: z.number().min(0).max(1),
  tags: z.array(z.string().min(1).max(48)).max(6),
});

export type Summary = z.infer<typeof SummarySchema>;

export const CONSOLIDATION_SYSTEM_PROMPT = [
  'Several of a settler\'s memories say much the same thing.',
  'Replace them with one sentence that preserves what would still change a decision —',
  'places, resources, people, and how things turned out — and drops the repetition.',
  'Keep it in the first person and do not add anything the memories do not say.',
].join(' ');

export interface ConsolidationOptions {
  /** Total memory count below which consolidation is not worth running. */
  readonly threshold?: number;
  /** Memories above this importance are too valuable to merge away. */
  readonly mergeBelowImportance?: number;
  /** Cluster size below which merging saves nothing. */
  readonly minGroupSize?: number;
  /** Clusters merged per pass, bounding the reasoning calls one pass can make. */
  readonly maxGroups?: number;
  readonly mergeableTypes?: readonly MemoryType[];
  readonly decayFactor?: number;
  readonly decayFloor?: number;
  readonly forgetBelowImportance?: number;
  /** How long a memory is retained regardless of importance, in world ticks. */
  readonly retainTicks?: number;
}

/**
 * Defaults chosen so that nothing is forgotten quickly. The floor decay tends
 * to (0.05) sits below the forgetting threshold (0.08), so a memory can
 * eventually be dropped — but only after three world days and only if it was
 * never retrieved even once.
 */
export const DEFAULT_CONSOLIDATION: Required<ConsolidationOptions> = {
  threshold: 200,
  mergeBelowImportance: 0.4,
  minGroupSize: 3,
  maxGroups: 3,
  mergeableTypes: ['working', 'episodic'],
  decayFactor: 0.9,
  decayFloor: 0.05,
  forgetBelowImportance: 0.08,
  retainTicks: 24_000 * 3,
};

export interface MergedGroup {
  readonly subject: string;
  readonly summary: MemoryEntry;
  readonly from: readonly MemoryId[];
  readonly source: AnswerSource;
}

export interface ConsolidationReport {
  /** False when the agent's memory was below the threshold — nothing was touched. */
  readonly ran: boolean;
  readonly countBefore: number;
  readonly countAfter: number;
  readonly merged: readonly MergedGroup[];
  readonly decayed: number;
  readonly forgotten: number;
}

export function shouldConsolidate(store: Store, agentId: AgentId, threshold: number): boolean {
  return store.memories.count(agentId) >= Math.max(1, Math.floor(threshold));
}

export interface ConsolidateDeps {
  readonly store: Store;
  readonly reasoning: ReasoningProvider;
  readonly agent: { readonly id: AgentId; readonly name: string };
  readonly time: WorldTime;
  readonly options?: ConsolidationOptions;
}

/**
 * Run one consolidation pass for one agent.
 *
 * Safe to call on every day boundary: below the threshold it reports `ran:
 * false` and changes nothing, so the caller does not need its own gate.
 */
export async function consolidate(deps: ConsolidateDeps): Promise<Result<ConsolidationReport>> {
  const { store, agent, time } = deps;
  const settings = { ...DEFAULT_CONSOLIDATION, ...deps.options };
  const countBefore = store.memories.count(agent.id);

  if (countBefore < Math.max(1, Math.floor(settings.threshold))) {
    return ok({
      ran: false,
      countBefore,
      countAfter: countBefore,
      merged: [],
      decayed: 0,
      forgotten: 0,
    });
  }

  const merged: MergedGroup[] = [];
  for (const group of mergeCandidates(store, agent.id, settings)) {
    const rule = ruleSummary(group.subject, group.memories);

    const answer = await deps.reasoning.reason({
      category: 'consolidation',
      agentId: agent.id,
      system: CONSOLIDATION_SYSTEM_PROMPT,
      prompt: summaryPrompt(agent.name, group.subject, group.memories),
      schema: SummarySchema,
      fallback: () => rule,
    });

    const summary = answer.ok ? answer.value.value : rule;
    const source: AnswerSource = answer.ok ? answer.value.source : 'fallback';
    const from = group.memories.map((memory) => memory.id);

    const stored = store.transaction(() => {
      const entry = store.memories.insert(
        {
          agentId: agent.id,
          // Episodic, not semantic: a compressed account of what happened is
          // still an account, so it keeps decaying and can itself be merged or
          // forgotten later. Only a reflection's belief earns exemption.
          type: 'episodic',
          content: summary.summary,
          importance: clamp01(summary.importance),
          confidence: averageConfidence(group.memories),
          source: inferredFrom(from),
          tags: mergeTags(group.subject, summary.tags, group.memories),
          relatedEntities: relatedEntitiesOf(group.memories),
        },
        { day: time.day, worldTicks: time.totalTicks },
      );
      // The originals become the summary's evidence rather than disappearing.
      store.memories.markConsolidated(agent.id, from, entry.id);
      return entry;
    });

    merged.push({ subject: group.subject, summary: stored, from, source });
  }

  const decayed = store.memories.decay(agent.id, settings.decayFactor, settings.decayFloor);
  const forgotten = store.memories.forget(
    agent.id,
    settings.forgetBelowImportance,
    time.totalTicks - Math.max(0, settings.retainTicks),
    // Whatever this pass just superseded gets at least until the next pass. A
    // summary whose evidence was deleted in the same breath would be a claim
    // with nothing behind it.
    merged.flatMap((group) => group.from),
  );

  return ok({
    ran: true,
    countBefore,
    countAfter: store.memories.count(agent.id),
    merged,
    decayed,
    forgotten,
  });
}

// ── Choosing what to merge ──────────────────────────────────────────────────

interface MergeGroup {
  readonly subject: string;
  readonly memories: readonly MemoryEntry[];
}

/**
 * Clusters worth collapsing: low-importance, not already folded into anything,
 * and sharing a subject.
 *
 * Grouped on the memory's first subject tag (falling back to its first related
 * entity), which is the handle its writer chose to index it by. Anything with
 * neither is left alone — a memory with no handle has nothing to be clustered
 * with, and guessing from its prose would produce nonsense merges.
 */
function mergeCandidates(
  store: Store,
  agentId: AgentId,
  settings: Required<ConsolidationOptions>,
): MergeGroup[] {
  const mergeable = new Set<MemoryType>(settings.mergeableTypes);
  const groups = new Map<string, { label: string; memories: MemoryEntry[] }>();

  // Filtering in code rather than SQL: the candidate set is bounded by the
  // threshold that got us here, and the grouping rule belongs with the memory
  // model rather than in a query.
  for (const memory of store.memories.candidates(agentId)) {
    if (!mergeable.has(memory.type)) continue;
    if (memory.consolidatedInto !== null) continue;
    if (memory.importance >= settings.mergeBelowImportance) continue;

    const subject = subjectOf(memory);
    if (subject === null) continue;

    const key = subject.toLowerCase();
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { label: subject, memories: [memory] });
    } else {
      existing.memories.push(memory);
    }
  }

  return [...groups.entries()]
    .filter(([, group]) => group.memories.length >= Math.max(2, settings.minGroupSize))
    // Largest clusters first — they save the most — with a stable tie-break.
    .sort((a, b) => b[1].memories.length - a[1].memories.length || (a[0] < b[0] ? -1 : 1))
    .slice(0, Math.max(0, settings.maxGroups))
    .map(([, group]) => ({
      subject: group.label,
      // Oldest first, so a summary reads chronologically.
      memories: [...group.memories].sort((a, b) => a.createdAtTicks - b.createdAtTicks),
    }));
}

function subjectOf(memory: MemoryEntry): string | null {
  for (const tag of memory.tags) {
    const trimmed = tag.trim();
    if (trimmed.length > 0 && !isOutcomeTag(trimmed)) return trimmed;
  }
  for (const entity of memory.relatedEntities) {
    const trimmed = entity.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

// ── The deterministic summary ───────────────────────────────────────────────

/**
 * The rule-based summary, used as the fallback for every consolidation call and
 * as the whole implementation when running without a model.
 *
 * It cannot write prose, so it does not try. It states what is quantitatively
 * true about the cluster — span, count, how things went — which is precisely
 * the part of a run of episodes that still bears on a decision.
 */
export function ruleSummary(subject: string, memories: readonly MemoryEntry[]): Summary {
  let failures = 0;
  let successes = 0;
  let firstDay = Number.POSITIVE_INFINITY;
  let lastDay = Number.NEGATIVE_INFINITY;
  let peakImportance = 0;

  for (const memory of memories) {
    const outcome = classifyOutcome(memory);
    if (outcome === 'failure') failures++;
    else if (outcome === 'success') successes++;
    firstDay = Math.min(firstDay, memory.createdAtDay);
    lastDay = Math.max(lastDay, memory.createdAtDay);
    peakImportance = Math.max(peakImportance, memory.importance);
  }

  const span = firstDay === lastDay ? `on day ${firstDay}` : `between day ${firstDay} and day ${lastDay}`;
  const outcomes =
    failures === 0 && successes === 0
      ? 'nothing came of them either way'
      : `${successes} went well and ${failures} badly`;

  return {
    summary: `${memories.length} times ${span} I dealt with ${subject}; ${outcomes}.`,
    // A summary must not be less memorable than its most memorable member, or
    // merging would quietly destroy signal.
    importance: clamp01(peakImportance),
    tags: [subject],
  };
}

/** The situation-specific half of the prompt. Bounded, because a cluster of a
 *  hundred memories must not become a hundred-line prompt (requirement 29). */
export function summaryPrompt(
  agentName: string,
  subject: string,
  memories: readonly MemoryEntry[],
  limit = 20,
): string {
  const lines = memories
    .slice(0, limit)
    .map((memory) => `- day ${memory.createdAtDay}: ${memory.content}`);
  const elided =
    memories.length > limit ? [`- (and ${memories.length - limit} more like these)`] : [];
  return [
    `You are ${agentName}. These memories are all about ${subject}:`,
    ...lines,
    ...elided,
  ].join('\n');
}

// ── Small shared helpers ────────────────────────────────────────────────────

/** A summary is held no more firmly than the memories behind it. */
function averageConfidence(memories: readonly MemoryEntry[]): number {
  if (memories.length === 0) return 1;
  const total = memories.reduce((sum, memory) => sum + memory.confidence, 0);
  return clamp01(total / memories.length);
}

/** The subject, whatever the model suggested, and the cluster's own common tags
 *  — so the summary is reachable by every handle its members were. */
function mergeTags(
  subject: string,
  suggested: readonly string[],
  memories: readonly MemoryEntry[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const trimmed = raw.trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length === 0 || seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };

  add(subject);
  for (const tag of suggested) add(tag);
  for (const memory of memories) {
    for (const tag of memory.tags) {
      if (out.length >= 8) return out;
      add(tag);
    }
  }
  return out;
}

function relatedEntitiesOf(memories: readonly MemoryEntry[], limit = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
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
