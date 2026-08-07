/**
 * Structured logging.
 *
 * Deliberately small. Requirement 23 asks for inspectable state, and the answer
 * to that is the database plus the `inspect` commands — not a wall of log lines.
 * This exists for the live narration of a run and for diagnosing startup, and it
 * emits JSON when asked so a run can be piped somewhere.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds the given fields to everything it writes. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly format?: 'pretty' | 'json';
  /** Injectable for tests. */
  readonly write?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const format = options.format ?? 'pretty';
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  return build(level, format, write, {});
}

function build(
  level: LogLevel,
  format: 'pretty' | 'json',
  write: (line: string) => void,
  base: LogFields,
): Logger {
  const emit = (at: LogLevel, message: string, fields?: LogFields): void => {
    if (SEVERITY[at] < SEVERITY[level]) return;
    const merged = { ...base, ...(fields ?? {}) };

    if (format === 'json') {
      write(JSON.stringify({ level: at, message, ...merged }));
      return;
    }

    const suffix =
      Object.keys(merged).length === 0
        ? ''
        : ` ${Object.entries(merged)
            .map(([key, value]) => `${key}=${renderValue(value)}`)
            .join(' ')}`;
    write(`${PREFIX[at]} ${message}${suffix}`);
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => build(level, format, write, { ...base, ...fields }),
  };
}

/** Terse prefixes: a run's narration should read as a story, not as a log. */
const PREFIX: Readonly<Record<LogLevel, string>> = {
  debug: '  ·',
  info: '   ',
  warn: '  !',
  error: '  ✖',
};

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '-';
  return JSON.stringify(value);
}

/** A logger that discards everything. Used by tests that don't assert on output. */
export function silentLogger(): Logger {
  return build('error', 'json', () => {}, {});
}
