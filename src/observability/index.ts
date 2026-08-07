/**
 * The observability surface.
 *
 * One import for everything a CLI, a TUI or a local web UI needs: view models
 * over the database (`views`), cost and token accounting (`metrics`), causal
 * tracing (`causality`), and the run's logger. Nothing here formats, so the same
 * objects serve a terminal today and a dashboard later (requirement 24).
 */

export * from './views.ts';
export * from './metrics.ts';
export * from './causality.ts';
export * from './logger.ts';
