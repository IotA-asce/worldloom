/**
 * The chronicle pipeline: select → render → narrate → verify (ADR-0009).
 *
 * The shape is the guarantee. The narrator receives *only* the sentences stage 2
 * rendered — never the world, never other days, never an agent's memories — and
 * whatever it writes is checked against the same event set before it is allowed
 * into the record. Prose that fails is regenerated once and then discarded in
 * favour of the deterministic rendering, so the worst a drifting model can do is
 * make the history dull (requirement 22).
 *
 * Every entry stores the ids of the events it was built from, so any sentence
 * can be traced to its evidence.
 */

import { z } from 'zod';
import type { AgentId } from '../core/ids.ts';
import { fail, ok, type Result } from '../core/result.ts';
import type { ChronicleEntry } from '../civilization/types.ts';
import type { EventType, NewEvent, WorldEvent } from '../events/types.ts';
import type { ReasoningProvider } from '../reasoning/provider.ts';
import { selectForDay, type DaySelection, type SelectionOptions } from './importance.ts';
import {
  dayTitle,
  nameBook,
  renderDayProse,
  renderFacts,
  type RenderedFact,
} from './renderers.ts';
import { groundingFrom, verifyEntry, type Grounding, type Verification } from './verifier.ts';

/**
 * What the generator needs from persistence. Structural rather than the whole
 * `Store` so the pipeline stays testable and its reach stays visible: it reads
 * events and agent names, and writes chronicle entries. Notably absent are the
 * memory and knowledge repositories — the chronicle is not allowed to read
 * beliefs (ADR-0009, "Alternatives rejected").
 */
export interface ChronicleStore {
  readonly events: {
    query(query: { readonly day?: number }): WorldEvent[];
    append<T extends EventType>(
      event: NewEvent<T>,
      context: { day: number; worldTicks: number },
      now?: number,
    ): WorldEvent<T>;
  };
  readonly agents: {
    all(): readonly { readonly id: AgentId; readonly name: string }[];
  };
  readonly chronicle: {
    upsert(entry: ChronicleEntry): void;
    forDay(day: number): ChronicleEntry | null;
    all(): ChronicleEntry[];
  };
}

