#!/usr/bin/env node
/**
 * Validate the Minecraft adapter against a live Paper server.
 *
 * Everything in `npm test` runs against `FakeEnvironment`, which is deliberate —
 * but it means the Minecraft adapter's assumptions about the bridge are
 * *unverified* until something exercises them for real. This script is that
 * something: it drives every `Environment` method through the real bridge and
 * reports what actually happened.
 *
 * It checks the things that can only fail against a real server:
 *
 *  - the bridge protocol version matches (constraint C2)
 *  - a heightmap comes back in the shape the adapter parses
 *  - `fill` actually changed blocks rather than silently no-opping on unloaded
 *    chunks — the nastiest failure mode, because it looks like success (C5)
 *  - the harvest path credits only what it verified (ADR-0004)
 *  - a blueprint places and then re-reads as built
 *
 * Usage:
 *   npm run smoke:minecraft                  # against ws://127.0.0.1:8765
 *   WORLDLOOM_BRIDGE_URL=... npm run smoke:minecraft
 *   npm run smoke:minecraft -- --keep        # leave the test structure standing
 *
 * It builds in a small area offset from spawn and tidies up afterwards unless
 * asked not to. Do not point it at a world you care about.
 */

import type { AgentView } from '../src/agents/agent.ts';
import type { AgentId } from '../src/core/ids.ts';
import { describeFailure, type Result } from '../src/core/result.ts';
import {
  formatBundle,
  formatPosition,
  formatRegion,
  region as makeRegion,
  regionVolume,
  type Position,
  type Region,
} from '../src/core/world.ts';
import { MinecraftEnvironment } from '../src/environment/minecraft/adapter.ts';
import { BridgeClient } from '../src/environment/minecraft/bridge-client.ts';
import { SMALL_SHELTER } from '../src/civilization/blueprints.ts';

/** Where to run the checks: far enough from spawn to be out of the way. */
const TEST_ORIGIN: Position = { x: 512, y: 0, z: 512 };

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** Set when the check could not run because a prerequisite failed. */
  readonly skipped?: boolean;
}

const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  const mark = ok ? '[32m✓[0m' : '[31m✖[0m';
  process.stdout.write(`  ${mark} ${name}\n      ${detail}\n`);
}

function skip(name: string, why: string): void {
  results.push({ name, ok: false, detail: why, skipped: true });
  process.stdout.write(`  [33m–[0m ${name}\n      skipped: ${why}\n`);
}

/** Unwrap a result for a check, recording the failure if there is one. */
function taken<T>(name: string, result: Result<T>): T | null {
  if (result.ok) return result.value;
  record(name, false, describeFailure(result.failure));
  return null;
}

