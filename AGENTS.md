# Using @particle-academy/fancy-ws — guide for agents

How an agent installs and uses this package in a consumer app. What the package
is, is in [README.md](./README.md). Notes for working ON this repo's code are in
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Install

```bash
npm install @particle-academy/fancy-ws
```

- **Node:** `>=22`. Zero runtime dependencies.
- It is a WebSocket **server** only. For a client, use Node's built-in
  `WebSocket` global.

## Find it on the Fancy MCP server

The catalog server is `https://ui.particle.academy/mcp` (streamable HTTP, no API
key; MCP id `fancy-ui`). The package is the registry entry `fancy-ws`; find it
with `search-backend-packages` (stack `node`), then `install-instructions`.

## API essentials

- `attachWebSocketServer(httpServer, { path, verify, protocols, maxPayload,
  maxFragments, closeTimeoutMs, onPathMismatch })` returns a server; it shares
  the HTTP server, so plain routes on the same port keep working.
- `ws.on('connection', (socket, request, verified) => ...)`.
- `verify(req)` runs BEFORE the 101: return `true` or an object (becomes
  `verified`) to accept, `false` for 403, a number for that status; a throw is
  a 500.
- Socket: `send(text | Uint8Array)`, `close(code, reason)`, `terminate()`,
  `ping()`, `readyState`, `bufferedAmount`, `protocol`, `request`. Events:
  `message (data, isBinary)`, `close (code, reason)` exactly once, `error`,
  `ping`, `pong`.
- `ws.heartbeat(ms)` pings and drops a peer after 2 missed pongs; it returns a
  stop function.

## Traps

- **Authorise in `verify`, not after `connection`.** Accept-then-close hands an
  unauthenticated peer a live frame parser.
- **`send()` returns `false` when the socket is not open**; it never throws.
  Check the return value.
- **`message` data is a string for text and a Buffer for binary.** `JSON.parse`
  needs no decode step for text.
- **`onPathMismatch` defaults to `'ignore'`.** With no other `upgrade`
  listener, an unmatched upgrade hangs until the client times out. Use
  `'reject'` (404) when this is the only WebSocket endpoint on the server.
- **Node 22's client gets `error` and no `close` on a refused handshake**, with
  `readyState` stuck at `CONNECTING`. Listen for `error`.
- **Slow peers are your policy.** `bufferedAmount` is exposed, not acted on.
- Without a heartbeat a dead peer can stay `OPEN` indefinitely.
- No `permessage-deflate`: a client offering it gets a clean failure.
