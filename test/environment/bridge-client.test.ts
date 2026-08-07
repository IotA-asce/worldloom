/**
 * Bridge client tests against a scripted in-process socket — no Minecraft, no
 * network. These encode the protocol contract and, more importantly, the
 * single-client disconnect behaviour of constraint C3.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BridgeClient,
  SUPPORTED_PROTOCOL,
  type BridgeSocket,
} from '../../src/environment/minecraft/bridge-client.ts';

type Listener = (...args: unknown[]) => void;

interface Frame {
  id: number;
  cmd: string;
  args: Record<string, unknown>;
}

/** A socket that records what was sent and lets a test drive the responses. */
class FakeSocket implements BridgeSocket {
  readonly sent: Frame[] = [];
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    private readonly script: {
      /** Suppress the automatic hello, to test the no-hello path. */
      noHello?: boolean;
      protocol?: number;
      /** Called for each frame; return a response object, or null to stay silent. */
      respond?: (frame: Frame) => Record<string, unknown> | null;
      /** Fail the send callback, simulating a dead socket. */
      failSend?: boolean;
    } = {},
  ) {
    // The plugin sends hello immediately on connect.
    setImmediate(() => {
      if (this.script.noHello === true) return;
      this.emit('open');
      this.receive({
        event: 'hello',
        plugin: 'minecraft-mcp-bridge',
        version: '0.1.0',
        protocol: this.script.protocol ?? SUPPORTED_PROTOCOL,
      });
    });
  }

  send(data: string, callback?: (error?: Error) => void): void {
    if (this.script.failSend === true) {
      callback?.(new Error('socket is dead'));
      return;
    }
    const frame = JSON.parse(data) as Frame;
    this.sent.push(frame);
    callback?.();

    const response = this.script.respond?.(frame);
    if (response !== null && response !== undefined) {
      setImmediate(() => this.receive({ id: frame.id, ...response }));
    }
  }

  close(): void {
    this.closed = true;
    this.emit('close');
  }

  onOpen(listener: () => void): void {
    this.listen('open', listener);
  }

  onClose(listener: () => void): void {
    this.listen('close', listener);
  }

  onMessage(listener: (data: unknown) => void): void {
    this.listen('message', listener as Listener);
  }

  onError(listener: (error: Error) => void): void {
    this.listen('error', listener as Listener);
  }

  private listen(event: string, listener: Listener): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  /** Push a frame from the "plugin" to the client. */
  receive(frame: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(frame));
  }

  /** Simulate the bridge kicking us because a newer client connected (C3). */
  dropConnection(): void {
    this.emit('close');
  }

  emitError(message: string): void {
    this.emit('error', new Error(message));
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

/** Yield until the client has actually written `count` frames. `send` awaits
 *  `connect()` first, so a frame is not on the wire the instant it is called. */
async function awaitFrames(socket: FakeSocket, count: number): Promise<void> {
  for (let i = 0; i < 100 && socket.sent.length < count; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(socket.sent.length >= count, `expected ${count} frames, saw ${socket.sent.length}`);
}

describe('connection handshake', () => {
  it('connects once the hello frame arrives', async () => {
    const client = new BridgeClient({ createSocket: () => new FakeSocket() });
    const result = await client.connect();
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.plugin, 'minecraft-mcp-bridge');
      assert.equal(result.value.protocol, SUPPORTED_PROTOCOL);
    }
    assert.ok(client.isConnected());
    client.close();
  });

  it('reuses an established connection', async () => {
    let built = 0;
    const client = new BridgeClient({
      createSocket: () => {
        built++;
        return new FakeSocket();
      },
    });
    await client.connect();
    await client.connect();
    assert.equal(built, 1);
    client.close();
  });

  it('refuses a protocol version it does not understand', async () => {
    // Silently proceeding could corrupt the world rather than merely error, so
    // this must fail loudly (ADR-0002).
    const client = new BridgeClient({ createSocket: () => new FakeSocket({ protocol: 99 }) });
    const result = await client.connect();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'ENVIRONMENT_DISCONNECTED');
      assert.match(result.failure.detail, /protocol 99.*supports 1/);
    }
    client.close();
  });

  it('fails when the socket opens but no hello arrives', async () => {
    const client = new BridgeClient({
      createSocket: () => new FakeSocket({ noHello: true }),
      defaultTimeoutMs: 60,
    });
    const result = await client.connect();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.failure.detail, /no hello frame/);
    client.close();
  });

  it('reports a socket error as a disconnection with the address', async () => {
    const client = new BridgeClient({
      url: 'ws://127.0.0.1:9999',
      createSocket: () => {
        const socket = new FakeSocket({ noHello: true });
        setImmediate(() => socket.emitError('ECONNREFUSED'));
        return socket;
      },
      defaultTimeoutMs: 200,
    });
    const result = await client.connect();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.failure.detail, /ws:\/\/127\.0\.0\.1:9999/);
      assert.match(result.failure.detail, /ECONNREFUSED/);
    }
    client.close();
  });

  it('fails immediately once closed', async () => {
    const client = new BridgeClient({ createSocket: () => new FakeSocket() });
    await client.connect();
    client.close();
    const result = await client.connect();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.failure.detail, /closed/);
  });

  it('tolerates close() being called twice', async () => {
    const client = new BridgeClient({ createSocket: () => new FakeSocket() });
    await client.connect();
    client.close();
    assert.doesNotThrow(() => client.close());
  });
});