async function main(): Promise<void> {
  const keep = process.argv.includes('--keep');
  const url = process.env.WORLDLOOM_BRIDGE_URL ?? 'ws://127.0.0.1:8765';

  process.stdout.write(`\n  Worldloom — Minecraft adapter smoke test\n  bridge: ${url}\n\n`);

  const bridge = new BridgeClient({ url });
  const environment = new MinecraftEnvironment({
    bridge,
    embodiment: 'logical',
    // Markers are cosmetic; leaving them off keeps the test world clean.
    visibleMarkers: false,
  });

  // ── Connect ───────────────────────────────────────────────────────────────
  const connected = await environment.connect();
  if (!connected.ok) {
    process.stdout.write(
      `  [31m✖ cannot reach the bridge[0m\n      ${describeFailure(connected.failure)}\n\n` +
        '  Start the Paper server from minecraft-mcp first:\n' +
        '      npm run start:server\n\n' +
        '  And note the bridge accepts one client at a time — an MCP harness\n' +
        '  connected to the same server will take the connection.\n\n',
    );
    process.exit(1);
  }
  record('connect', true, `${connected.value.kind}, ${connected.value.embodiment} embodiment`);

  // ── World clock ───────────────────────────────────────────────────────────
  const time = taken('read the world clock', await environment.worldTime());
  if (time !== null) {
    record(
      'read the world clock',
      true,
      `tick ${time.totalTicks}, ${time.phase}, ${time.weather}${time.isDay ? ', daylight' : ''}`,
    );
  }

  // ── Survey ────────────────────────────────────────────────────────────────
  // The heightmap is the primary sensor; if its shape isn't what the adapter
  // expects, nothing downstream works.
  const surveyRegion: Region = makeRegion(
    { x: TEST_ORIGIN.x - 32, y: -64, z: TEST_ORIGIN.z - 32 },
    { x: TEST_ORIGIN.x + 32, y: 320, z: TEST_ORIGIN.z + 32 },
  );
  const survey = taken('survey terrain', await environment.surveyRegion(surveyRegion, 4));
  if (survey === null) {
    finish(keep, bridge);
    return;
  }
  const surfaces = new Set(survey.cells.map((cell) => cell.surface));
  record(
    'survey terrain',
    survey.cells.length > 0,
    `${survey.cells.length} cells over ${formatRegion(surveyRegion)}; surfaces seen: ` +
      `${[...surfaces].join(', ')}`,
  );

  // Ground level at the test origin, from the real world.
  const groundCell =
    survey.cells.find((cell) => cell.x === TEST_ORIGIN.x && cell.z === TEST_ORIGIN.z) ??
    survey.cells[Math.floor(survey.cells.length / 2)]!;
  const ground: Position = { x: groundCell.x, y: groundCell.y, z: groundCell.z };
  const standing: Position = { x: ground.x, y: ground.y + 1, z: ground.z };
  process.stdout.write(
    `\n      test site: ${formatPosition(standing)} (surface ${groundCell.surface})\n\n`,
  );

  // ── Inspect a single block ────────────────────────────────────────────────
  const block = taken('inspect a block', await environment.inspect(ground));
  if (block !== null) {
    record(
      'inspect a block',
      true,
      `${formatPosition(ground)} is ${block.surface}` +
        `${block.yields === null ? '' : `, yields ${block.yields}`}` +
        `, ${block.solid ? 'solid' : 'not solid'}`,
    );
  }

  const agent: AgentView = { id: 'agent_smoke' as AgentId, name: 'Smoke', position: standing };

  // ── Observe ───────────────────────────────────────────────────────────────
  const observation = taken('observe', await environment.observe(agent, 24));
  if (observation !== null) {
    record(
      'observe',
      true,
      `${observation.terrain.cells.length} terrain cells, ` +
        `${observation.visibleResources.length} resource cluster(s): ` +
        `${observation.visibleResources.map((r) => r.resource).join(', ') || 'none'}; ` +
        `${observation.nearbyEntities.length} entity/ies; sheltered=${observation.sheltered}`,
    );
  }

  // ── Movement ──────────────────────────────────────────────────────────────
  // Logical embodiment: validated against real terrain, so a refusal here is a
  // correct outcome, not necessarily a failure.
  const destination: Position = { x: standing.x + 12, y: standing.y, z: standing.z };
  const moved = await environment.moveAgent(agent, destination);
  if (moved.ok) {
    record(
      'move across real terrain',
      true,
      `travelled ${Math.round(moved.value.distance)} blocks to ` +
        `${formatPosition(moved.value.to)}, arrived=${moved.value.arrived}`,
    );
  } else if (moved.failure.kind === 'PATH_BLOCKED') {
    // Refusing to cross impassable ground is the adapter working, not failing.
    record('move across real terrain', true, `correctly refused: ${moved.failure.detail}`);
  } else {
    record('move across real terrain', false, describeFailure(moved.failure));
  }

  // ── Clear a site, and prove the write actually landed ─────────────────────
  // This is the C5 check. A `fill` on unloaded chunks silently does nothing, so
  // the only honest test is to write and then read back.
  const clearRegion: Region = makeRegion(
    { x: standing.x, y: standing.y, z: standing.z },
    { x: standing.x + 6, y: standing.y + 5, z: standing.z + 6 },
  );
  const cleared = await environment.clearRegion(agent, clearRegion);
  if (cleared.ok) {
    record(
      'clear a site (and verify the write landed)',
      cleared.value.complete,
      `${cleared.value.blocksPlaced} blocks emptied over ${regionVolume(clearRegion)}; ` +
        `verified from ${cleared.value.verifiedSample} samples, complete=${cleared.value.complete}`,
    );
  } else {
    record('clear a site (and verify the write landed)', false, describeFailure(cleared.failure));
  }

  // ── Harvest, and check the ledger would only be credited for what changed ─
  const harvestRegion: Region = makeRegion(
    { x: standing.x - 10, y: ground.y - 6, z: standing.z - 10 },
    { x: standing.x - 2, y: ground.y - 1, z: standing.z - 2 },
  );
  const harvested = await environment.harvest(agent, harvestRegion, 'stone', 12);
  if (harvested.ok) {
    const result = harvested.value;
    record(
      'harvest stone (credit only what verified)',
      result.blocksRemoved > 0 && result.verifiedSample > 0,
      `gained ${formatBundle(result.gained)} from ${result.blocksRemoved} blocks, ` +
        `verified from ${result.verifiedSample} samples`,
    );
  } else if (harvested.failure.kind === 'RESOURCE_UNAVAILABLE') {
    // An honest "nothing there" is the adapter working correctly.
    record(
      'harvest stone (credit only what verified)',
      true,
      `honestly reported nothing to harvest: ${harvested.failure.detail}`,
    );
  } else {
    record('harvest stone (credit only what verified)', false, describeFailure(harvested.failure));
  }

  // ── Build a real structure, then re-read it ───────────────────────────────
  const buildOrigin: Position = { x: standing.x, y: standing.y, z: standing.z };
  const built = await environment.build(agent, SMALL_SHELTER, buildOrigin);
  if (built.ok) {
    record(
      'build a shelter',
      built.value.complete,
      `${built.value.blocksPlaced} placed, ${built.value.blocksFailed} missing, ` +
        `verified from ${built.value.verifiedSample} samples at ${formatPosition(buildOrigin)}`,
    );

    // Independent re-read: the build reported success, but does it still stand?
    const verified = await environment.verifyBuild(SMALL_SHELTER, buildOrigin);
    if (verified.ok) {
      record(
        're-read the structure independently',
        verified.value.complete,
        `${verified.value.blocksPlaced} of ${verified.value.blocksPlaced + verified.value.blocksFailed} ` +
          `blocks confirmed present`,
      );
    } else {
      record('re-read the structure independently', false, describeFailure(verified.failure));
    }
  } else {
    record('build a shelter', false, describeFailure(built.failure));
    skip('re-read the structure independently', 'the build did not succeed');
  }

  // ── Visible marker ────────────────────────────────────────────────────────
  const marked = await new MinecraftEnvironment({
    bridge,
    embodiment: 'logical',
    visibleMarkers: true,
  }).presentAgent(agent);
  record(
    'summon a visible marker (cosmetic)',
    marked.ok,
    marked.ok ? 'marker placed' : describeFailure(marked.failure),
  );

  // ── Tidy up ───────────────────────────────────────────────────────────────
  if (!keep) {
    const tidied = await environment.clearRegion(
      agent,
      makeRegion(
        { x: buildOrigin.x - 1, y: buildOrigin.y - 1, z: buildOrigin.z - 1 },
        { x: buildOrigin.x + 8, y: buildOrigin.y + 6, z: buildOrigin.z + 8 },
      ),
    );
    process.stdout.write(
      tidied.ok
        ? `\n      tidied up the test site\n`
        : `\n      could not tidy up: ${describeFailure(tidied.failure)}\n`,
    );
  } else {
    process.stdout.write(`\n      left the test structure standing at ${formatPosition(buildOrigin)}\n`);
  }

  finish(keep, bridge);
}

function finish(_keep: boolean, bridge: BridgeClient): void {
  const ran = results.filter((result) => result.skipped !== true);
  const passed = ran.filter((result) => result.ok);
  const failed = ran.filter((result) => !result.ok);
  const skipped = results.filter((result) => result.skipped === true);

  process.stdout.write(
    `\n  ${passed.length}/${ran.length} checks passed` +
      `${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}\n`,
  );

  if (failed.length > 0) {
    process.stdout.write('\n  Failed:\n');
    for (const result of failed) {
      process.stdout.write(`    ${result.name}: ${result.detail}\n`);
    }
  }
  process.stdout.write('\n');

  bridge.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(`\n  smoke test crashed: ${String(error)}\n\n`);
  process.exit(1);
});
