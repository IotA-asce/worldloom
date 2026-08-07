/**
 * Stage 4 of the chronicle pipeline: the grounding check (ADR-0009 step 4).
 *
 * This is the whole point of the pipeline. Steps 1–3 are ordinary
 * summarisation; a model handed nothing but facts still drifts and adds "and
 * they celebrated by the fire". The verifier is the structural answer:
 * everything the prose *claims* is extracted mechanically and checked against
 * the event set the narrator was given. An unbacked claim fails the entry, and
 * the entry falls back to the deterministic rendering — so a drifting model
 * costs prose quality, never truth.
 *
 * Six kinds of claim are checked, chosen because they are the ones a model
 * fabricates and a reader trusts:
 *
 *  - **names** — proper nouns, mostly settlers who must actually exist
 *  - **coordinates** — a place a reader could go and stand
 *  - **day numbers** — which day this happened on
 *  - **structure types** — a granary nobody built
 *  - **resource kinds** — iron nobody found
 *  - **inventions** — the celebration by the fire that never happened
 *
 * The grounding set is derived *only* from the source events: their payload
 * text, their positions, their day, and the names of the agents they reference.
 * Anything present in the events is fair game, because that text is exactly
 * what the narrator was shown. Anything else is an invention.
 *
 * The design bias is deliberate: **reject when unsure.** A conservative verifier
 * occasionally throws away good prose over an unrecognised paraphrase, which
 * costs a paragraph's polish. A permissive one lets fiction into the historical
 * record, which costs the artifact its value (ADR-0009, "Consequences").
 */

import { isId, type AgentId } from '../core/ids.ts';
import { RESOURCE_KINDS, type Position } from '../core/world.ts';
import { STRUCTURE_TYPE } from '../civilization/blueprints.ts';
import type { WorldEvent } from '../events/types.ts';
import type { NameBook } from './renderers.ts';

