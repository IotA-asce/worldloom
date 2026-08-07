/**
 * The pipeline end to end: select → render → narrate → verify (ADR-0009).
 *
 * Everything here runs against a real in-memory store and no network. The
 * default provider is `HeuristicProvider`, which means these tests exercise the
 * chronicle a contributor with no API key actually gets.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chronicleEntryId,
  generateChronicle,
  generateDay,
  renderChronicleText,
  type ChronicleDeps,
  type ChronicleProse,
} from '../../src/chronicle/generator.ts';
import { nameBook } from '../../src/chronicle/renderers.ts';
import { groundingFrom, verifyEntry } from '../../src/chronicle/verifier.ts';
import { parseConfig } from '../../src/core/config.ts';
import { sequentialIdFactory } from '../../src/core/ids.ts';
import { expect, ok, type Result } from '../../src/core/result.ts';
import { FakeEnvironment } from '../../src/environment/fake/environment.ts';
import { silentLogger } from '../../src/observability/logger.ts';
import { Store } from '../../src/persistence/store.ts';
import { HeuristicProvider } from '../../src/reasoning/heuristic.ts';
import { Simulation } from '../../src/simulation.ts';
import {
  NO_USAGE,
  type AnswerSource,
  type ReasoningProvider,
  type ReasoningRequest,
  type ReasoningResult,
} from '../../src/reasoning/provider.ts';
import { ARUN, MIRA, SAMPLE_PAYLOADS, testAgent } from './fixture.ts';

/**
 * A provider that answers with prose of the test's choosing, as though a model
 * had written it. Successive calls consume successive drafts, so a retry can be
 * given a different answer from the first attempt.
 */
class DraftingProvider implements ReasoningProvider {
  readonly id = 'drafting';
  calls = 0;
  readonly prompts: string[] = [];

  constructor(
    private readonly drafts: readonly ChronicleProse[],
    private readonly source: AnswerSource = 'model',
  ) {}

  async reason<T>(request: ReasoningRequest<T>): Promise<Result<ReasoningResult<T>>> {
    const draft = this.drafts[Math.min(this.calls, this.drafts.length - 1)];
    this.calls++;
    this.prompts.push(request.prompt);
    const parsed = request.schema.safeParse(draft);
    return ok({
      value: parsed.success ? parsed.data : request.fallback(),
      source: this.source,
      model: 'drafting',
      usage: NO_USAGE,
      costUsd: 0,
      durationMs: 0,
      prompt: request.prompt,
      raw: JSON.stringify(draft),
    });
  }
}

/** A settled world: two settlers, a founding, three days of work. */
function seededStore(): Store {
  const store = Store.openMemory(sequentialIdFactory());
  store.agents.insert(testAgent(MIRA, 'Mira', 'Builder'));
  store.agents.insert(testAgent(ARUN, 'Arun', 'Gatherer'));

  store.events.append(
    { type: 'settlement_founded', actorId: null, payload: SAMPLE_PAYLOADS.settlement_founded },
    { day: 1, worldTicks: 100 },
    0,
  );
  store.events.append(
    { type: 'agent_spawned', actorId: MIRA, payload: SAMPLE_PAYLOADS.agent_spawned },
    { day: 1, worldTicks: 110 },
    0,
  );
  // Day 2: a discovery and a routine move, only one of which is history.
  // Marked as a first strike, which is what the executor does for the
  // settlement's first knowledge of a resource — later finds of something
  // already known are routine and deliberately do not reach history.
  store.events.append(
    {
      type: 'resource_discovered',
      actorId: ARUN,
      importance: 0.85,
      payload: SAMPLE_PAYLOADS.resource_discovered,
    },
    { day: 2, worldTicks: 200 },
    0,
  );
  store.events.append(
    { type: 'agent_moved', actorId: MIRA, payload: SAMPLE_PAYLOADS.agent_moved },
    { day: 2, worldTicks: 210 },
    0,
  );
  // Day 3: the build.
  store.events.append(
    // A big verified harvest, marked above the default for its type — the day's
    // wood is what the storage was built from.
    {
      type: 'resource_collected',
      actorId: MIRA,
      payload: SAMPLE_PAYLOADS.resource_collected,
      importance: 0.6,
    },
    { day: 3, worldTicks: 300 },
    0,
  );
  store.events.append(
    { type: 'structure_completed', actorId: MIRA, payload: SAMPLE_PAYLOADS.structure_completed },
    { day: 3, worldTicks: 310 },
    0,
  );
  return store;
}

