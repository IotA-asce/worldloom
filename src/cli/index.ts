#!/usr/bin/env node
/**
 * The Worldloom CLI.
 *
 * Requirement 23 asks that a developer be able to see what every agent is doing
 * and why. These commands are that interface: thin queries over the database,
 * because the database is where the answers already are.
 */

import { loadConfig, type WorldloomConfig } from '../core/config.ts';
import { describeFailure } from '../core/result.ts';
import { formatPosition } from '../core/world.ts';
import { describeGoal } from '../goals/goal.ts';
import { describePlan } from '../goals/plan.ts';
import { describeNeeds } from '../agents/needs.ts';
import { formatCostUsd } from '../reasoning/pricing.ts';
import { Store } from '../persistence/store.ts';
import { Simulation } from '../simulation.ts';
import { describeRelationship, formatSource } from '../memory/types.ts';

const USAGE = `worldloom — persistent autonomous AI civilizations

Usage:
  worldloom run [scenario]        Run the simulation (resumes if a world exists)
  worldloom inspect [agent]       What every agent is doing, and why
  worldloom why <agent>           The decision trail behind an agent's choices
  worldloom events [--day N]      The event ledger
  worldloom memories <agent>      What an agent knows and remembers
  worldloom costs                 Token usage and estimated spend
  worldloom status                One-line summary of the civilization

Options:
  --config <path>   Configuration file (default: worldloom.yaml)
  --db <path>       Database file (overrides the config)
  --limit <n>       Rows to show (default 20)
  --day <n>         Filter events to one day
`;

interface Args {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }

  return { command: positional[0] ?? 'help', positional: positional.slice(1), flags };
}

