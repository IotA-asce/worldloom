/**
 * Environment selection.
 *
 * The one place that decides which adapter a run uses. Everything else depends
 * on the `Environment` interface, so this file is the only thing that has to
 * change when a new environment is added — and the only file outside
 * `environment/` allowed to name one.
 */

import type { WorldloomConfig } from '../core/config.ts';
import { FakeEnvironment } from './fake/environment.ts';
import { MinecraftEnvironment } from './minecraft/adapter.ts';
import { BridgeClient } from './minecraft/bridge-client.ts';
import type { Environment } from './port.ts';

/**
 * World ticks the fake environment advances per observation.
 *
 * Chosen so a settler acts several times per Minecraft hour — fast enough that a
 * demo reaches nightfall in minutes, slow enough that agents can finish a job
 * between meals.
 */
const FAKE_TICKS_PER_OBSERVATION = 40;

export interface EnvironmentHandle {
  readonly environment: Environment;
  /** Close underlying transports. Safe to call more than once. */
  close(): Promise<void>;
}

export function createEnvironment(config: WorldloomConfig): EnvironmentHandle {
  if (config.environment.type === 'fake') {
    const environment = new FakeEnvironment({
      seed: config.simulation.seed,
      // The fake world has no clock of its own, so one has to be provided:
      // without it world time never advances, needs never decay, and a
      // day-bounded run never finishes.
      ticksPerQuery: FAKE_TICKS_PER_OBSERVATION,
    });
    return {
      environment,
      close: () => environment.disconnect(),
    };
  }

  const settings = config.environment.minecraft;
  const bridge = new BridgeClient({
    url: settings.bridge_url,
    defaultTimeoutMs: settings.command_timeout_ms,
  });
  const environment = new MinecraftEnvironment({
    bridge,
    world: settings.world,
    embodiment: settings.embodiment,
    visibleMarkers: settings.visible_markers,
  });

  return {
    environment,
    close: async () => {
      await environment.disconnect();
    },
  };
}

export type { Environment, EnvironmentInfo, Observation } from './port.ts';
export { FakeEnvironment } from './fake/environment.ts';
