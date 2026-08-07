#!/usr/bin/env node
/**
 * The Worldloom CLI.
 *
 * Requirement 23 asks that a developer be able to see what every agent is doing
 * and why. These commands are that interface, and they are deliberately thin:
 * every one of them formats a view model from `src/observability/` rather than
 * querying the database itself. The views are the contract — a dashboard in
 * another language reads the same shapes, so anything the CLI can show, a UI can
 * show, and neither can drift from the other.
 */

import { loadConfig, type WorldloomConfig } from '../core/config.ts';
import { describeFailure } from '../core/result.ts';
import { formatBundle, formatPosition } from '../core/world.ts';
import {
  generateChronicle,
  readChronicle,
  renderChronicleText,
} from '../chronicle/generator.ts';
import { bandOf } from '../chronicle/importance.ts';
import { formatSource } from '../memory/types.ts';
import { createReasoningProvider } from '../reasoning/index.ts';
import { formatCostUsd } from '../reasoning/pricing.ts';
import { Store } from '../persistence/store.ts';
import { Simulation } from '../simulation.ts';
import {
  agentView,
  causalChains,
  civilizationView,
  costView,
  explainEvent,
  failureView,
  liveFeedView,
  type AgentStateView,
  type CausalChainView,
  type EventView,
  type MemoryView,
  type PlanView,
} from '../observability/index.ts';