function numberFlag(args: Args, name: string, fallback: number): number {
  const raw = args.flags[name];
  if (typeof raw !== 'string') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function resolveConfig(args: Args): WorldloomConfig {
  const path = typeof args.flags.config === 'string' ? args.flags.config : 'worldloom.yaml';
  const loaded = loadConfig(path);
  if (!loaded.ok) {
    process.stderr.write(`${describeFailure(loaded.failure)}\n`);
    process.exit(1);
  }
  const config = loaded.value;
  if (typeof args.flags.db === 'string') {
    return { ...config, persistence: { ...config.persistence, database: args.flags.db } };
  }
  return config;
}

/** Open the store read-only, for the inspection commands. */
function openStore(config: WorldloomConfig): Store {
  return Store.open({ path: config.persistence.database });
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdRun(args: Args): Promise<void> {
  const base = resolveConfig(args);
  const scenario = args.positional[0];
  const config =
    scenario === undefined
      ? base
      : {
          ...base,
          simulation: { ...base.simulation, scenario: scenario.replace(/^scenarios\//, '') },
        };

  const simulation = Simulation.create({ config });

  out();
  out('  WORLDLOOM');
  out(`  scenario: ${config.simulation.scenario}   agents: ${config.simulation.agents}`);
  out();

  const started = await simulation.start();
  if (!started.ok) {
    process.stderr.write(`\n  Could not start: ${describeFailure(started.failure)}\n\n`);
    if (started.failure.kind === 'ENVIRONMENT_DISCONNECTED') {
      // The adapter's message names the address and the cause; all the CLI adds
      // is the operational rule that catches people out.
      process.stderr.write(
        '  Check the environment is running, and that nothing else holds its\n' +
          '  connection — some environments accept only one client at a time.\n\n',
      );
    }
    await simulation.close();
    process.exit(1);
  }

  // Ctrl-C should stop cleanly, so the world stays resumable.
  const shutdown = (): void => {
    out('\n  Stopping — the civilization will resume where it left off.');
    simulation.stop();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await simulation.run();

  out();
  for (const line of simulation.status()) out(`  ${line}`);
  const spend = simulation.spentUsd();
  if (spend > 0) out(`\n  Estimated spend: ${formatCostUsd(spend)}`);
  out();

  await simulation.close();
}

function cmdInspect(args: Args): void {
  const store = openStore(resolveConfig(args));
  const wanted = args.positional[0];

  const agents = store.agents.all().filter(
    (agent) => wanted === undefined || agent.name.toLowerCase() === wanted.toLowerCase(),
  );

  if (agents.length === 0) {
    out(wanted === undefined ? '  No agents yet.' : `  No agent named '${wanted}'.`);
    store.close();
    return;
  }

  for (const agent of agents) {
    const goal = agent.currentGoalId === null ? null : store.goals.find(agent.currentGoalId);
    const plan = goal === null ? null : store.plans.activeForGoal(goal.id);

    out();
    out(`  ${agent.name} — ${agent.role}`);
    out(`    status     ${agent.status} (${agent.phase} phase) at ${formatPosition(agent.position)}`);
    out(`    activity   ${agent.activity || '—'}`);
    out(`    needs      ${describeNeeds(agent.needs)}`);
    out(`    carrying   ${formatBalance(store, agent.id)}`);

    if (goal === null) {
      out('    goal       none');
    } else {
      out(`    goal       ${describeGoal(goal)} — ${goal.reason}`);
      if (plan !== null) {
        out(`    plan       ${describePlan(plan)}`);
        for (const step of plan.steps) {
          const mark =
            step.status === 'completed' ? '✓' : step.status === 'failed' ? '✖' : step.status === 'skipped' ? '–' : ' ';
          const detail = step.failure !== null ? ` ← ${describeFailure(step.failure)}` : step.note !== null ? ` — ${step.note}` : '';
          out(`      ${mark} ${step.action}${detail}`);
        }
      }
    }

    const relationships = store.knowledge.relationshipsFor(agent.id);
    if (relationships.length > 0) {
      out('    knows');
      for (const relationship of relationships) {
        const other = store.agents.find(relationship.otherAgentId);
        out(
          `      ${other?.name ?? relationship.otherAgentId}: ${describeRelationship(relationship)}` +
            (relationship.lastReason === null ? '' : ` (${relationship.lastReason})`),
        );
      }
    }
  }
  out();
  store.close();
}

function cmdWhy(args: Args): void {
  const store = openStore(resolveConfig(args));
  const name = args.positional[0];
  if (name === undefined) {
    out('  Usage: worldloom why <agent>');
    store.close();
    return;
  }

  const agent = store.agents.findByName(name);
  if (agent === null) {
    out(`  No agent named '${name}'.`);
    store.close();
    return;
  }

  const decisions = store.decisions.forAgent(agent.id, numberFlag(args, 'limit', 10));
  if (decisions.length === 0) {
    out(`  ${agent.name} has made no recorded decisions yet.`);
    store.close();
    return;
  }

  out();
  out(`  Why ${agent.name} did what she did`);
  for (const decision of decisions) {
    out();
    out(`  day ${decision.day} · ${decision.category} · ${decision.model}`);
    out(`    chose      ${decision.chosenAction}`);
    out(`    saw        ${summarise(decision.observation)}`);
    if (decision.memoryIds.length > 0) {
      out(`    recalled   ${String(decision.memoryIds.length)} memory/ies`);
      for (const id of decision.memoryIds.slice(0, 3)) {
        const memory = store.memories.find(agent.id, id);
        if (memory !== null) out(`      "${memory.content}"`);
      }
    }
  }
  out();
  store.close();
}

function cmdEvents(args: Args): void {
  const store = openStore(resolveConfig(args));
  const limit = numberFlag(args, 'limit', 25);
  const day = args.flags.day === undefined ? undefined : numberFlag(args, 'day', 0);

  const events =
    day === undefined ? store.events.recent(limit).reverse() : store.events.query({ day, limit });

  if (events.length === 0) {
    out('  No events yet.');
    store.close();
    return;
  }

  out();
  for (const event of events) {
    const actor = event.actorId === null ? null : store.agents.find(event.actorId);
    const who = actor === null ? '' : `${actor.name} `;
    out(`  day ${event.day}  ${who}${event.type}  ${summarise(event.payload)}`);
  }
  out();
  store.close();
}

function cmdMemories(args: Args): void {
  const store = openStore(resolveConfig(args));
  const name = args.positional[0];
  if (name === undefined) {
    out('  Usage: worldloom memories <agent>');
    store.close();
    return;
  }
  const agent = store.agents.findByName(name);
  if (agent === null) {
    out(`  No agent named '${name}'.`);
    store.close();
    return;
  }

  const limit = numberFlag(args, 'limit', 20);
  out();
  out(`  ${agent.name} remembers`);
  for (const memory of store.memories.recent(agent.id, limit)) {
    out(
      `    [${memory.type}] ${memory.content}  (${formatSource(memory.source)}, importance ${memory.importance.toFixed(2)})`,
    );
  }

  const resources = store.knowledge.knownResources(agent.id);
  if (resources.length > 0) {
    out();
    out(`  ${agent.name} knows of`);
    for (const known of resources) {
      out(
        `    ${known.resource} at ${formatPosition(known.position)} — confidence ${known.confidence.toFixed(2)}, ${formatSource(known.source)}`,
      );
    }
  }

  const locations = store.knowledge.knownLocations(agent.id);
  if (locations.length > 0) {
    out();
    out('  and of these places');
    for (const known of locations.slice(0, limit)) {
      out(`    ${known.kind} at ${formatPosition(known.position)} — ${known.label || '—'}`);
    }
  }
  out();
  store.close();
}

function cmdCosts(args: Args): void {
  const store = openStore(resolveConfig(args));
  const total = store.llmCalls.total();

  out();
  if (total.calls === 0) {
    out('  No model calls — this run has been entirely rule-based.');
    out();
    store.close();
    return;
  }

  out('  Reasoning cost');
  out(`    calls          ${total.calls} (${total.failures} failed)`);
  out(`    input tokens   ${total.inputTokens.toLocaleString()}`);
  out(`    output tokens  ${total.outputTokens.toLocaleString()}`);
  out(`    estimated      ${formatCostUsd(total.costUsd)}`);

  out();
  out('  By category');
  for (const [category, summary] of store.llmCalls.byCategory()) {
    out(
      `    ${category.padEnd(24)} ${String(summary.calls).padStart(4)} calls  ${formatCostUsd(summary.costUsd)}`,
    );
  }

  const byDay = store.llmCalls.byDay();
  if (byDay.size > 1) {
    out();
    out('  By day');
    for (const [day, summary] of byDay) {
      out(`    day ${day.padEnd(20)} ${String(summary.calls).padStart(4)} calls  ${formatCostUsd(summary.costUsd)}`);
    }
  }
  out();
  store.close();
}

function cmdStatus(args: Args): void {
  const store = openStore(resolveConfig(args));

  if (!store.simulation.exists()) {
    out('  No civilization here yet. Run `worldloom run` to start one.');
    store.close();
    return;
  }

  const state = store.simulation.get();
  const time = store.simulation.currentTime();
  const agents = store.agents.all();
  const structures = new Set(
    store.events
      .query({ types: ['structure_completed'] })
      .map((event) => (event.payload as { type?: string }).type ?? 'structure'),
  );

  out();
  out(`  ${state.scenario} — day ${time.day}, ${time.phase}`);
  out(`    settlers     ${agents.filter((agent) => agent.status !== 'dead').length} of ${agents.length}`);
  out(`    structures   ${structures.size > 0 ? [...structures].join(', ') : 'none yet'}`);
  out(`    events       ${store.events.count()}`);
  out(`    status       ${state.status}`);
  out();
  for (const agent of agents) {
    const goal = agent.currentGoalId === null ? null : store.goals.find(agent.currentGoalId);
    out(`    ${agent.name.padEnd(8)} ${agent.status.padEnd(10)} ${goal === null ? '—' : describeGoal(goal)}`);
  }
  out();
  store.close();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatBalance(store: Store, agentId: string): string {
  const balance = store.ledger.balance({ id: agentId, kind: 'agent' });
  const parts = Object.entries(balance)
    .filter(([, quantity]) => (quantity ?? 0) > 0)
    .map(([resource, quantity]) => `${String(quantity)} ${resource}`);
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

/** Render a payload compactly — an inspect command should fit on a screen. */
function summarise(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);

  const parts: string[] = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined) continue;
    if (key.endsWith('Id') || key === 'agentId') continue;
    if (typeof raw === 'object') {
      const point = raw as { x?: number; y?: number; z?: number };
      if (typeof point.x === 'number' && typeof point.z === 'number') {
        parts.push(`${key}=${formatPosition({ x: point.x, y: point.y ?? 0, z: point.z })}`);
        continue;
      }
      parts.push(`${key}=${JSON.stringify(raw).slice(0, 40)}`);
      continue;
    }
    parts.push(`${key}=${String(raw)}`);
  }
  return parts.slice(0, 6).join(' ');
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'run':
      await cmdRun(args);
      return;
    case 'inspect':
      cmdInspect(args);
      return;
    case 'why':
      cmdWhy(args);
      return;
    case 'events':
      cmdEvents(args);
      return;
    case 'memories':
      cmdMemories(args);
      return;
    case 'costs':
      cmdCosts(args);
      return;
    case 'status':
      cmdStatus(args);
      return;
    case 'help':
    case '--help':
    case '-h':
      out(USAGE);
      return;
    default:
      process.stderr.write(`Unknown command '${args.command}'.\n\n${USAGE}`);
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\n  ${String(error)}\n\n`);
  process.exit(1);
});
