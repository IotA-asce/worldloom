/**
 * Client for the `minecraft-mcp` Paper plugin's WebSocket bridge.
 *
 * Implements the wire protocol specified in `minecraft-mcp/docs/bridge-protocol.md`
 * (ADR-0002): single JSON frames, `{id, cmd, args}` requests correlated to
 * `{id, ok, result|error}` responses, plus unsolicited event frames.
 *
 * Two properties of that bridge shape the design (constraint C3):
 *
 *  - It accepts exactly one client, and a newer connection kicks the older.
 *    Disconnection is therefore expected, not exceptional.
 *  - Because of that, retry-on-disconnect is only safe for *idempotent*
 *    commands. Re-sending `break_block` after a reconnect could destroy a
 *    second block; re-sending `fill` cannot. Only the former set is retried.
 */

import WebSocket from 'ws';
import { fail, ok, type ActionFailure, type FailureKind, type Result } from '../../core/result.ts';

export const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8765';
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
/** The plugin answers `move_to` only when the walk finishes. */
export const MOVE_TIMEOUT_MS = 30_000;
/** Protocol version this client understands, from the `hello` frame. */
export const SUPPORTED_PROTOCOL = 1;

const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000];

/**
 * Commands that can be re-sent safely after a dropped connection: pure queries,
 * plus console operations that are declaratively idempotent (`fill` sets a
 * volume to a material; `forceload add` is a set-membership operation).
 *
 * `run_command` is judged per command string, since `fill` is idempotent but
 * `summon` is not.
 */
const IDEMPOTENT_COMMANDS: ReadonlySet<string> = new Set([
  'get_block_at',
  'get_heightmap',
  'get_time_weather',
  'get_player_state',
  'get_inventory',
  'get_nearby_entities',
  'look_at',
  'place_block',
  'set_time',
  'set_weather',
  'teleport',
  'set_gamemode',
  'stop',
]);

