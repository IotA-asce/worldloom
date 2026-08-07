/**
 * Thin port over SQLite (ADR-0010).
 *
 * The port exists so that `node:sqlite` — currently flagged experimental — can
 * be swapped for `better-sqlite3` by editing this one file. Its shape
 * deliberately mirrors better-sqlite3's API to make that swap mechanical.
 *
 * Repositories depend on `Database`, never on `node:sqlite` directly.
 */

import { DatabaseSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParams = readonly SqlValue[];
export type Row = Record<string, SqlValue>;

export interface Statement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
}

export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  /**
   * Run `body` in a transaction, committing on return and rolling back on
   * throw. Nested calls use savepoints, so a repository method that opens a
   * transaction stays composable inside a larger one.
   */
  transaction<T>(body: () => T): T;
  close(): void;
}

export interface OpenOptions {
  /** Path, or ':memory:' for a throwaway database. */
  readonly path: string;
  /** Set false only for read-only inspection commands. */
  readonly readWrite?: boolean;
}

export function openDatabase(options: OpenOptions | string): Database {
  const opts: OpenOptions = typeof options === 'string' ? { path: options } : options;
  const handle = new DatabaseSync(opts.path, {
    open: true,
    readOnly: opts.readWrite === false,
  });

  // WAL keeps readers (the inspect CLI) from blocking the running simulation.
  // A :memory: database has no journal file, so WAL is meaningless there.
  if (opts.path !== ':memory:' && opts.readWrite !== false) {
    handle.exec('PRAGMA journal_mode = WAL');
  }
  handle.exec('PRAGMA foreign_keys = ON');
  // Wait rather than fail when the inspect CLI and the simulation overlap.
  handle.exec('PRAGMA busy_timeout = 5000');

  let depth = 0;

  const db: Database = {
    exec(sql: string): void {
      handle.exec(sql);
    },

    prepare(sql: string): Statement {
      const statement = handle.prepare(sql);
      return {
        run: (...params) => statement.run(...params),
        get: (...params) => statement.get(...params) as Row | undefined,
        all: (...params) => statement.all(...params) as Row[],
      };
    },

    transaction<T>(body: () => T): T {
      const nested = depth > 0;
      const savepoint = `wl_sp_${depth}`;
      handle.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
      depth += 1;
      try {
        const result = body();
        depth -= 1;
        handle.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
        return result;
      } catch (error) {
        depth -= 1;
        // Rolling back must not mask the original error, so swallow any
        // failure here — the caller needs to see why the body threw.
        try {
          handle.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
        } catch {
          /* ignore */
        }
        throw error;
      }
    },

    close(): void {
      handle.close();
    },
  };

  return db;
}

// ── Row helpers ─────────────────────────────────────────────────────────────
//
// SQLite is untyped enough that reading a column always involves an assertion.
// Doing it through these helpers means a schema/code mismatch fails loudly at
// the read rather than propagating a NaN or an "undefined" string into the
// simulation.

export function requireRow(row: Row | undefined, what: string): Row {
  if (row === undefined) throw new Error(`expected a row for ${what}`);
  return row;
}

export function textCol(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`column '${column}' expected text, got ${describeValue(value)}`);
  }
  return value;
}

export function numberCol(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`column '${column}' expected a number, got ${describeValue(value)}`);
}

export function boolCol(row: Row, column: string): boolean {
  return numberCol(row, column) !== 0;
}

export function nullableTextCol(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`column '${column}' expected text or null, got ${describeValue(value)}`);
  }
  return value;
}

export function nullableNumberCol(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return numberCol(row, column);
}

/** Parse a JSON column, with the column name in the error on failure. */
export function jsonCol<T>(row: Row, column: string): T {
  const text = textCol(row, column);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`column '${column}' is not valid JSON: ${String(error)}`);
  }
}

export function nullableJsonCol<T>(row: Row, column: string): T | null {
  const text = nullableTextCol(row, column);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`column '${column}' is not valid JSON: ${String(error)}`);
  }
}

/** Booleans have no SQLite type; store them as 0/1 explicitly. */
export function toSqlBool(value: boolean): number {
  return value ? 1 : 0;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined (no such column?)';
  return `${typeof value} (${String(value)})`;
}