describe('request/response correlation', () => {
  it('returns the result for the matching id', async () => {
    const socket = new FakeSocket({
      respond: (frame) =>
        frame.cmd === 'get_block_at' ? { ok: true, result: { block: 'oak_log' } } : { ok: true, result: {} },
    });
    const client = new BridgeClient({ createSocket: () => socket });

    const result = await client.send('get_block_at', { x: 1, y: 2, z: 3 });
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value, { block: 'oak_log' });

    // The frame went out in the documented shape.
    assert.equal(socket.sent[0]?.cmd, 'get_block_at');
    assert.deepEqual(socket.sent[0]?.args, { x: 1, y: 2, z: 3 });
    assert.equal(typeof socket.sent[0]?.id, 'number');
    client.close();
  });

  it('correlates out-of-order responses to the right caller', async () => {
    const socket = new FakeSocket({ respond: () => null });
    const client = new BridgeClient({ createSocket: () => socket });
    await client.connect();

    const first = client.send('get_block_at', { x: 1, y: 0, z: 0 });
    const second = client.send('get_block_at', { x: 2, y: 0, z: 0 });
    await awaitFrames(socket, 2);

    // Answer the second request first — ids, not arrival order, decide.
    const ids = socket.sent.map((frame) => frame.id);
    socket.receive({ id: ids[1], ok: true, result: { block: 'stone' } });
    socket.receive({ id: ids[0], ok: true, result: { block: 'dirt' } });

    assert.deepEqual((await first as { ok: true; value: unknown }).value, { block: 'dirt' });
    assert.deepEqual((await second as { ok: true; value: unknown }).value, { block: 'stone' });
    client.close();
  });

  it('maps bridge error codes onto failure kinds', async () => {
    const cases: readonly [string, string][] = [
      ['BAD_ARGS', 'BAD_ARGS'],
      ['TIMEOUT', 'TIMEOUT'],
      ['UNSUPPORTED', 'UNSUPPORTED'],
      // In logical embodiment, needing a player means the action is unavailable.
      ['PLAYER_NOT_FOUND', 'UNSUPPORTED'],
      ['NO_PLAYER_ONLINE', 'UNSUPPORTED'],
      ['INTERNAL', 'INTERNAL'],
      ['SOMETHING_NEW', 'INTERNAL'],
    ];

    for (const [code, expected] of cases) {
      const client = new BridgeClient({
        createSocket: () =>
          new FakeSocket({ respond: () => ({ ok: false, error: { code, message: 'nope' } }) }),
      });
      const result = await client.send('get_inventory', {});
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.failure.kind, expected, `${code} should map to ${expected}`);
        assert.match(result.failure.detail, /get_inventory: nope/);
      }
      client.close();
    }
  });

  it('times out a command that is never answered', async () => {
    const client = new BridgeClient({
      createSocket: () => new FakeSocket({ respond: () => null }),
      defaultTimeoutMs: 60,
    });
    const result = await client.send('summon_entity', { type: 'armor_stand' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'TIMEOUT');
      assert.match(result.failure.detail, /did not answer within 60ms/);
    }
    client.close();
  });

  it('ignores malformed and unknown frames without breaking', async () => {
    const socket = new FakeSocket({ respond: () => null });
    const client = new BridgeClient({ createSocket: () => socket });
    await client.connect();

    socket.receive({ id: 9999, ok: true, result: {} }); // unknown id
    assert.doesNotThrow(() => socket.receive({ nonsense: true }));

    const pending = client.send('get_time_weather', {});
    await awaitFrames(socket, 1);
    socket.receive({ id: socket.sent[0]!.id, ok: true, result: { time_ticks: 6000 } });
    assert.equal((await pending).ok, true);
    client.close();
  });

  it('surfaces a failed send as a disconnection', async () => {
    const client = new BridgeClient({
      createSocket: () => new FakeSocket({ failSend: true }),
    });
    const result = await client.send('give_item', { item: 'stone' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.kind, 'ENVIRONMENT_DISCONNECTED');
    client.close();
  });
});

