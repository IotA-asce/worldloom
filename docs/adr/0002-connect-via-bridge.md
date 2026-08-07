# ADR-0002 — Connect to the WebSocket bridge, not MCP stdio

**Status:** accepted · **Date:** 2026-08-07

## Context

`minecraft-mcp` has two consumable interfaces: the MCP server over stdio
(designed for LLM harnesses) and the WebSocket bridge protocol the MCP server
itself speaks to the Paper plugin. Worldloom must pick one.

## Decision

Worldloom connects **directly to the Paper plugin's WebSocket bridge**
(`ws://127.0.0.1:8765`, override `WORLDLOOM_BRIDGE_URL`), implementing the frame
format specified in `minecraft-mcp/docs/bridge-protocol.md`.

We do not spawn `minecraft-mcp`'s MCP server.

## Rationale

- MCP tool results are text content blocks intended for a model to read.
  Worldloom wants typed values; round-tripping through MCP means
  serialise → JSON-RPC → subprocess pipe → parse text back into objects, for
  no benefit to a program.
- The bridge protocol is explicitly documented as a stable contract both sides
  "MUST implement exactly". Targeting a specified wire protocol is *less*
  coupling than targeting an unpublished package's build output.
- The dependency that actually matters — the Paper plugin, where all world
  authority lives — is reused unchanged either way.
- The bridge admits only one client (see C3 in
  [minecraft-integration.md](../minecraft-integration.md)). Adding the MCP
  server would put a third process in that contest for no gain.

## Alternatives rejected

- **MCP stdio client** — an extra process and a text-serialisation hop; buys
  Zod schemas we'd re-declare anyway.
- **Import `MinecraftBridge` from the package** — `minecraft-mcp`'s
  `package.json` declares only a `bin`, no `main`/`exports`. Importing it means
  depending on internal file paths inside its `dist/`, which breaks on any
  refactor. Reimplementing ~200 lines of documented wire format is the looser
  coupling.
- **Fork the plugin** — V0 needs no plugin changes. Revisit if we upstream a
  bulk block query.

## Consequences

- Worldloom owns a small `bridge-client.ts`: framing, id correlation, per-command
  deadlines, reconnect with backoff, idempotent-only retry.
- If the bridge protocol version bumps, Worldloom must follow. Mitigated by
  asserting on the `hello` frame's `protocol` field at startup and failing loudly
  on a mismatch.
- Worldloom and an MCP harness cannot share one Paper server. Documented as an
  operational rule.