function deps(store: Store, reasoning: ReasoningProvider = new HeuristicProvider()): ChronicleDeps {
  return { store, reasoning, now: () => 1_000 };
}

describe('a chronicle generated with no model at all', () => {
  it('writes one entry per day of history, in order', async () => {
    const store = seededStore();

    const entries = expect(await generateChronicle(deps(store)), 'chronicle');

    assert.deepEqual(entries.map((entry) => entry.day), [1, 2, 3]);
    for (const entry of entries) {
      assert.equal(entry.source, 'rendered', 'with no model, the renderer is the chronicler');
      assert.ok(entry.prose.length > 40, entry.prose);
      assert.ok(entry.title.startsWith(`Day ${String(entry.day)}`), entry.title);
    }
    store.close();
  });

  it('reads correctly as one document', async () => {
    const store = seededStore();
    expect(await generateChronicle(deps(store)), 'chronicle');

    const text = renderChronicleText(store.chronicle.all());

    assert.match(text, /Day 1: the founding/);
    assert.match(text, /the settlement of Aurelian Reach was founded at \(142, 68, -91\)/);
    assert.match(text, /Arun discovered iron at \(130, 40, -70\) on day 2/);
    assert.match(text, /Mira completed the storage at \(142, 68, -91\) on day 3/);
    assert.ok(text.indexOf('Day 1') < text.indexOf('Day 3'), 'days must read in order');
    store.close();
  });

  it('cites the real event ids each entry was built from', async () => {
    const store = seededStore();
    const entries = expect(await generateChronicle(deps(store)), 'chronicle');

    const known = new Set(store.events.query({}).map((event) => event.id));
    for (const entry of entries) {
      assert.ok(entry.eventIds.length > 0, `day ${String(entry.day)} cites nothing`);
      for (const id of entry.eventIds) {
        assert.ok(known.has(id), `${id} is not an event in the ledger`);
        assert.equal(store.events.find(id)?.day, entry.day, `${id} is from another day`);
      }
    }

    // And the citations survive into the readable document, so a reader can
    // check the history against the ledger themselves.
    const text = renderChronicleText(entries, { cite: true });
    for (const id of entries[0]?.eventIds ?? []) assert.ok(text.includes(id), text);
    store.close();
  });

  it('leaves routine events out of the prose but keeps the day', async () => {
    const store = seededStore();
    const result = expect(await generateDay(deps(store), 2), 'day 2');

    assert.notEqual(result, null);
    assert.equal(result?.selection.considered, 2);
    assert.deepEqual(
      result?.facts.map((fact) => fact.type),
      ['resource_discovered'],
      'a routine walk is not history',
    );
    assert.ok(!(result?.entry.prose ?? '').includes('travelled'), result?.entry.prose);
    store.close();
  });

  it('writes nothing for a day where nothing notable happened', async () => {
    const store = seededStore();
    store.events.append(
      { type: 'agent_moved', actorId: MIRA, payload: SAMPLE_PAYLOADS.agent_moved },
      { day: 9, worldTicks: 900 },
      0,
    );

    assert.equal(expect(await generateDay(deps(store), 9), 'day 9'), null);
    assert.equal(store.chronicle.forDay(9), null, 'an empty day gets no page');
    store.close();
  });

  it('rejects a day that could not exist rather than throwing', async () => {
    const store = seededStore();
    const result = await generateDay(deps(store), -3);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.failure.kind : null, 'BAD_ARGS');
    store.close();
  });

  it('replaces the entry when a day is regenerated', async () => {
    const store = seededStore();
    await generateDay(deps(store), 3);
    await generateDay(deps(store), 3);

    assert.equal(store.chronicle.all().filter((entry) => entry.day === 3).length, 1);
    assert.equal(store.chronicle.forDay(3)?.id, chronicleEntryId(3));
    store.close();
  });

  it('records the writing of an entry in the ledger only when asked to', async () => {
    const store = seededStore();

    await generateDay(deps(store), 3);
    assert.equal(store.events.query({ types: ['chronicle_entry_written'] }).length, 0);

    await generateDay(deps(store), 3, { worldTicks: 320 });
    const written = store.events.query({ types: ['chronicle_entry_written'] });
    assert.equal(written.length, 1);
    assert.equal((written[0]?.payload as { fromEvents: number }).fromEvents, 2);
    store.close();
  });

  it('never claims anything the ledger does not contain', async () => {
    // The requirement-22 sweep: rebuild each entry's grounding from the events
    // it cites and check every claim in the stored prose against it.
    const store = seededStore();
    const entries = expect(await generateChronicle(deps(store)), 'chronicle');
    const names = nameBook(store.agents.all());

    for (const entry of entries) {
      const events = entry.eventIds.map((id) => store.events.find(id)).filter((e) => e !== null);
      const grounding = groundingFrom(events, names, entry.day);
      const result = verifyEntry(entry.title, entry.prose, grounding);
      assert.equal(
        result.grounded,
        true,
        `day ${String(entry.day)}: ${result.complaints.join('; ')}\n${entry.prose}`,
      );
    }
    store.close();
  });
});

