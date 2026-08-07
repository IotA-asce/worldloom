/**
 * Configuration: defaults, overridden by a YAML file, overridden by environment
 * variables. Validated with zod so a typo fails at startup with a useful
 * message rather than surfacing as odd behaviour twenty minutes into a run.
 *
 * API keys are never read from the YAML file — only from the environment
 * (requirement 42).
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { fail, ok, type Result } from './result.ts';

/** Reasoning categories. Each is separately routable and separately costed
 *  (ADR-0006); this list is the complete set of places a model may be called. */
export const REASONING_CATEGORIES = [
  'goal_selection',
  'replanning',
  'message_interpretation',
  'reflection',
  'consolidation',
  'chronicle',
] as const;

export type ReasoningCategory = (typeof REASONING_CATEGORIES)[number];

/** Strategic reasoning. The strongest model, because goal selection and
 *  replanning are where agent quality actually shows. */
const DEFAULT_MODEL = 'claude-opus-5';
/** Summarisation and classification — high volume, low difficulty. Routing
 *  these away from the strong model is the single biggest cost lever
 *  (requirement 26's "memory summarization → inexpensive model"). */
const CHEAP_MODEL = 'claude-haiku-4-5';

const simulationSchema = z.object({
  scenario: z.string().default('first-settlement'),
  agents: z.number().int().min(1).max(50).default(5),
  tick_interval_seconds: z.number().positive().default(2),
  max_days: z.number().int().positive().nullable().default(null),
  seed: z.number().int().default(1),
});

const minecraftSchema = z.object({
  bridge_url: z.string().default('ws://127.0.0.1:8765'),
  world: z.string().default('world'),
  embodiment: z.enum(['logical', 'piloted']).default('logical'),
  visible_markers: z.boolean().default(true),
  time_scale: z.number().positive().default(1),
  command_timeout_ms: z.number().int().positive().default(10_000),
});

const environmentSchema = z.object({
  type: z.enum(['minecraft', 'fake']).default('minecraft'),
  minecraft: minecraftSchema.prefault({}),
});

const reasoningSchema = z.object({
  provider: z.enum(['anthropic', 'heuristic', 'scripted']).default('anthropic'),
  model: z.string().default(DEFAULT_MODEL),
  max_concurrency: z.number().int().min(1).max(32).default(3),
  models: z
    .partialRecord(z.enum(REASONING_CATEGORIES), z.string())
    .default({
      message_interpretation: CHEAP_MODEL,
      reflection: CHEAP_MODEL,
      consolidation: CHEAP_MODEL,
    }),
  structured_retries: z.number().int().min(0).max(5).default(2),
  budget_usd: z.number().positive().nullable().default(null),
});

const memorySchema = z.object({
  retrieval_limit: z.number().int().min(1).max(100).default(10),
  consolidation_threshold: z.number().int().min(10).default(200),
  reflection_interval: z.number().int().min(1).default(15),
});

const persistenceSchema = z.object({
  database: z.string().default('./worldloom.db'),
});

const loggingSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  format: z.enum(['pretty', 'json']).default('pretty'),
  record_decisions: z.boolean().default(true),
});

export const configSchema = z.object({
  simulation: simulationSchema.prefault({}),
  environment: environmentSchema.prefault({}),
  reasoning: reasoningSchema.prefault({}),
  memory: memorySchema.prefault({}),
  persistence: persistenceSchema.prefault({}),
  logging: loggingSchema.prefault({}),
});

export type WorldloomConfig = z.infer<typeof configSchema>;

/** The model to use for a given reasoning category. */
export function modelFor(config: WorldloomConfig, category: ReasoningCategory): string {
  return config.reasoning.models[category] ?? config.reasoning.model;
}

/** Defaults only — the config every field's `.default()` describes. */
export function defaultConfig(): WorldloomConfig {
  return configSchema.parse({});
}

type Env = Record<string, string | undefined>;

/**
 * Environment overrides. Deliberately a short, explicit list rather than a
 * generic `WORLDLOOM_FOO_BAR` → `foo.bar` mapping: the explicit version is
 * greppable, and it can't silently accept a misspelled variable.
 */
function applyEnvOverrides(raw: Record<string, unknown>, env: Env): Record<string, unknown> {
  const out = structuredClone(raw);

  const setPath = (path: readonly string[], value: unknown): void => {
    let node = out;
    for (const key of path.slice(0, -1)) {
      const existing = node[key];
      if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
        node[key] = {};
      }
      node = node[key] as Record<string, unknown>;
    }
    node[path[path.length - 1]!] = value;
  };

  if (env.WORLDLOOM_BRIDGE_URL) {
    setPath(['environment', 'minecraft', 'bridge_url'], env.WORLDLOOM_BRIDGE_URL);
  }
  if (env.WORLDLOOM_DB) {
    setPath(['persistence', 'database'], env.WORLDLOOM_DB);
  }
  if (env.WORLDLOOM_LOG_LEVEL) {
    setPath(['logging', 'level'], env.WORLDLOOM_LOG_LEVEL);
  }
  if (env.WORLDLOOM_SCENARIO) {
    setPath(['simulation', 'scenario'], env.WORLDLOOM_SCENARIO);
  }
  if (env.WORLDLOOM_SEED) {
    setPath(['simulation', 'seed'], Number(env.WORLDLOOM_SEED));
  }
  if (env.WORLDLOOM_MODEL) {
    setPath(['reasoning', 'model'], env.WORLDLOOM_MODEL);
  }
  // No API key here: without a key the Anthropic provider can't be built, and
  // the run falls back to the rule-based provider. Keeps `npm test` keyless.
  if (env.WORLDLOOM_PROVIDER) {
    setPath(['reasoning', 'provider'], env.WORLDLOOM_PROVIDER);
  }

  return out;
}

export function parseConfig(raw: unknown, env: Env = process.env): Result<WorldloomConfig> {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return fail('INTERNAL', 'configuration must be a mapping at the top level');
  }

  const withEnv = applyEnvOverrides((raw ?? {}) as Record<string, unknown>, env);
  const parsed = configSchema.safeParse(withEnv);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    return fail('INTERNAL', `invalid configuration:\n${issues}`);
  }
  return ok(parsed.data);
}

/**
 * Load configuration from a YAML file. A missing file is not an error — the
 * defaults are a working configuration — but an unparseable or invalid one is.
 */
export function loadConfig(path: string | undefined, env: Env = process.env): Result<WorldloomConfig> {
  if (path === undefined) {
    return parseConfig({}, env);
  }

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return parseConfig({}, env);
    }
    return fail('INTERNAL', `cannot read config at ${path}: ${String(error)}`);
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return fail('INTERNAL', `cannot parse YAML at ${path}: ${String(error)}`);
  }

  return parseConfig(raw, env);
}