const USAGE = `worldloom — persistent autonomous AI civilizations

Usage:
  worldloom run [scenario]        Run the simulation (resumes if a world exists)
  worldloom status                One-line summary of the civilization
  worldloom inspect [agent]       What every agent is doing, and why
  worldloom why <agent>           Decisions, what they cited, and what came of them
  worldloom explain <event-id>    Why one event happened
  worldloom events [--day N]      The event ledger
  worldloom failures              What has been going wrong, grouped
  worldloom memories <agent>      What an agent knows and remembers
  worldloom chronicle             The settlement's history
  worldloom costs                 Token usage and estimated spend

Options:
  --config <path>   Configuration file (default: worldloom.yaml)
  --db <path>       Database file (overrides the config)
  --limit <n>       Rows to show (default 20)
  --day <n>         Filter to one day
  --generate        chronicle: write entries from the ledger before reading
  --cite            chronicle: show the event ids each entry was built from
  --verbose         Show more of each record
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

/** Open the store for the inspection commands. */
function openStore(config: WorldloomConfig): Store {
  return Store.open({ path: config.persistence.database });
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** `4 wood, 2 stone` or `nothing` — a bundle as a person would say it. */
function bundleText(bundle: Parameters<typeof formatBundle>[0]): string {
  const text = formatBundle(bundle);
  return text.length > 0 ? text : 'nothing';
}

function pct(value: number): string {
  return `${String(Math.round(value * 100))}%`;
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

function cmdStatus(args: Args): void {
  const store = openStore(resolveConfig(args));
  const view = civilizationView(store);

  if (!view.initialised) {
    out('  No civilization here yet. Run `worldloom run` to start one.');
    store.close();
    return;
  }

  const place = view.settlement;
  out();
  out(`  ${view.scenario ?? 'unnamed'} — day ${view.time.day}, ${view.time.phase}, ${view.time.weather}`);
  out(
    `    settlement   ${place === null ? 'none founded' : `${place.name} at ${formatPosition(place.center)} (${place.status})`}`,
  );
  out(`    settlers     ${view.population.living} of ${view.population.total} alive`);
  out(
    `    structures   ${view.structures.standingTypes.length > 0 ? view.structures.standingTypes.join(', ') : 'none yet'}`,
  );
  out(`    projects     ${view.projects.open} open of ${view.projects.total}`);
  out(`    stores       ${bundleText(view.resources.total)}`);
  out(`    explored     ${view.territory.knownLocations} places across ${view.territory.spanBlocks} blocks`);
  out(`    events       ${view.events.total}`);
  out(`    status       ${view.status ?? 'unknown'}`);
  out();
  for (const agent of view.population.agents) {
    const progress =
      agent.planProgress === null
        ? ''
        : ` [${String(agent.planProgress.done)}/${String(agent.planProgress.total)}]`;
    out(
      `    ${agent.name.padEnd(8)} ${agent.status.padEnd(10)} ${agent.goal?.summary ?? '—'}${progress}`,
    );
  }
  out();
  store.close();
}

function cmdInspect(args: Args): void {
  const store = openStore(resolveConfig(args));
  const wanted = args.positional[0];

  if (wanted !== undefined) {
    const view = agentView(store, wanted, { memories: numberFlag(args, 'limit', 8) });
    if (view === null) {
      out(`  No agent named '${wanted}'.`);
      store.close();
      return;
    }
    printAgent(view, args.flags.verbose === true);
    store.close();
    return;
  }

  const civ = civilizationView(store);
  if (civ.population.agents.length === 0) {
    out('  No agents yet.');
    store.close();
    return;
  }
  for (const summary of civ.population.agents) {
    const view = agentView(store, summary.id, { memories: 3 });
    if (view !== null) printAgent(view, args.flags.verbose === true);
  }
  store.close();
}

function printAgent(view: AgentStateView, verbose: boolean): void {
  out();
  out(`  ${view.identity.name} — ${view.identity.role}`);
  out(
    `    status     ${view.status.status} (${view.status.phase} phase) at ${formatPosition(view.position)}`,
  );
  out(`    activity   ${view.status.activity || '—'}`);
  out(
    `    needs      ${view.needs
      .map((need) => `${need.kind} ${pct(need.value)}${need.critical ? '!' : ''}`)
      .join(', ')}`,
  );
  out(`    carrying   ${bundleText(view.inventory)}`);

  if (view.goal === null) {
    out('    goal       none');
  } else {
    out(`    goal       ${view.goal.summary} — ${view.goal.reason}`);
    if (view.plan !== null) {
      out(`    plan       ${planLine(view.plan)}`);
      for (const step of view.plan.steps) {
        const mark =
          step.status === 'completed'
            ? '✓'
            : step.status === 'failed'
              ? '✖'
              : step.status === 'skipped'
                ? '–'
                : ' ';
        const detail =
          step.failure !== null
            ? ` ← ${step.failure.kind}: ${step.failure.detail}`
            : step.note !== null
              ? ` — ${step.note}`
              : '';
        out(`      ${mark} ${step.action}${detail}`);
      }
    }
  }

  if (view.projectClaims.length > 0) {
    out(
      `    working on ${view.projectClaims.map((claim) => `${claim.kind} as ${claim.role}`).join(', ')}`,
    );
  }

  if (view.relationships.length > 0) {
    out('    knows');
    for (const relationship of view.relationships) {
      out(
        `      ${relationship.other.name ?? relationship.other.id}: ${relationship.summary}` +
          (relationship.lastReason === null ? '' : ` (${relationship.lastReason})`),
      );
    }
  }

  // Past goals are the honest half of the record: what the agent gave up on
  // matters as much as what it finished.
  if (verbose && view.pastGoals.length > 0) {
    out('    behind');
    for (const goal of view.pastGoals) {
      out(`      ${goal.state} · ${goal.summary}${goal.outcome === null ? '' : ` — ${goal.outcome}`}`);
    }
  }

  if (view.memories.length > 0) {
    out('    remembers');
    for (const memory of view.memories) out(`      ${memoryLine(memory)}`);
  }
  out();
}

/** `revision 2, step 3 of 6, active` — a plan's shape without its whole body. */
function planLine(plan: PlanView): string {
  return (
    `revision ${String(plan.revision)}, step ${String(plan.progress.done + 1)} of ` +
    `${String(plan.progress.total)}, ${plan.state}`
  );
}

function memoryLine(memory: MemoryView): string {
  return `[${memory.type}] ${memory.content}  (${formatSource(memory.source)}, importance ${memory.importance.toFixed(2)})`;
}

function cmdWhy(args: Args): void {
  const store = openStore(resolveConfig(args));
  const name = args.positional[0];
  if (name === undefined) {
    out('  Usage: worldloom why <agent>');
    store.close();
    return;
  }

  const chains = causalChains(store, resolveName(store, name) ?? name, numberFlag(args, 'limit', 8));
  if (chains.length === 0) {
    out(`  No recorded decisions for '${name}'.`);
    store.close();
    return;
  }

  out();
  out(`  Why ${chains[0]!.decision.agent.name ?? name} did what they did`);
  for (const chain of chains) printChain(chain, args.flags.verbose === true);
  out();
  store.close();
}

function printChain(chain: CausalChainView, verbose: boolean): void {
  const decision = chain.decision;
  out();
  out(
    `  day ${String(decision.day)} · ${decision.category} · ${decision.model} · answered by ${decision.answeredBy}`,
  );
  out(`    chose        ${decision.chosenAction}`);
  out(`    saw          ${summarise(decision.observation)}`);

  if (chain.retrievedMemories.length > 0) {
    out(`    recalled     ${String(chain.retrievedMemories.length)}`);
    for (const memory of chain.retrievedMemories.slice(0, verbose ? 20 : 3)) {
      out(`      "${memory.content}"`);
    }
  }
  // A cited memory that no longer resolves is not a bug to hide: consolidation
  // is allowed to replace episodes, and the trail should say so out loud.
  if (chain.forgottenMemoryIds.length > 0) {
    out(`    since forgotten ${String(chain.forgottenMemoryIds.length)} of what it cited`);
  }

  if (chain.consequences.length === 0) {
    out('    led to       nothing recorded yet');
    return;
  }
  out(`    led to       (linked ${chain.link})`);
  for (const consequence of chain.consequences) {
    out(`      ${consequence.event.type}  ${summarise(consequence.event.payload)}`);
    for (const memory of consequence.memories.slice(0, verbose ? 5 : 1)) {
      out(`        remembered: "${memory.content}"`);
    }
  }
}

function cmdExplain(args: Args): void {
  const store = openStore(resolveConfig(args));
  const id = args.positional[0];
  if (id === undefined) {
    out('  Usage: worldloom explain <event-id>   (ids come from `worldloom events`)');
    store.close();
    return;
  }

  const view = explainEvent(store, id);
  if (view === null) {
    out(`  No event with id '${id}'.`);
    store.close();
    return;
  }

  out();
  out(`  ${view.event.type} on day ${String(view.event.day)}`);
  out(`    what         ${summarise(view.event.payload)}`);
  out(`    who          ${view.agent?.name ?? 'the world'}`);
  out(`    importance   ${view.event.importance.toFixed(2)} (${bandOf(view.event.importance)})`);
  if (view.goal !== null) out(`    pursuing     ${view.goal.summary} — ${view.goal.reason}`);
  if (view.plan !== null) out(`    plan         ${planLine(view.plan)}`);
  if (view.decision === null) {
    out(`    decision     none (${view.link}) — a deterministic consequence`);
  } else {
    out(`    decision     ${view.decision.chosenAction} (${view.link})`);
    for (const memory of view.retrievedMemories.slice(0, 3)) out(`      cited: "${memory.content}"`);
  }
  if (view.precedingEvents.length > 0) {
    out('    lead-up');
    for (const before of view.precedingEvents) {
      out(`      ${before.type}  ${summarise(before.payload)}`);
    }
  }
  if (view.memories.length > 0) {
    out('    remembered as');
    for (const memory of view.memories) out(`      "${memory.content}"`);
  }
  out();
  store.close();
}

function cmdEvents(args: Args): void {
  const store = openStore(resolveConfig(args));
  const limit = numberFlag(args, 'limit', 25);
  const day = args.flags.day === undefined ? undefined : numberFlag(args, 'day', 0);

  const feed = liveFeedView(store, limit, {
    ...(args.flags.notable === true ? { minImportance: 0.5 } : {}),
  });
  const entries: readonly EventView[] =
    day === undefined ? feed.entries : feed.entries.filter((event) => event.day === day);

  if (entries.length === 0) {
    out(day === undefined ? '  No events yet.' : `  Nothing recorded on day ${String(day)}.`);
    store.close();
    return;
  }

  out();
  for (const event of entries) {
    const who = event.actor?.name === undefined || event.actor.name === null ? '' : `${event.actor.name} `;
    out(`  day ${String(event.day)}  ${who}${event.type}  ${summarise(event.payload)}`);
    if (args.flags.verbose === true) out(`           ${event.id}`);
  }
  out();
  store.close();
}

function cmdFailures(args: Args): void {
  const store = openStore(resolveConfig(args));
  const view = failureView(store, numberFlag(args, 'limit', 50));

  out();
  out('  What has been going wrong');
  out(
    `    actions failed ${String(view.totals.actionFailed)}   goals failed ${String(view.totals.goalFailed)}` +
      `   abandoned ${String(view.totals.goalAbandoned)}   blocked ${String(view.totals.goalBlocked)}`,
  );

  if (view.byKind.length === 0) {
    out('    nothing in the recent window.');
    out();
    store.close();
    return;
  }

  out();
  out(`  By kind (last ${String(view.windowSize)} failures)`);
  for (const group of view.byKind) {
    const who = group.agents
      .map((entry) => `${entry.agent.name ?? entry.agent.id}×${String(entry.count)}`)
      .join(' ');
    out(`    ${group.kind.padEnd(24)} ${String(group.count).padStart(4)}   ${who}`);
    out(`      latest: day ${String(group.latest.day)} ${group.latest.subject} — ${group.latest.detail}`);
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
  const limit = numberFlag(args, 'limit', 20);
  const view = agentView(store, name, {
    memories: limit,
    knownLocations: limit,
    knownResources: limit,
  });
  if (view === null) {
    out(`  No agent named '${name}'.`);
    store.close();
    return;
  }

  out();
  out(
    `  ${view.identity.name} remembers ${String(view.memoryCounts.total)} things ` +
      `(${view.memoryCounts.byType.map((count) => `${count.key} ${String(count.count)}`).join(', ')})`,
  );
  for (const memory of view.memories) out(`    ${memoryLine(memory)}`);

  if (view.knownResources.length > 0) {
    out();
    out(`  ${view.identity.name} knows of`);
    for (const known of view.knownResources) {
      out(
        `    ${known.resource} at ${formatPosition(known.position)} — confidence ${known.confidence.toFixed(2)}, ${formatSource(known.source)}`,
      );
    }
  }

  if (view.knownLocations.length > 0) {
    out();
    out('  and of these places');
    for (const known of view.knownLocations) {
      out(`    ${known.kind} at ${formatPosition(known.position)} — ${known.label || '—'}`);
    }
  }

  if (view.messages.length > 0) {
    out();
    out('  and was told');
    for (const message of view.messages) {
      out(`    day ${String(message.sentAtDay)} ${message.from.name ?? '?'}: "${message.content}"`);
    }
  }
  out();
  store.close();
}

async function cmdChronicle(args: Args): Promise<void> {
  const config = resolveConfig(args);
  const store = openStore(config);

  if (args.flags.generate === true) {
    // Generating is the only inspection command that may cost money, so it is
    // opt-in: reading is free, and writing history is a deliberate act.
    const selection = createReasoningProvider({ config });
    out(`  Writing the chronicle — ${selection.reason}`);
    const day = args.flags.day === undefined ? undefined : numberFlag(args, 'day', 0);
    const generated = await generateChronicle(
      { store, reasoning: selection.provider },
      {
        narrate: config.reasoning.provider !== 'heuristic',
        ...(day === undefined ? {} : { fromDay: day, toDay: day }),
      },
    );
    await selection.provider.close?.();
    if (!generated.ok) {
      process.stderr.write(`  Could not write the chronicle: ${describeFailure(generated.failure)}\n`);
      store.close();
      process.exit(1);
    }
    out(`  ${String(generated.value.length)} entr${generated.value.length === 1 ? 'y' : 'ies'}.`);
  }

  const all = readChronicle(store);
  const day = args.flags.day === undefined ? undefined : numberFlag(args, 'day', 0);
  const entries = day === undefined ? all : all.filter((entry) => entry.day === day);

  if (entries.length === 0) {
    out(
      all.length === 0
        ? '\n  No chronicle yet. Run `worldloom chronicle --generate` to write one from the ledger.\n'
        : `\n  Nothing was recorded for day ${String(day)}.\n`,
    );
    store.close();
    return;
  }

  out();
  out(
    renderChronicleText(entries, {
      showSource: args.flags.verbose === true,
      cite: args.flags.cite === true,
    }),
  );
  out();
  store.close();
}

function cmdCosts(args: Args): void {
  const store = openStore(resolveConfig(args));
  const view = costView(store);

  out();
  if (view.total.calls === 0) {
    out('  No model calls — this run has been entirely rule-based.');
    out(
      `  ${String(view.reliance.decisions)} decisions, all answered by rules over ` +
        `${String(view.efficiency.days)} day(s).`,
    );
    out();
    store.close();
    return;
  }

  out('  Reasoning cost');
  out(`    calls          ${String(view.total.calls)} (${String(view.total.failedCalls)} failed)`);
  out(`    input tokens   ${view.total.inputTokens.toLocaleString()}`);
  out(`    output tokens  ${view.total.outputTokens.toLocaleString()}`);
  out(`    estimated      ${formatCostUsd(view.total.costUsd)}`);

  const efficiency = view.efficiency;
  out();
  out('  Per unit of simulated life');
  out(`    agent-days     ${efficiency.agentDays.toFixed(1)} (${String(efficiency.agents)} agents × ${String(efficiency.days)} days)`);
  out(`    tokens         ${Math.round(efficiency.tokensPerAgentDay).toLocaleString()} per agent-day`);
  out(`    cost           ${formatCostUsd(efficiency.costUsdPerAgentDay)} per agent-day`);
  out(`    next day       ~${formatCostUsd(efficiency.projectedCostUsdPerDay)} at this rate`);

  // The share answered by rules is the number that catches a misconfigured run:
  // a configured model that silently fell back is a run that looks cheap because
  // it stopped thinking.
  const reliance = view.reliance;
  out();
  out('  Who answered');
  out(`    model          ${String(reliance.modelAnswered)}`);
  out(`    rules          ${String(reliance.ruleAnswered)} (${pct(reliance.ruleAnsweredShare)})`);
  if (reliance.modelFallback > 0) {
    out(`    fell back      ${String(reliance.modelFallback)} — asked the model and used a rule instead`);
  }
  if (reliance.undetermined > 0) {
    out(`    undetermined   ${String(reliance.undetermined)} (this world stores no decision text)`);
  }

  out();
  out('  By category');
  for (const category of view.byCategory) {
    out(
      `    ${category.category.padEnd(24)} ${String(category.calls).padStart(4)} calls  ${formatCostUsd(category.costUsd)}`,
    );
  }

  if (view.byModel.length > 1) {
    out();
    out('  By model');
    for (const model of view.byModel) {
      out(`    ${model.model.padEnd(24)} ${String(model.calls).padStart(4)} calls  ${formatCostUsd(model.costUsd)}`);
    }
  }

  if (view.byDay.length > 1) {
    out();
    out('  By day');
    for (const day of view.byDay) {
      out(`    day ${String(day.day).padEnd(20)} ${String(day.calls).padStart(4)} calls  ${formatCostUsd(day.costUsd)}`);
    }
  }

  if (view.byAgent.length > 0) {
    out();
    out('  By agent');
    for (const agent of view.byAgent) {
      out(
        `    ${(agent.agent?.name ?? 'unattributed').padEnd(24)} ${String(agent.calls).padStart(4)} calls  ${formatCostUsd(agent.costUsd)}`,
      );
    }
    if (view.unattributedCalls > 0) {
      out(`    (${String(view.unattributedCalls)} call(s) carry no agent)`);
    }
  }
  out();
  store.close();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A name typed on the command line, resolved to an id. */
function resolveName(store: Store, nameOrId: string): string | null {
  return store.agents.findByName(nameOrId)?.id ?? null;
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
    case 'status':
      cmdStatus(args);
      return;
    case 'inspect':
      cmdInspect(args);
      return;
    case 'why':
      cmdWhy(args);
      return;
    case 'explain':
      cmdExplain(args);
      return;
    case 'events':
      cmdEvents(args);
      return;
    case 'failures':
      cmdFailures(args);
      return;
    case 'memories':
      cmdMemories(args);
      return;
    case 'chronicle':
      await cmdChronicle(args);
      return;
    case 'costs':
      cmdCosts(args);
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