export const CLAIM_KINDS = [
  'name',
  'coordinate',
  'day',
  'structure',
  'resource',
  'invention',
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export interface Claim {
  readonly kind: ClaimKind;
  /** As it appeared in the prose. */
  readonly text: string;
  /** Comparison form: lowercased, `x,y,z` for coordinates. */
  readonly normalized: string;
}

/** Everything the source events make it legitimate to mention. */
export interface Grounding {
  readonly day: number;
  readonly eventIds: readonly string[];
  /** Proper nouns the events contain, lowercased — agent names and any
   *  capitalised word in a payload's own text. */
  readonly names: ReadonlySet<string>;
  /** `x,y,z` of every position, region corner and region centre. */
  readonly coordinates: ReadonlySet<string>;
  readonly days: ReadonlySet<number>;
  readonly structures: ReadonlySet<string>;
  readonly resources: ReadonlySet<string>;
  /** Words of colour the events actually support. */
  readonly inventions: ReadonlySet<string>;
}

export interface Verification {
  readonly grounded: boolean;
  readonly claims: readonly Claim[];
  readonly unbacked: readonly Claim[];
  /** One readable line per problem, fed back to the model on its retry. */
  readonly complaints: readonly string[];
}

/**
 * Structure types the check covers.
 *
 * The types the settlement can actually build, plus the ones a model reaches
 * for when it embellishes. The second half is what makes the check bite: if
 * "granary" were not in this list, an invented granary would pass unnoticed.
 */
const PLAUSIBLE_STRUCTURES: readonly string[] = [
  'granary',
  'workshop',
  'forge',
  'smithy',
  'tower',
  'watchtower',
  'palisade',
  'barracks',
  'temple',
  'shrine',
  'bridge',
  'dock',
  'quarry',
  'warehouse',
  'stable',
  'kiln',
  'mill',
  'cellar',
  'courtyard',
  'longhouse',
];

export const STRUCTURE_VOCABULARY: readonly string[] = [
  ...new Set([...Object.values(STRUCTURE_TYPE), ...PLAUSIBLE_STRUCTURES]),
].sort();

/**
 * The colour a drifting narrator adds.
 *
 * ADR-0009's own example of drift is "and they celebrated by the fire" — a
 * sentence with no name, no coordinate and no structure in it, which the entity
 * checks above would wave through. A closed vocabulary of the things models
 * embellish with catches it: each of these words must appear in the events
 * before the prose may use it. A settlement that really did light a fire has an
 * event saying so.
 */
export const INVENTION_VOCABULARY: readonly string[] = [
  'celebration',
  'celebrated',
  'celebrate',
  'feast',
  'feasted',
  'festival',
  'ceremony',
  'ritual',
  'dance',
  'danced',
  'dancing',
  'song',
  'sang',
  'singing',
  'laughter',
  'laughed',
  'wept',
  'weeping',
  'mourned',
  'mourning',
  'funeral',
  'wedding',
  'prayer',
  'prayed',
  'toast',
  'toasted',
  'rejoiced',
  'fire',
  'campfire',
  'bonfire',
  'feasting',
  'story',
  'stories',
  'legend',
  'myth',
];

/**
 * Capitalised words that are not claims about the world.
 *
 * Needed because English capitalises the first word of every sentence, so
 * position alone cannot distinguish "The settlers rested" from "Kael rested".
 * Everything here is either a function word, a word the deterministic renderer
 * can put at the start of a sentence, or ordinary domain vocabulary. A word
 * missing from this list is treated as a possible name and checked — the safe
 * direction to be wrong in.
 */
const ORDINARY_WORDS: readonly string[] = [
  // Articles, conjunctions, prepositions, pronouns.
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'yet', 'for', 'from', 'to', 'at', 'by',
  'in', 'into', 'on', 'onto', 'of', 'off', 'over', 'under', 'with', 'without', 'within',
  'through', 'across', 'along', 'around', 'before', 'after', 'during', 'until', 'while',
  'when', 'where', 'why', 'how', 'if', 'then', 'than', 'as', 'because', 'since', 'though',
  'although', 'between', 'beyond', 'near', 'nearby', 'above', 'below', 'up', 'down', 'out',
  'again', 'still', 'also', 'both', 'each', 'every', 'all', 'any', 'some', 'none', 'no',
  'not', 'only', 'just', 'even', 'more', 'most', 'less', 'least', 'much', 'many', 'few',
  'several', 'other', 'another', 'same', 'such', 'this', 'that', 'these', 'those', 'there',
  'here', 'it', 'its', 'they', 'them', 'their', 'theirs', 'he', 'him', 'his', 'she', 'her',
  'hers', 'we', 'us', 'our', 'ours', 'you', 'your', 'yours', 'who', 'whom', 'whose', 'which',
  'what', 'nothing', 'nobody', 'someone', 'somebody', 'everyone', 'everybody', 'anyone',
  // Verbs and auxiliaries that commonly open a sentence.
  'is', 'was', 'were', 'are', 'be', 'been', 'being', 'am', 'has', 'have', 'had', 'having',
  'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might',
  'must', 'let', 'came', 'come', 'went', 'go', 'gone', 'got', 'made', 'make', 'took', 'take',
  'gave', 'give', 'said', 'told', 'found', 'kept', 'held', 'built', 'begun', 'began',
  'begin', 'begins', 'finished', 'completed', 'failed', 'died', 'left', 'stood', 'set',
  'saw', 'seen', 'knew', 'known', 'worked', 'walked', 'moved', 'asked', 'answered',
  'shared', 'gathered', 'spent', 'lost', 'won', 'tried', 'turned', 'passed', 'read',
  'wrote', 'written', 'reworked', 'laid', 'put', 'sent', 'concluded', 'discovered',
  // Time and narration.
  'day', 'days', 'dawn', 'morning', 'midday', 'noon', 'afternoon', 'dusk', 'evening',
  'night', 'nightfall', 'today', 'yesterday', 'tomorrow', 'first', 'second', 'third',
  'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'last', 'next',
  'later', 'earlier', 'meanwhile', 'afterwards', 'finally', 'eventually', 'soon',
  'already', 'once', 'twice', 'never', 'always', 'often', 'sometimes',
  // Domain vocabulary the chronicle legitimately uses without naming anything.
  'settlement', 'settlements', 'settler', 'settlers', 'agent', 'agents', 'work', 'works',
  'plan', 'plans', 'goal', 'goals', 'structure', 'structures', 'building', 'buildings',
  'site', 'sites', 'region', 'regions', 'place', 'places', 'land', 'ground', 'terrain',
  'water', 'river', 'forest', 'hill', 'hills', 'valley', 'north', 'south', 'east', 'west',
  'resource', 'resources', 'supplies', 'stores', 'store', 'stock', 'materials', 'material',
  'timber', 'masonry', 'thatch', 'glass', 'health', 'hunger', 'shelterless', 'progress',
  'record', 'records', 'chronicle', 'history', 'entry', 'trust', 'affinity', 'confidence',
  'need', 'needs', 'message', 'messages', 'word', 'news', 'help', 'danger', 'safety',
  'energy', 'rest', 'sleep', 'food', 'nothing', 'noone', 'critical', 'estimated', 'step',
  'steps', 'attempt', 'attempts', 'reason', 'purpose', 'objective', 'together', 'alone',
  // Weather and nature, which prose reaches for and which name nobody.
  'rain', 'snow', 'wind', 'sun', 'sunlight', 'sky', 'storm', 'thunder', 'weather', 'clear',
  'fire', 'light', 'dark', 'darkness', 'cold', 'warmth', 'stone', 'trees', 'tree', 'wood',
  'earth', 'rock', 'rocks', 'grass', 'crops', 'seeds', 'shade', 'shore', 'coast',
];

/**
 * Words that are never name claims. Structure types and resource kinds are in
 * here too: they are checked by their own claim kinds, which produce a far more
 * useful complaint than "not anyone the events mention".
 */
const COMMON_WORDS: ReadonlySet<string> = new Set([
  ...ORDINARY_WORDS,
  ...STRUCTURE_VOCABULARY,
  ...RESOURCE_KINDS,
  ...INVENTION_VOCABULARY,
]);

// ── Building the grounding set ──────────────────────────────────────────────

interface Evidence {
  readonly text: string[];
  /** Object keys, which carry vocabulary (a resource bundle keys by resource)
   *  but never proper nouns. */
  readonly keys: string[];
  readonly positions: Position[];
  readonly days: number[];
  readonly agentIds: string[];
}

function isPosition(value: Record<string, unknown>): boolean {
  return (
    typeof value['x'] === 'number' &&
    typeof value['y'] === 'number' &&
    typeof value['z'] === 'number'
  );
}

function asPosition(value: Record<string, unknown>): Position {
  return { x: value['x'] as number, y: value['y'] as number, z: value['z'] as number };
}

/** Walk a payload, collecting everything the prose is allowed to draw on. */
function collect(value: unknown, key: string, into: Evidence): void {
  if (typeof value === 'string') {
    into.text.push(value);
    if (isId(value, 'agent')) into.agentIds.push(value);
    return;
  }
  if (typeof value === 'number') {
    // Only day-shaped fields license a day claim; a quantity of 4 must not
    // legitimise "on day 4".
    if (/day/i.test(key)) into.days.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) collect(item, key, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (isPosition(record)) {
    into.positions.push(asPosition(record));
    return;
  }
  const min = record['min'];
  const max = record['max'];
  if (
    min !== null && typeof min === 'object' && isPosition(min as Record<string, unknown>) &&
    max !== null && typeof max === 'object' && isPosition(max as Record<string, unknown>)
  ) {
    const from = asPosition(min as Record<string, unknown>);
    const to = asPosition(max as Record<string, unknown>);
    into.positions.push(from, to, {
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2,
      z: (from.z + to.z) / 2,
    });
    return;
  }
  for (const [childKey, child] of Object.entries(record)) {
    into.keys.push(childKey);
    collect(child, childKey, into);
  }
}

function coordinateKey(position: Position): string {
  return `${String(Math.round(position.x))},${String(Math.round(position.y))},${String(Math.round(position.z))}`;
}

/** Lowercase, and reduce everything that isn't a letter or digit to a space, so
 *  `small_shelter` yields the word `shelter`. */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

function containsWord(haystack: string, word: string): boolean {
  return new RegExp(`(?:^| )${word}s?(?: |$)`).test(haystack);
}

/**
 * What the source events make it legitimate to say.
 *
 * `names` resolves the agent ids the events reference; nothing outside the event
 * set contributes, which is what makes the guarantee structural rather than
 * hopeful.
 */
export function groundingFrom(
  events: readonly WorldEvent[],
  names: NameBook,
  day: number,
): Grounding {
  const evidence: Evidence = { text: [], keys: [], positions: [], days: [], agentIds: [] };
  const days = new Set<number>([day]);

  for (const event of events) {
    days.add(event.day);
    if (event.actorId !== null) evidence.agentIds.push(event.actorId);
    collect(event.payload, 'payload', evidence);
  }
  for (const value of evidence.days) days.add(value);

  const properNouns = new Set<string>();
  for (const id of evidence.agentIds) {
    const name = names.nameOf(id as AgentId);
    for (const word of normalizeText(name).split(' ')) {
      if (word.length > 0) properNouns.add(word);
    }
  }
  // Capitalised words inside a payload's own text — settlement names, roles,
  // and any proper noun an agent wrote into a message or a belief. The narrator
  // was shown this text, so repeating it is not an invention.
  for (const text of evidence.text) {
    for (const match of text.matchAll(/[A-Z][a-z]+/g)) {
      properNouns.add(match[0].toLowerCase());
    }
  }

  const vocabulary = normalizeText([...evidence.text, ...evidence.keys].join(' '));

  return {
    day,
    eventIds: events.map((event) => event.id),
    names: properNouns,
    coordinates: new Set(evidence.positions.map(coordinateKey)),
    days,
    structures: new Set(STRUCTURE_VOCABULARY.filter((word) => containsWord(vocabulary, word))),
    resources: new Set(RESOURCE_KINDS.filter((kind) => containsWord(vocabulary, kind))),
    inventions: new Set(INVENTION_VOCABULARY.filter((word) => containsWord(vocabulary, word))),
  };
}

// ── Extracting claims from prose ────────────────────────────────────────────

const COORDINATE = /\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/g;
const DAY_REFERENCE = /\bday\s+(\d+)\b/gi;
const WORD = /[A-Za-z][A-Za-z'’-]*/g;

/** Strip a possessive and surrounding punctuation for comparison. */
function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/['’]s$/, '').replace(/^[-'’]+|[-'’]+$/g, '');
}

function isNameCandidate(word: string): boolean {
  // Capitalised, but not an acronym or a bare "I": all-caps tokens are never
  // the kind of invented settler name this check is for.
  return /^[A-Z]/.test(word) && !/^[A-Z'’-]+$/.test(word);
}

/**
 * Proper-noun claims.
 *
 * A capitalised word is a claim unless it is ordinary English. Position in the
 * sentence is deliberately *not* used: English capitalises the first word of
 * every sentence, so exempting sentence-initial words would let a fabricated
 * settler in simply by starting a sentence with their name. The cost is that a
 * rare-but-ordinary word opening a sentence is treated as a name — the
 * false-positive direction ADR-0009 chooses on purpose.
 */
function nameClaims(text: string): Claim[] {
  const claims: Claim[] = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    if (!isNameCandidate(word)) continue;
    const normalized = normalizeWord(word);
    if (normalized.length === 0 || COMMON_WORDS.has(normalized)) continue;
    claims.push({ kind: 'name', text: word, normalized });
  }
  return claims;
}

export function extractClaims(text: string): Claim[] {
  const claims: Claim[] = [];

  for (const match of text.matchAll(COORDINATE)) {
    claims.push({
      kind: 'coordinate',
      text: match[0],
      normalized: `${String(match[1])},${String(match[2])},${String(match[3])}`,
    });
  }
  for (const match of text.matchAll(DAY_REFERENCE)) {
    claims.push({ kind: 'day', text: match[0], normalized: String(match[1]) });
  }

  const normalized = normalizeText(text);
  for (const word of STRUCTURE_VOCABULARY) {
    if (containsWord(normalized, word)) {
      claims.push({ kind: 'structure', text: word, normalized: word });
    }
  }
  for (const kind of RESOURCE_KINDS) {
    if (containsWord(normalized, kind)) {
      claims.push({ kind: 'resource', text: kind, normalized: kind });
    }
  }
  for (const word of INVENTION_VOCABULARY) {
    if (containsWord(normalized, word)) {
      claims.push({ kind: 'invention', text: word, normalized: word });
    }
  }

  claims.push(...nameClaims(text));
  return claims;
}

function isBacked(claim: Claim, grounding: Grounding): boolean {
  switch (claim.kind) {
    case 'coordinate':
      return grounding.coordinates.has(claim.normalized);
    case 'day':
      return grounding.days.has(Number(claim.normalized));
    case 'structure':
      return grounding.structures.has(claim.normalized);
    case 'resource':
      return grounding.resources.has(claim.normalized);
    case 'invention':
      return grounding.inventions.has(claim.normalized);
    case 'name':
      if (grounding.names.has(claim.normalized)) return true;
      // A hyphenated proper noun is backed when each of its parts is.
      return (
        claim.normalized.includes('-') &&
        claim.normalized
          .split('-')
          .filter((part) => part.length > 0)
          .every((part) => grounding.names.has(part) || COMMON_WORDS.has(part))
      );
  }
}

function complain(claim: Claim): string {
  switch (claim.kind) {
    case 'coordinate':
      return `no event places anything at ${claim.text}`;
    case 'day':
      return `no event happened on ${claim.text}`;
    case 'structure':
      return `no event mentions a ${claim.text}`;
    case 'resource':
      return `no event mentions ${claim.text}`;
    case 'invention':
      return `no event supports "${claim.text}" — do not add colour`;
    case 'name':
      return `"${claim.text}" is not anyone or anything the events mention`;
  }
}

/**
 * Check prose against its evidence. Deterministic and cheap — no model, no
 * network, no state.
 */
export function verify(text: string, grounding: Grounding): Verification {
  const claims = extractClaims(text);
  const unbacked = claims.filter((claim) => !isBacked(claim, grounding));
  // De-duplicate: the same invented name three times is one problem to report.
  const complaints = [...new Set(unbacked.map(complain))];
  return { grounded: unbacked.length === 0, claims, unbacked, complaints };
}

/** A whole entry, title included — a headline can invent just as easily. */
export function verifyEntry(
  title: string,
  prose: string,
  grounding: Grounding,
): Verification {
  return verify(`${title}\n${prose}`, grounding);
}
