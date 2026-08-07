import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  defaultConfig,
  loadConfig,
  modelFor,
  parseConfig,
  REASONING_CATEGORIES,
} from '../../src/core/config.ts';
import { expect } from '../../src/core/result.ts';

const NO_ENV = {};

function writeTemp(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'worldloom-config-'));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe('config defaults', () => {
  it('an empty config is a complete, valid config', () => {
    const config = defaultConfig();
    assert.equal(config.simulation.agents, 5);
    assert.equal(config.simulation.scenario, 'first-settlement');
    assert.equal(config.environment.type, 'minecraft');
    assert.equal(config.environment.minecraft.bridge_url, 'ws://127.0.0.1:8765');
    assert.equal(config.environment.minecraft.embodiment, 'logical');
    assert.equal(config.reasoning.max_concurrency, 3);
    assert.equal(config.memory.retrieval_limit, 10);
    assert.equal(config.logging.level, 'info');
  });

  it('nested defaults fill in when a parent section is partially specified', () => {
    const config = expect(parseConfig({ environment: { type: 'fake' } }, NO_ENV), 'parse');
    assert.equal(config.environment.type, 'fake');
    // The minecraft block is absent from the input but must still be complete.
    assert.equal(config.environment.minecraft.command_timeout_ms, 10_000);
  });

  it('does not read an API key from the config file', () => {
    const config = expect(parseConfig({ reasoning: { api_key: 'sk-leak' } }, NO_ENV), 'parse');
    assert.ok(!('api_key' in config.reasoning), 'api_key must not survive parsing');
  });
});

describe('config validation', () => {
  it('rejects an out-of-range agent count with a pathed message', () => {
    const result = parseConfig({ simulation: { agents: 0 } }, NO_ENV);
    assert.equal(result.ok, false);
    assert.match(result.failure.detail, /simulation\.agents/);
  });

  it('rejects an unknown enum value', () => {
    const result = parseConfig({ environment: { type: 'godot' } }, NO_ENV);
    assert.equal(result.ok, false);
    assert.match(result.failure.detail, /environment\.type/);
  });

  it('rejects a non-mapping top level', () => {
    assert.equal(parseConfig([1, 2, 3], NO_ENV).ok, false);
    assert.equal(parseConfig('a string', NO_ENV).ok, false);
  });

  it('treats null and undefined as "use the defaults"', () => {
    assert.equal(expect(parseConfig(null, NO_ENV), 'null').simulation.agents, 5);
    assert.equal(expect(parseConfig(undefined, NO_ENV), 'undefined').simulation.agents, 5);
  });

  it('accepts an explicit null for nullable settings', () => {
    const config = expect(parseConfig({ simulation: { max_days: null } }, NO_ENV), 'parse');
    assert.equal(config.simulation.max_days, null);
  });
});

describe('environment overrides', () => {
  it('override file values', () => {
    const config = expect(
      parseConfig(
        { environment: { minecraft: { bridge_url: 'ws://from-file:1' } } },
        { WORLDLOOM_BRIDGE_URL: 'ws://from-env:2' },
      ),
      'parse',
    );
    assert.equal(config.environment.minecraft.bridge_url, 'ws://from-env:2');
  });

  it('create missing intermediate sections', () => {
    const config = expect(parseConfig({}, { WORLDLOOM_BRIDGE_URL: 'ws://host:9' }), 'parse');
    assert.equal(config.environment.minecraft.bridge_url, 'ws://host:9');
  });

  it('do not clobber siblings in the section they touch', () => {
    const config = expect(
      parseConfig(
        { environment: { minecraft: { world: 'nether', time_scale: 4 } } },
        { WORLDLOOM_BRIDGE_URL: 'ws://host:9' },
      ),
      'parse',
    );
    assert.equal(config.environment.minecraft.world, 'nether');
    assert.equal(config.environment.minecraft.time_scale, 4);
    assert.equal(config.environment.minecraft.bridge_url, 'ws://host:9');
  });

  it('are validated too — a bad env value fails rather than passing through', () => {
    const result = parseConfig({}, { WORLDLOOM_LOG_LEVEL: 'chatty' });
    assert.equal(result.ok, false);
    assert.match(result.failure.detail, /logging\.level/);
  });

  it('coerce a numeric seed', () => {
    const config = expect(parseConfig({}, { WORLDLOOM_SEED: '99' }), 'parse');
    assert.equal(config.simulation.seed, 99);
  });

  it('ignore empty-string variables rather than treating them as values', () => {
    const config = expect(parseConfig({}, { WORLDLOOM_SCENARIO: '' }), 'parse');
    assert.equal(config.simulation.scenario, 'first-settlement');
  });
});