describe('narration is accepted only when it is grounded', () => {
  it('keeps prose that recombines the facts it was given', async () => {
    const store = seededStore();
    const provider = new DraftingProvider([
      {
        title: 'Day 3: a structure stands',
        prose:
          'Mira gathered 24 wood and, with it, completed the storage at ' +
          '(142, 68, -91) on day 3.',
      },
    ]);

    const result = expect(await generateDay(deps(store, provider), 3), 'day 3');

    assert.equal(result?.entry.source, 'narrated');
    assert.equal(result?.rejections, 0);
    assert.match(result?.entry.prose ?? '', /^Mira gathered 24 wood/);
    assert.equal(provider.calls, 1, 'grounded prose needs no retry');
    store.close();
  });

  it('falls back to the deterministic rendering when the model invents a settler', async () => {
    const store = seededStore();
    const provider = new DraftingProvider([
      {
        title: 'Day 3: a structure stands',
        prose: 'Kael and Mira completed the storage on day 3, and celebrated by the fire.',
      },
    ]);

    const result = expect(await generateDay(deps(store, provider), 3), 'day 3');

    assert.equal(result?.entry.source, 'rendered', 'fiction must not reach the record');
    assert.ok(!(result?.entry.prose ?? '').includes('Kael'));
    assert.ok(!(result?.entry.prose ?? '').includes('celebrated'));
    assert.match(result?.entry.prose ?? '', /Mira completed the storage at \(142, 68, -91\)/);
    assert.equal(result?.rejections, 2, 'one attempt and exactly one retry');
    assert.equal(provider.calls, 2);
    store.close();
  });

  it('quotes its complaints back to the model on the retry', async () => {
    const store = seededStore();
    const provider = new DraftingProvider([
      { title: 'Day 3', prose: 'Kael built the granary at (1, 2, 3) on day 3.' },
    ]);

    await generateDay(deps(store, provider), 3);

    const retry = provider.prompts[1] ?? '';
    assert.match(retry, /previous attempt claimed things the facts do not support/);
    assert.match(retry, /"Kael" is not anyone/);
    assert.match(retry, /no event mentions a granary/);
    assert.match(retry, /Facts for day 3:/, 'and the facts are still the only source');
    store.close();
  });

  it('accepts a second draft that fixes the first one', async () => {
    const store = seededStore();
    const provider = new DraftingProvider([
      { title: 'Day 3', prose: 'Kael completed the storage on day 3.' },
      { title: 'Day 3: a structure stands', prose: 'Mira completed the storage on day 3.' },
    ]);

    const result = expect(await generateDay(deps(store, provider), 3), 'day 3');

    assert.equal(result?.entry.source, 'narrated');
    assert.equal(result?.rejections, 1);
    assert.equal(result?.entry.prose, 'Mira completed the storage on day 3.');
    store.close();
  });

  it('shows the narrator the facts and nothing else', async () => {
    const store = seededStore();
    const provider = new DraftingProvider([{ title: 'Day 3', prose: 'Nothing happened.' }]);

    await generateDay(deps(store, provider), 3);
    const prompt = provider.prompts[0] ?? '';

    // Only the day's rendered sentences. No other day, no agent's beliefs, no
    // world state — there is no channel through which to invent an event.
    assert.match(prompt, /^Facts for day 3:\n- Mira gathered 24 wood/);
    assert.ok(!prompt.includes('Aurelian Reach'), 'day 1 is not day 3’s business');
    assert.ok(!prompt.includes('iron'), 'nor is day 2');
    store.close();
  });

  it('does not ask the model at all when narration is switched off', async () => {
    const store = seededStore();
    const provider = new DraftingProvider([
      { title: 'Day 3', prose: 'Mira completed the storage on day 3.' },
    ]);

    const result = expect(
      await generateDay(deps(store, provider), 3, { narrate: false }),
      'day 3',
    );

    assert.equal(provider.calls, 0);
    assert.equal(result?.entry.source, 'rendered');
    store.close();
  });

  it('treats a replayed fixture as prose to verify, not as a rule to trust', async () => {
    const store = seededStore();
    const provider = new DraftingProvider(
      [{ title: 'Day 3', prose: 'Kael completed the storage on day 3.' }],
      'fixture',
    );

    const result = expect(await generateDay(deps(store, provider), 3), 'day 3');

    assert.equal(result?.entry.source, 'rendered');
    assert.equal(provider.calls, 1, 'a fixture replays identically, so there is no point retrying');
    store.close();
  });

  it('degrades to the rendering when the provider fails outright', async () => {
    const store = seededStore();
    const broken: ReasoningProvider = {
      id: 'broken',
      reason: async () => ({
        ok: false as const,
        failure: { kind: 'INTERNAL' as const, detail: 'the model is gone' },
      }),
    };

    const result = expect(await generateDay(deps(store, broken), 3), 'day 3');

    assert.equal(result?.entry.source, 'rendered', 'a dead model makes history dull, not absent');
    store.close();
  });
});