export interface ChronicleDeps {
  readonly store: ChronicleStore;
  readonly reasoning: ReasoningProvider;
  /** Injectable so a test's entries have stable timestamps. */
  readonly now?: () => number;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface DayOptions extends SelectionOptions {
  /** Ask the model for prose. False runs the deterministic path only. */
  readonly narrate?: boolean;
  /**
   * When given, writing the entry is itself recorded in the ledger at this
   * tick. Left out when regenerating a chronicle after the fact, so rewriting
   * history's *prose* does not add to history's *events*.
   */
  readonly worldTicks?: number;
}

export interface ChronicleOptions extends DayOptions {
  readonly fromDay?: number;
  readonly toDay?: number;
}

/**
 * Deterministic entry id: one entry per day, and regenerating a day replaces it
 * rather than accumulating near-duplicates.
 */
export function chronicleEntryId(day: number): string {
  return `chronicle_day_${String(day)}`;
}

/** What the narrator is allowed to return. Prose and a headline, nothing else —
 *  no event ids, no structured claims it could get wrong. */
export const ChronicleProseSchema = z.object({
  title: z.string().min(1).max(90),
  prose: z.string().min(1).max(2_400),
});

export type ChronicleProse = z.infer<typeof ChronicleProseSchema>;

const NARRATOR_SYSTEM_PROMPT = [
  'You are the chronicler of a small settlement. You write plain, unadorned',
  'history in the past tense: a short paragraph or two, no headings, no lists.',
  '',
  'You are given the complete set of facts for one day. You may combine them,',
  'order them for readability, and connect them with cause where the facts',
  'themselves show it. You may not add anything else.',
  '',
  'Never introduce a person, place, structure, resource, coordinate or day that',
  'is not in the facts. Do not invent atmosphere, weather, feelings, meals or',
  'celebrations. Every name and number you write must appear in the facts. A',
  'sentence you cannot support is worse than a sentence you leave out.',
].join('\n');

function factsPrompt(day: number, facts: readonly RenderedFact[]): string {
  const lines = facts.map((fact) => `- ${fact.sentence}`);
  return [`Facts for day ${String(day)}:`, ...lines].join('\n');
}

/** The deterministic entry — stage 2 standing on its own. */
function renderedProse(day: number, facts: readonly RenderedFact[]): ChronicleProse {
  return { title: dayTitle(day, facts), prose: renderDayProse(facts) };
}

export interface DayResult {
  readonly entry: ChronicleEntry;
  readonly selection: DaySelection;
  readonly facts: readonly RenderedFact[];
  /** The verification the accepted prose passed, or the last failed attempt. */
  readonly verification: Verification;
  /** How many times the model's prose was rejected as ungrounded. */
  readonly rejections: number;
}

/**
 * Generate one day's entry, or `null` when nothing worth recording happened.
 *
 * An empty day writes no entry: a chronicle of "nothing happened" pages is
 * worse than a chronicle with gaps, and the ledger still holds the detail.
 */
export async function generateDay(
  deps: ChronicleDeps,
  day: number,
  options: DayOptions = {},
): Promise<Result<DayResult | null>> {
  if (!Number.isInteger(day) || day < 0) {
    return fail('BAD_ARGS', `day must be a non-negative integer, got ${String(day)}`);
  }
  return await entryFor(deps, day, deps.store.events.query({ day }), options);
}

/**
 * Generate entries for a range of days. Days with nothing notable are skipped,
 * so the returned array can be shorter than the range.
 */
export async function generateChronicle(
  deps: ChronicleDeps,
  options: ChronicleOptions = {},
): Promise<Result<ChronicleEntry[]>> {
  const all = deps.store.events.query({});
  const from = options.fromDay ?? Math.min(...all.map((event) => event.day), 0);
  const to = options.toDay ?? Math.max(...all.map((event) => event.day), 0);
  if (from > to) {
    return fail('BAD_ARGS', `fromDay ${String(from)} is after toDay ${String(to)}`);
  }

  // Group once rather than re-querying per day: a long run's ledger is large,
  // and the chronicle is generated over all of it.
  const byDay = new Map<number, WorldEvent[]>();
  for (const event of all) {
    if (event.day < from || event.day > to) continue;
    const bucket = byDay.get(event.day);
    if (bucket === undefined) byDay.set(event.day, [event]);
    else bucket.push(event);
  }

  const entries: ChronicleEntry[] = [];
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const result = await entryFor(deps, day, byDay.get(day) ?? [], options);
    if (!result.ok) return result;
    if (result.value !== null) entries.push(result.value.entry);
  }
  return ok(entries);
}

async function entryFor(
  deps: ChronicleDeps,
  day: number,
  events: readonly WorldEvent[],
  options: DayOptions,
): Promise<Result<DayResult | null>> {
  const selection = selectForDay(day, events, options);
  const names = nameBook(deps.store.agents.all());
  const facts = renderFacts(selection.events, names);

  if (facts.length === 0) {
    deps.log?.(`day ${String(day)} had nothing worth recording`, { day });
    return ok(null);
  }

  const grounding = groundingFrom(selection.events, names, day);
  const rendered = renderedProse(day, facts);

  const narrated =
    options.narrate === false
      ? null
      : await narrate(deps, day, facts, grounding, rendered);

  // Nothing narrated, or nothing narrated that survived verification: the
  // deterministic rendering is what goes on the record, and it is the
  // rendering's own verification the caller should be shown.
  const survived = narrated === null ? null : narrated.prose;
  const accepted = survived ?? rendered;
  const source: ChronicleEntry['source'] = survived === null ? 'rendered' : 'narrated';
  const verification =
    survived === null || narrated === null || narrated.verification === null
      ? verifyEntry(rendered.title, rendered.prose, grounding)
      : narrated.verification;

  const entry: ChronicleEntry = {
    id: chronicleEntryId(day),
    day,
    title: accepted.title,
    prose: accepted.prose,
    eventIds: facts.map((fact) => fact.eventId),
    source,
    generatedAt: (deps.now ?? Date.now)(),
  };

  deps.store.chronicle.upsert(entry);

  if (options.worldTicks !== undefined) {
    deps.store.events.append(
      {
        type: 'chronicle_entry_written',
        actorId: null,
        payload: { day, title: entry.title, fromEvents: entry.eventIds.length },
      },
      { day, worldTicks: options.worldTicks },
    );
  }

  deps.log?.(`wrote the entry for day ${String(day)}`, {
    day,
    source,
    events: entry.eventIds.length,
    rejections: narrated?.rejections ?? 0,
  });

  return ok({
    entry,
    selection,
    facts,
    verification,
    rejections: narrated?.rejections ?? 0,
  });
}