describe('loadConfig', () => {
  it('reads and merges a YAML file', () => {
    const path = writeTemp(
      'worldloom.yaml',
      ['simulation:', '  agents: 3', '  seed: 7', 'logging:', '  level: debug'].join('\n'),
    );
    const config = expect(loadConfig(path, NO_ENV), 'load');
    assert.equal(config.simulation.agents, 3);
    assert.equal(config.simulation.seed, 7);
    assert.equal(config.logging.level, 'debug');
    // Untouched sections keep their defaults.
    assert.equal(config.memory.retrieval_limit, 10);
  });

  it('falls back to defaults when the file is missing', () => {
    const config = expect(loadConfig('/nonexistent/worldloom.yaml', NO_ENV), 'load');
    assert.equal(config.simulation.agents, 5);
  });

  it('falls back to defaults when no path is given', () => {
    assert.equal(expect(loadConfig(undefined, NO_ENV), 'load').simulation.agents, 5);
  });

  it('fails loudly on malformed YAML', () => {
    const path = writeTemp('broken.yaml', 'simulation:\n  agents: [unclosed\n');
    const result = loadConfig(path, NO_ENV);
    assert.equal(result.ok, false);
    assert.match(result.failure.detail, /cannot parse YAML/);
  });

  it('fails on a YAML file that is valid but invalid as config', () => {
    const path = writeTemp('bad.yaml', 'simulation:\n  agents: many\n');
    const result = loadConfig(path, NO_ENV);
    assert.equal(result.ok, false);
    assert.match(result.failure.detail, /simulation\.agents/);
  });

  it('parses the committed example config, which stays in step with the defaults', () => {
    const config = expect(loadConfig('worldloom.example.yaml', NO_ENV), 'example config');
    const defaults = defaultConfig();

    // The example spells out all six model routes for documentation value,
    // whereas the defaults only carry the three cheap overrides — so compare
    // the routing by what it resolves to rather than by shape.
    for (const category of REASONING_CATEGORIES) {
      assert.equal(
        modelFor(config, category),
        modelFor(defaults, category),
        `example config routes ${category} differently from the default`,
      );
    }

    const { models: _exampleModels, ...exampleReasoning } = config.reasoning;
    const { models: _defaultModels, ...defaultReasoning } = defaults.reasoning;
    assert.deepEqual(exampleReasoning, defaultReasoning);
    assert.deepEqual({ ...config, reasoning: null }, { ...defaults, reasoning: null });
  });
});

describe('modelFor', () => {
  it('routes cheap categories to the cheap model by default', () => {
    const config = defaultConfig();
    assert.equal(modelFor(config, 'goal_selection'), config.reasoning.model);
    assert.notEqual(modelFor(config, 'consolidation'), config.reasoning.model);
  });

  it('falls back to the base model for an unrouted category', () => {
    const config = expect(
      parseConfig({ reasoning: { model: 'base-model', models: {} } }, NO_ENV),
      'parse',
    );
    assert.equal(modelFor(config, 'reflection'), 'base-model');
  });

  it('honours an explicit per-category override', () => {
    const config = expect(
      parseConfig({ reasoning: { models: { chronicle: 'special-model' } } }, NO_ENV),
      'parse',
    );
    assert.equal(modelFor(config, 'chronicle'), 'special-model');
  });
});