describe('a chronicle of a real run', () => {
  it('turns a simulated civilization into grounded history with no model', async () => {
    // Hand-built events can be made to suit the renderer. This one cannot: the
    // ledger is whatever three settlers actually did over a few days, including
    // their failures and their repetitions.
    const config = expect(
      parseConfig(
        {
          simulation: { agents: 3, tick_interval_seconds: 0, seed: 7 },
          environment: { type: 'fake' },
          reasoning: { provider: 'heuristic' },
        },
        {},
      ),
      'config',
    );
    const store = Store.openMemory(sequentialIdFactory());
    const simulation = Simulation.create({
      config,
      store,
      environment: new FakeEnvironment({ seed: 3, startTicks: 1_000, ticksPerQuery: 400 }),
      reasoning: new HeuristicProvider(),
      logger: silentLogger(),
      ids: store.ids,
    });
    expect(await simulation.start(), 'start');
    for (let round = 0; round < 30; round++) await simulation.tickAll();

    const entries = expect(await generateChronicle(deps(store)), 'chronicle');
    assert.ok(entries.length > 1, 'several days of history should have accumulated');

    const names = nameBook(store.agents.all());
    for (const entry of entries) {
      const events = entry.eventIds.map((id) => store.events.find(id)).filter((e) => e !== null);
      assert.equal(events.length, entry.eventIds.length, 'every citation resolves');
      const result = verifyEntry(entry.title, entry.prose, groundingFrom(events, names, entry.day));
      assert.equal(
        result.grounded,
        true,
        `day ${String(entry.day)}: ${result.complaints.join('; ')}\n${entry.prose}`,
      );
      // The settlers are named, so the history is about people rather than ids.
      assert.ok(!entry.prose.includes('agent_'), entry.prose);
    }

    // And the whole thing reads as a document a person would want to read.
    const text = renderChronicleText(entries);
    assert.match(text, /^Day \d+: /);
    assert.match(text, /founded at \(-?\d+, -?\d+, -?\d+\)/);

    await simulation.close();
  });
});

describe('reading a chronicle back', () => {
  it('says so when there is nothing to read', () => {
    assert.equal(renderChronicleText([]), 'The chronicle is empty.');
  });

  it('can mark which entries a model wrote', async () => {
    const store = seededStore();
    expect(await generateChronicle(deps(store)), 'chronicle');

    const text = renderChronicleText(store.chronicle.all(), { showSource: true });

    assert.equal(text.match(/\[rendered\]/g)?.length, 3);
    store.close();
  });

  it('generates only the days asked for', async () => {
    const store = seededStore();
    const entries = expect(
      await generateChronicle(deps(store), { fromDay: 2, toDay: 2 }),
      'chronicle',
    );

    assert.deepEqual(entries.map((entry) => entry.day), [2]);
    store.close();
  });

  it('refuses a range that runs backwards', async () => {
    const store = seededStore();
    const result = await generateChronicle(deps(store), { fromDay: 5, toDay: 2 });
    assert.equal(result.ok, false);
    store.close();
  });
});