describe('single-client disconnects (constraint C3)', () => {
  it('fails in-flight requests when the bridge drops us', async () => {
    const socket = new FakeSocket({ respond: () => null });
    const client = new BridgeClient({
      createSocket: () => socket,
      defaultTimeoutMs: 5_000,
      maxRetries: 1,
    });
    await client.connect();

    const pending = client.send('break_block', { x: 0, y: 64, z: 0 });
    // Wait until the command is genuinely in flight — otherwise we would be
    // testing "socket already gone before send", a different case.
    await awaitFrames(socket, 1);
    socket.dropConnection();

    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.kind, 'ENVIRONMENT_DISCONNECTED');
      // The message should point at the actual cause, which is easy to
      // misdiagnose as a crash.
      assert.match(result.failure.detail, /newer connection/);
    }
    client.close();
  });

  it('retries an idempotent command through a reconnect', async () => {
    let attempt = 0;
    const client = new BridgeClient({
      maxRetries: 3,
      createSocket: () =>
        new FakeSocket({
          respond: (frame) => {
            attempt++;
            // Drop the first attempt, answer the second.
            if (attempt === 1) return null;
            return { ok: true, result: { block: 'stone', echoed: frame.cmd } };
          },
        }),
      defaultTimeoutMs: 40,
    });

    const result = await client.send('get_block_at', { x: 0, y: 0, z: 0 });
    assert.equal(result.ok, true, 'a query should survive one dropped attempt');
    assert.equal(attempt, 2);
    client.close();
  });

  it('does NOT retry a destructive command', async () => {
    // Re-sending break_block after a reconnect could destroy a second block.
    let attempts = 0;
    const client = new BridgeClient({
      maxRetries: 3,
      createSocket: () =>
        new FakeSocket({
          respond: () => {
            attempts++;
            return null;
          },
        }),
      defaultTimeoutMs: 40,
    });

    const result = await client.send('break_block', { x: 0, y: 64, z: 0 });
    assert.equal(result.ok, false);
    assert.equal(attempts, 1, 'break_block must be attempted exactly once');
    client.close();
  });

  it('judges run_command per command string', async () => {
    // `fill` sets a volume — idempotent. `summon` creates — not.
    const attemptsFor = async (command: string): Promise<number> => {
      let attempts = 0;
      const client = new BridgeClient({
        maxRetries: 2,
        createSocket: () =>
          new FakeSocket({
            respond: () => {
              attempts++;
              return null;
            },
          }),
        defaultTimeoutMs: 30,
      });
      await client.send('run_command', { command });
      client.close();
      return attempts;
    };

    assert.equal(await attemptsFor('fill 0 64 0 4 64 4 air'), 2, 'fill is retryable');
    assert.equal(await attemptsFor('forceload add 0 0 16 16'), 2, 'forceload is retryable');
    assert.equal(await attemptsFor('summon zombie 0 64 0'), 1, 'summon is not retryable');
    assert.equal(await attemptsFor('give Steve diamond 64'), 1, 'give is not retryable');
  });
});

describe('event frames', () => {
  it('dispatches plugin events to subscribers', async () => {
    const socket = new FakeSocket({ respond: () => null });
    const client = new BridgeClient({ createSocket: () => socket });
    await client.connect();

    const seen: Record<string, unknown>[] = [];
    const unsubscribe = client.on('player_chat', (payload) => seen.push(payload));

    socket.receive({ event: 'player_chat', player: 'Steve', message: 'hello' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.message, 'hello');

    unsubscribe();
    socket.receive({ event: 'player_chat', player: 'Steve', message: 'ignored' });
    assert.equal(seen.length, 1, 'unsubscribing should stop delivery');
    client.close();
  });

  it('survives a throwing listener', async () => {
    const socket = new FakeSocket({ respond: () => null });
    const client = new BridgeClient({ createSocket: () => socket });
    await client.connect();

    client.on('player_death', () => {
      throw new Error('listener bug');
    });
    let reached = false;
    client.on('player_death', () => {
      reached = true;
    });

    assert.doesNotThrow(() => socket.receive({ event: 'player_death', player: 'Steve', cause: 'fall' }));
    assert.ok(reached, 'one bad listener must not starve the others');
    client.close();
  });
});
