import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { Store } from '../../src/persistence/store.ts';
import { MIRA, SAMPLE_PAYLOADS, testAgent } from '../chronicle/fixture.ts';

const cli = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));

function invoke(directory: string, ...args: string[]) {
  return spawnSync(process.execPath, [
    '--no-warnings=ExperimentalWarning', '--import', import.meta.resolve('tsx'), cli,
    'chronicle', '--db', join(directory, 'test.db'), ...args,
  ], {
    cwd: directory,
    env: { ...process.env, WORLDLOOM_PROVIDER: 'heuristic' },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function temporary(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'worldloom-chronicle-'));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('chronicle CLI threshold', () => {
  for (const value of ['-0.1', '1.1', 'NaN', 'Infinity', 'nope', '', ' ']) {
    it(`rejects ${JSON.stringify(value)} before creating a database`, () => temporary((directory) => {
      const result = invoke(directory, '--generate', '--threshold', value);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /--threshold requires a finite number from 0 to 1/);
      assert.equal(existsSync(join(directory, 'test.db')), false);
    }));
  }

  it('requires a value', () => temporary((directory) => {
    const result = invoke(directory, '--generate', '--threshold');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--threshold requires a finite number/);
    assert.equal(existsSync(join(directory, 'test.db')), false);
  }));

  it('requires explicit generation', () => temporary((directory) => {
    const result = invoke(directory, '--threshold', '0.3');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--threshold requires chronicle --generate/);
    assert.equal(existsSync(join(directory, 'test.db')), false);
  }));

  for (const threshold of ['0', '1']) {
    it(`accepts boundary ${threshold}`, () => temporary((directory) => {
      const result = invoke(directory, '--generate', '--threshold', threshold);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`Importance threshold pinned to ${threshold}`));
    }));
  }

  it('reveals routine work with its event citation while preserving the ledger', () => temporary((directory) => {
    const database = join(directory, 'test.db');
    const seed = Store.open(database);
    seed.agents.insert(testAgent(MIRA, 'Mira', 'Builder'));
    const event = seed.events.append({
      type: 'resource_collected', actorId: MIRA, payload: SAMPLE_PAYLOADS.resource_collected,
    }, { day: 3, worldTicks: 300 });
    const before = JSON.stringify(seed.events.query({}));
    seed.close();

    const automatic = invoke(directory, '--generate');
    assert.equal(automatic.status, 0, automatic.stderr);
    assert.match(automatic.stdout, /0 entries/);
    assert.doesNotMatch(automatic.stdout, /threshold pinned/);

    const detailed = invoke(directory, '--generate', '--threshold', '0.3', '--cite');
    assert.equal(detailed.status, 0, detailed.stderr);
    assert.match(detailed.stdout, /Mira/);
    assert.match(detailed.stdout, /24 wood/);
    assert.ok(detailed.stdout.includes(event.id), detailed.stdout);
    const after = Store.open(database);
    try {
      assert.equal(JSON.stringify(after.events.query({})), before);
      assert.deepEqual(after.chronicle.forDay(3)?.eventIds, [event.id]);
    } finally { after.close(); }
  }));
});