/** Console commands whose effect is a set-or-declare, so re-sending is safe. */
const IDEMPOTENT_CONSOLE = /^\s*(fill|setblock|forceload|time set|weather|gamerule|tp|teleport|kill @e\[)/i;

export interface BridgeHello {
  readonly plugin: string;
  readonly version: string;
  readonly protocol: number;
}

export type BridgeEventHandler = (payload: Record<string, unknown>) => void;

interface Pending {
  readonly cmd: string;
  readonly resolve: (value: Result<unknown>) => void;
  readonly timer: NodeJS.Timeout;
}

export interface BridgeClientOptions {
  readonly url?: string;
  readonly defaultTimeoutMs?: number;
  /** Attempts for idempotent commands interrupted by a disconnect. */
  readonly maxRetries?: number;
  /** Injectable for tests: build a socket-like object instead of a real ws. */
  readonly createSocket?: (url: string) => BridgeSocket;
}

/**
 * The slice of a WebSocket this client needs.
 *
 * Explicit handlers rather than an overloaded `on`, so the interface is trivial
 * to implement in tests without fighting emitter typings.
 */
export interface BridgeSocket {
  send(data: string, callback?: (error?: Error) => void): void;
  close(): void;
  onOpen(listener: () => void): void;
  onClose(listener: () => void): void;
  onMessage(listener: (data: unknown) => void): void;
  onError(listener: (error: Error) => void): void;
}

/** Wrap a real `ws` socket in the port above. */
export function wsSocket(url: string): BridgeSocket {
  const socket = new WebSocket(url);
  return {
    send: (data, callback) => socket.send(data, callback),
    close: () => socket.close(),
    onOpen: (listener) => socket.on('open', listener),
    onClose: (listener) => socket.on('close', listener),
    onMessage: (listener) => socket.on('message', (data) => listener(data)),
    onError: (listener) => socket.on('error', listener),
  };
}

function disconnected(detail: string): ActionFailure {
  return { kind: 'ENVIRONMENT_DISCONNECTED', detail };
}

/**
 * Failures caused by the transport rather than by the request. A dropped socket
 * (constraint C3) and an unanswered command are both worth one more try for a
 * command that is safe to repeat; everything else is deterministic and would
 * fail identically.
 */
function isTransient(kind: FailureKind): boolean {
  return kind === 'ENVIRONMENT_DISCONNECTED' || kind === 'TIMEOUT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class BridgeClient {
  readonly url: string;

  private socket: BridgeSocket | null = null;
  private connecting: Promise<Result<BridgeHello>> | null = null;
  private hello: BridgeHello | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<BridgeEventHandler>>();
  private reconnectAttempt = 0;
  private closed = false;
  private readonly defaultTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly createSocket: (url: string) => BridgeSocket;

  constructor(options: BridgeClientOptions = {}) {
    this.url = options.url ?? process.env.WORLDLOOM_BRIDGE_URL ?? DEFAULT_BRIDGE_URL;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? 3;
    this.createSocket = options.createSocket ?? wsSocket;
  }

  /** Connect and wait for the plugin's `hello`, verifying protocol version. */
  async connect(): Promise<Result<BridgeHello>> {
    if (this.closed) {
      return fail('ENVIRONMENT_DISCONNECTED', 'bridge client is closed');
    }
    if (this.hello !== null && this.socket !== null) {
      return ok(this.hello);
    }
    if (this.connecting !== null) {
      return this.connecting;
    }

    this.connecting = this.openSocket().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * Send a command and await its correlated response.
   *
   * Idempotent commands are retried through a reconnect; everything else
   * surfaces the failure so the planner can decide (ADR-0008).
   */
  async send(
    cmd: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<Result<unknown>> {
    const attempts = this.isIdempotent(cmd, args) ? this.maxRetries : 1;
    let last: Result<unknown> = fail('INTERNAL', 'no attempt was made');

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const connected = await this.connect();
      if (!connected.ok) {
        last = connected;
        if (attempt < attempts) {
          await this.pause(attempt);
          continue;
        }
        return last;
      }

      last = await this.sendOnce(cmd, args, timeoutMs);
      if (last.ok) return last;

      // Only transport failures are worth another attempt. A BAD_ARGS or a
      // PLAYER_NOT_FOUND will fail identically forever, and we only reach this
      // loop at all for commands that are safe to repeat.
      if (!isTransient(last.failure.kind) || attempt === attempts) return last;
      await this.pause(attempt);
    }

    return last;
  }

  /** Subscribe to plugin events (`player_chat`, `player_death`, ...). */
  on(event: string, handler: BridgeEventHandler): () => void {
    const handlers = this.listeners.get(event) ?? new Set<BridgeEventHandler>();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return () => {
      handlers.delete(handler);
    };
  }

  isConnected(): boolean {
    return this.socket !== null && this.hello !== null;
  }

  /** Permanently shut down. Safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(disconnected('bridge client closed'));
    this.socket?.close();
    this.socket = null;
    this.hello = null;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private openSocket(): Promise<Result<BridgeHello>> {
    return new Promise<Result<BridgeHello>>((resolve) => {
      let settled = false;
      const finish = (result: Result<BridgeHello>): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let socket: BridgeSocket;
      try {
        socket = this.createSocket(this.url);
      } catch (error) {
        finish(
          fail(
            'ENVIRONMENT_DISCONNECTED',
            `cannot construct a socket for ${this.url}: ${String(error)}`,
          ),
        );
        return;
      }

      this.socket = socket;

      // The plugin sends `hello` immediately on connect, so connection is only
      // "ready" once we have it — that is also where the version check happens.
      const helloTimer = setTimeout(() => {
        finish(
          fail(
            'ENVIRONMENT_DISCONNECTED',
            `bridge at ${this.url} accepted the connection but sent no hello frame`,
          ),
        );
      }, this.defaultTimeoutMs);

      const onHello = this.on('hello', (payload) => {
        clearTimeout(helloTimer);
        onHello();
        const hello: BridgeHello = {
          plugin: typeof payload.plugin === 'string' ? payload.plugin : 'unknown',
          version: typeof payload.version === 'string' ? payload.version : '0',
          protocol: typeof payload.protocol === 'number' ? payload.protocol : 0,
        };
        if (hello.protocol !== SUPPORTED_PROTOCOL) {
          // Fail loudly: a protocol change means our frames may be misread,
          // which would corrupt the world rather than merely error.
          finish(
            fail(
              'ENVIRONMENT_DISCONNECTED',
              `bridge speaks protocol ${hello.protocol}, this build supports ` +
                `${SUPPORTED_PROTOCOL}. Update Worldloom or minecraft-mcp.`,
            ),
          );
          return;
        }
        this.hello = hello;
        this.reconnectAttempt = 0;
        finish(ok(hello));
      });

      socket.onMessage((data: unknown) => {
        this.handleFrame(String(data));
      });

      socket.onError((error: Error) => {
        clearTimeout(helloTimer);
        finish(
          fail('ENVIRONMENT_DISCONNECTED', `cannot reach the Minecraft bridge at ${this.url}: ${error.message}`),
        );
      });

      socket.onClose(() => {
        clearTimeout(helloTimer);
        if (this.socket === socket) {
          this.socket = null;
          this.hello = null;
        }
        // Every in-flight request is lost with the socket. Fail them as
        // transport errors so `send` can decide about retrying.
        this.failAllPending(
          disconnected(
            'bridge connection lost (the bridge accepts one client; a newer ' +
              'connection may have replaced ours)',
          ),
        );
        finish(fail('ENVIRONMENT_DISCONNECTED', `bridge at ${this.url} closed the connection`));
      });

      socket.onOpen(() => {
        // Nothing to do — readiness is signalled by `hello`.
      });
    });
  }

  private sendOnce(
    cmd: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Result<unknown>> {
    const socket = this.socket;
    if (socket === null) {
      return Promise.resolve(fail('ENVIRONMENT_DISCONNECTED', 'socket closed before send'));
    }

    const deadline = timeoutMs ?? (cmd === 'move_to' ? MOVE_TIMEOUT_MS : this.defaultTimeoutMs);
    const id = this.nextId++;

    return new Promise<Result<unknown>>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(fail('TIMEOUT', `${cmd} did not answer within ${deadline}ms`, { retryable: true }));
      }, deadline);

      this.pending.set(id, { cmd, resolve, timer });

      socket.send(JSON.stringify({ id, cmd, args }), (error) => {
        if (error === undefined || error === null) return;
        const entry = this.pending.get(id);
        if (entry === undefined) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        resolve(fail('ENVIRONMENT_DISCONNECTED', `send failed: ${error.message}`));
      });
    });
  }

  private handleFrame(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return; // Not JSON — the protocol says ignore.
    }
    if (!isRecord(frame)) return;

    if (typeof frame.event === 'string') {
      this.dispatch(frame.event, frame);
      return;
    }

    if (typeof frame.id !== 'number') return;
    const entry = this.pending.get(frame.id);
    if (entry === undefined) return; // Stale or unknown id.

    this.pending.delete(frame.id);
    clearTimeout(entry.timer);

    if (frame.ok === false) {
      const error = isRecord(frame.error) ? frame.error : {};
      const code = typeof error.code === 'string' ? error.code : 'INTERNAL';
      const message = typeof error.message === 'string' ? error.message : 'unknown bridge error';
      entry.resolve(fail(mapErrorCode(code), `${entry.cmd}: ${message}`, { observed: { code } }));
      return;
    }

    entry.resolve(ok(frame.result));
  }

  private dispatch(event: string, payload: Record<string, unknown>): void {
    for (const handler of this.listeners.get(event) ?? []) {
      try {
        handler(payload);
      } catch {
        // A listener must never be able to break the bridge.
      }
    }
  }

  private failAllPending(failure: ActionFailure): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, failure });
    }
    this.pending.clear();
  }

  private isIdempotent(cmd: string, args: Record<string, unknown>): boolean {
    if (cmd === 'run_command') {
      const command = typeof args.command === 'string' ? args.command : '';
      return IDEMPOTENT_CONSOLE.test(command);
    }
    return IDEMPOTENT_COMMANDS.has(cmd);
  }

  private async pause(attempt: number): Promise<void> {
    const index = Math.min(attempt - 1, RECONNECT_DELAYS_MS.length - 1);
    const delay = RECONNECT_DELAYS_MS[index] ?? 5_000;
    this.reconnectAttempt = attempt;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  /** Exposed for diagnostics: how many reconnects this run has needed. */
  reconnectCount(): number {
    return this.reconnectAttempt;
  }
}

/** Map the bridge's error codes onto Worldloom failure kinds. */
function mapErrorCode(code: string): FailureKind {
  switch (code) {
    case 'PLAYER_NOT_FOUND':
    case 'NO_PLAYER_ONLINE':
      // In logical embodiment this means an action needing a body was attempted.
      return 'UNSUPPORTED';
    case 'BAD_ARGS':
      return 'BAD_ARGS';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'UNSUPPORTED':
      return 'UNSUPPORTED';
    default:
      return 'INTERNAL';
  }
}