interface Narration {
  /** Null when nothing the model wrote survived verification. */
  readonly prose: ChronicleProse | null;
  readonly verification: Verification | null;
  /** Drafts rejected as ungrounded. Reported even when the fallback wins, so a
   *  run's actual reliance on the fallback is measurable (ADR-0006). */
  readonly rejections: number;
}

/**
 * Stages 3 and 4: ask for prose, check it, and give the model exactly one more
 * chance with its own failures quoted back. A null `prose` means the
 * deterministic rendering wins.
 *
 * The `fallback` is the rendering itself, which is why this whole function
 * degrades to a no-op under `HeuristicProvider` — the rule-based path *is* the
 * chronicle in CI (ADR-0006).
 */
async function narrate(
  deps: ChronicleDeps,
  day: number,
  facts: readonly RenderedFact[],
  grounding: Grounding,
  rendered: ChronicleProse,
): Promise<Narration> {
  const basePrompt = factsPrompt(day, facts);
  let rejections = 0;
  let last: Verification | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      last === null
        ? basePrompt
        : [
            basePrompt,
            '',
            'Your previous attempt claimed things the facts do not support:',
            ...last.complaints.map((complaint) => `- ${complaint}`),
            '',
            'Write it again using only the facts above.',
          ].join('\n');

    const answer = await deps.reasoning.reason({
      category: 'chronicle',
      // Civilization-level reasoning: no agent's private state is involved.
      agentId: null,
      system: NARRATOR_SYSTEM_PROMPT,
      prompt,
      schema: ChronicleProseSchema,
      fallback: () => rendered,
    });

    if (!answer.ok) return { prose: null, verification: null, rejections };

    // `heuristic` and `fallback` both mean the rule answered, and the rule here
    // *is* the deterministic rendering — so the entry is a rendered one and
    // there is nothing to verify or retry. This is the whole CI path.
    const wrote = answer.value.source;
    if (wrote !== 'model' && wrote !== 'fixture') {
      return { prose: null, verification: null, rejections };
    }

    const prose = answer.value.value;
    const verification = verifyEntry(prose.title, prose.prose, grounding);
    if (verification.grounded) {
      return { prose, verification, rejections };
    }

    rejections++;
    last = verification;
    deps.log?.(`day ${String(day)}: rejected ungrounded prose`, {
      day,
      attempt: attempt + 1,
      complaints: verification.complaints,
    });

    // A replayed fixture will replay identically; asking again only burns a call.
    if (wrote === 'fixture') break;
  }

  return { prose: null, verification: last, rejections };
}

// ── Reading a chronicle back ────────────────────────────────────────────────

export interface ChronicleTextOptions {
  /** Append the event ids each entry was built from — the evidence trail. */
  readonly cite?: boolean;
  /** Mark entries the deterministic renderer wrote. */
  readonly showSource?: boolean;
}

/**
 * The whole chronicle as readable text.
 *
 * Citations are opt-in because they are for auditing, not reading: the claim
 * that a chronicle is grounded is only useful if someone can check it, and this
 * is how they check it.
 */
export function renderChronicleText(
  entries: readonly ChronicleEntry[],
  options: ChronicleTextOptions = {},
): string {
  if (entries.length === 0) return 'The chronicle is empty.';

  const sections = [...entries]
    .sort((a, b) => a.day - b.day)
    .map((entry) => {
      const lines = [entry.title, '='.repeat(entry.title.length), '', entry.prose];
      if (options.showSource === true) {
        lines.push('', `[${entry.source}]`);
      }
      if (options.cite === true) {
        lines.push(
          '',
          `Sources (${String(entry.eventIds.length)}): ${entry.eventIds.join(', ')}`,
        );
      }
      return lines.join('\n');
    });

  return sections.join('\n\n');
}

/** The stored chronicle, oldest day first. */
export function readChronicle(store: ChronicleStore): ChronicleEntry[] {
  return store.chronicle.all();
}
