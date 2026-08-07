/**
 * The boundary that keeps Worldloom portable, enforced rather than documented.
 *
 * Nothing above `src/environment/` may know about Minecraft. This test exists
 * because that rule is easy to state, easy to violate with one convenient
 * import, and expensive to repair once a dozen modules depend on `oak_log`.
 *
 * If this test fails, the fix is a normalised concept on the Environment port —
 * not an exemption here.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

const SRC = join(import.meta.dirname, '..', 'src');

/** Directories allowed to speak Minecraft. */
const MINECRAFT_ZONE = join(SRC, 'environment', 'minecraft');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path));
    } else if (entry.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** Strip comments and doc blocks — prose may discuss Minecraft freely; code
 *  may not. Without this the test would forbid explaining itself. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Minecraft vocabulary that must not appear in core code. Deliberately concrete
 * — a vague pattern would either miss violations or flag innocent words.
 *
 * `naming` rules are about mere mention of the implementation, which selection
 * and wiring code legitimately needs. `coupling` rules are absolute: a block id
 * or a bridge command in core code is always wrong.
 */
const FORBIDDEN: readonly (readonly [RegExp, string, 'coupling' | 'naming'])[] = [
  [/\boak_log\b|\bcobblestone\b|\boak_planks\b|\bdeepslate\b|\bgrass_block\b/, 'a Minecraft block id', 'coupling'],
  [/\bBukkit\b|\bbukkit\b/, 'a Bukkit/Paper concept', 'coupling'],
  [/\bforceload\b|\bsetblock\b/, 'a Minecraft console command', 'coupling'],
  [
    /\bget_heightmap\b|\bget_block_at\b|\brun_command\b|\bplace_block\b|\bbreak_block\b|\bmove_to\b|\bsummon_entity\b/,
    'a bridge command',
    'coupling',
  ],
  [/minecraft/i, 'the word "minecraft"', 'naming'],
];

/**
 * Files whose job is to *choose* an environment, and so must be able to name
 * one. They still may not use any Minecraft concept — only the identifier.
 */
const MAY_NAME_ENVIRONMENTS: readonly string[] = [
  join(SRC, 'core', 'config.ts'),
  join(SRC, 'environment', 'index.ts'),
];

describe('core stays free of Minecraft', () => {
  const coreFiles = walk(SRC).filter((path) => !path.startsWith(MINECRAFT_ZONE));

  it('has core files to check', () => {
    assert.ok(coreFiles.length > 5, `expected a populated src tree, found ${coreFiles.length} files`);
  });

  it('never references Minecraft vocabulary outside the adapter', () => {
    const violations: string[] = [];

    for (const path of coreFiles) {
      const code = codeOnly(readFileSync(path, 'utf8'));
      const mayName = MAY_NAME_ENVIRONMENTS.includes(path);

      for (const [pattern, description, severity] of FORBIDDEN) {
        if (severity === 'naming' && mayName) continue;
        const match = pattern.exec(code);
        if (match !== null) {
          violations.push(
            `${relative(SRC, path)} contains ${description} ('${match[0]}') — ` +
              'move it behind the Environment port',
          );
        }
      }
    }

    assert.deepEqual(violations, [], `\n${violations.join('\n')}\n`);
  });

  it('never imports from the Minecraft adapter outside the environment layer', () => {
    const outsideEnvironment = walk(SRC).filter(
      (path) => !path.startsWith(join(SRC, 'environment')),
    );

    const violations: string[] = [];
    for (const path of outsideEnvironment) {
      const source = readFileSync(path, 'utf8');
      if (/from\s+['"][^'"]*environment\/minecraft/.test(source)) {
        violations.push(relative(SRC, path));
      }
    }

    // Only wiring code may construct the adapter, and it does so via the
    // Environment interface — see src/environment/index.ts.
    assert.deepEqual(violations, [], `these files import the Minecraft adapter: ${violations.join(', ')}`);
  });
});

describe('knowledge boundaries are structurally enforced', () => {
  /**
   * Tables holding one agent's private state. A read of any of these that is not
   * filtered by `agent_id` is an omniscience leak (ADR-0007) — and it is exactly
   * the kind of bug that produces plausible-looking output while quietly
   * destroying the simulation's honesty.
   */
  const PRIVATE_TABLES = ['memories', 'known_locations', 'known_resources', 'relationships'];

  const REPOSITORY_FILES = [
    join(SRC, 'persistence', 'repositories', 'memories.ts'),
    join(SRC, 'persistence', 'repositories', 'knowledge.ts'),
  ];

  it('every read of a per-agent table filters by agent_id', () => {
    const violations: string[] = [];

    for (const path of REPOSITORY_FILES) {
      const code = codeOnly(readFileSync(path, 'utf8'));

      for (const match of code.matchAll(/SELECT[\s\S]*?`/g)) {
        const sql = match[0];
        const table = PRIVATE_TABLES.find((name) => new RegExp(`FROM\\s+${name}\\b`).test(sql));
        if (table === undefined) continue;
        if (/agent_id\s*=\s*\?/.test(sql)) continue;

        // Some queries build their WHERE clause dynamically, so the filter is
        // in the surrounding method rather than the SQL literal. Widen to that
        // method before calling it a violation — but keep the window tight, so
        // an unrelated agent_id elsewhere in the file can't launder a real leak.
        const start = Math.max(0, (match.index ?? 0) - 700);
        const context = code.slice(start, (match.index ?? 0) + sql.length);
        if (/clauses[^;]*'agent_id = \?'/.test(context)) continue;

        violations.push(
          `${relative(SRC, path)}: a SELECT from '${table}' is not scoped by agent_id — ` +
            `${sql.replace(/\s+/g, ' ').slice(0, 90)}`,
        );
      }
    }

    assert.deepEqual(violations, [], `\n${violations.join('\n')}\n`);
  });

  it('the agent_id filter test would catch a real leak', () => {
    // A guard on the guard: without this, a regex that matches nothing would
    // pass silently and the boundary would be unprotected.
    const leaky = "db.prepare(`SELECT * FROM memories WHERE importance > ?`)";
    const table = PRIVATE_TABLES.find((name) => new RegExp(`FROM\\s+${name}\\b`).test(leaky));
    assert.equal(table, 'memories');
    assert.ok(!/agent_id\s*=\s*\?/.test(leaky));
    assert.ok(!/clauses[^;]*'agent_id = \?'/.test(leaky));
  });

  it('exposes no cross-agent query method', () => {
    // The absence of these is the enforcement mechanism; adding one should make
    // this test fail rather than pass review unnoticed.
    const forbidden = [/\ballMemories\b/, /\ballKnownResources\b/, /\ballKnownLocations\b/, /\ballRelationships\b/];

    for (const path of REPOSITORY_FILES) {
      const code = codeOnly(readFileSync(path, 'utf8'));
      for (const pattern of forbidden) {
        assert.ok(
          !pattern.test(code),
          `${relative(SRC, path)} exposes a cross-agent query (${String(pattern)}) — see ADR-0007`,
        );
      }
    }
  });

  it('records a source for everything an agent comes to know', () => {
    // Knowledge with no provenance cannot be explained later, which breaks the
    // causal chain the chronicle depends on.
    const code = readFileSync(join(SRC, 'persistence', 'repositories', 'knowledge.ts'), 'utf8');
    for (const table of ['known_locations', 'known_resources']) {
      const insert = new RegExp(`INSERT INTO ${table}[^\`]*`).exec(code);
      assert.ok(insert !== null, `no INSERT found for ${table}`);
      assert.match(insert[0], /source/, `INSERT INTO ${table} does not record a source`);
    }
  });
});
