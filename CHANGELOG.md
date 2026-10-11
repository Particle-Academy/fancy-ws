# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

**This package is pre-1.0, so breaking changes land in MINOR releases.** The
version number is not a stability promise until 1.0; read the entry.

## [Unreleased]

## [0.1.0] - 2026-10-11

First release.

### Added

- **`attachWebSocketServer(server, options)`** — an RFC 6455 WebSocket server
  over an existing `http.Server` (or `https.Server`), with **zero runtime
  dependencies**: `node:http`, `node:net`, `node:crypto` and `node:events`
  only. Node 22 ships a WebSocket *client* and no server; this is the other
  half.

- **`verify` runs before the 101**, so a refused handshake is a plain HTTP
  401/403/404 rather than an accept-then-close. It may return `true`, an object
  (handed to the `connection` listener as the authorised identity), `false`
  (403), or any HTTP status code. A throw is a 500 reported on the server's
  `error` event.

- **A connection surface matching the browser's where it can**: `send`,
  `close(code, reason)`, `terminate`, `ping`, `pong`, `readyState`,
  `remoteAddress`, `protocol`, `request`, and `message` / `close` / `error` /
  `ping` / `pong` events. `message` delivers a **string** for text and a
  **Buffer** for binary, reassembled across fragments.

- **`heartbeat(intervalMs, { misses })`** — pings every client and drops the
  ones that stop answering. A socket to a machine that slept or lost its
  network stays `OPEN` indefinitely; the pong is the only evidence the peer is
  still there. The timer is `unref`'d, so it cannot keep a process alive.

- **Subprotocol negotiation** that never echoes a protocol the client did not
  offer (RFC 6455 4.2.2 — a client seeing an unoffered value must fail the
  connection, so echoing eagerly breaks the handshake it was meant to
  complete).

- **The frame codec and handshake rules are exported** (`encodeFrame`,
  `decodeFrame`, `acceptKey`, `inspectHandshake`, `negotiateProtocol`,
  `isValidCloseCode`, `decodeUtf8`) for a consumer that owns its own socket.

### Security

- **Hostile input cannot crash the host.** `EventEmitter` throws when `'error'`
  is emitted with no listener, so a naive implementation hands any peer a
  one-frame process kill. Every error path checks for a listener first, and a
  test drives a protocol violation through a connection with no error listener
  attached and then asserts the server is still serving.

- **`maxPayload` is enforced per frame *and* per reassembled message**, and the
  per-frame check reads the declared length from the 10-byte header *before*
  any body is buffered. Either half alone is not a limit: without the
  per-message check a peer sends under-limit fragments forever and the
  reassembly buffer grows without bound; without the header-first check a frame
  claiming a terabyte costs a terabyte of buffering to refuse.

- **The socket stays paused until the handshake is authorised.** An earlier
  draft collected post-request bytes into an array while `verify` ran, which is
  an unbounded buffer held for an unauthenticated peer. Paused, the socket
  fills to its high-water mark and then stops reading, which is the
  backpressure that peer should get.

- **Strict protocol enforcement** rather than tolerance, each with the close
  code RFC 6455 specifies: unmasked client frames, set RSV bits, reserved
  opcodes, fragmented or oversized control frames and non-minimal length
  encodings are **1002**; invalid UTF-8 in a text payload or close reason is
  **1007**; oversize is **1009**. Close codes that must never appear on the
  wire (1004, 1005, 1006, 1015, and the reserved 1016–2999) are refused in both
  directions.

- **No `permessage-deflate`.** RSV1 is refused rather than ignored, so a client
  offering an extension we did not negotiate gets a clean protocol failure
  instead of a deflated payload delivered as if it were the message.

[Unreleased]: https://github.com/Particle-Academy/fancy-ws/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Particle-Academy/fancy-ws/releases/tag/v0.1.0
