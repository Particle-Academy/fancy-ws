# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

**This package is pre-1.0, so breaking changes land in MINOR releases.** The
version number is not a stability promise until 1.0; read the entry.

## [Unreleased]

### Changed

- **Docs:** `AGENTS.md` is now the guide to using this package (install, its entries on the Fancy MCP catalog server, API essentials, traps) and ships in the package. The contributor notes moved to `CONTRIBUTING.md`, and `CLAUDE.md` is now a symlink to it. The README points to the MCP server and to `AGENTS.md`. No code changed; nothing to do.

## [0.2.0] - 2026-11-15

Hardening, found by an RFC 6455 review before fancy-sockets moved onto this
package. **Two changes can refuse something 0.1 accepted; for real clients,
do nothing**: browsers, Node's `WebSocket`, pusher-js and every standard client
send canonical keys and rarely fragment.

### Added

- **`connection.bufferedAmount`**, the bytes queued for a peer and not yet
  handed to the OS, as the browser `WebSocket.bufferedAmount`. Read it to cut off
  a slow or stalled peer before it holds unbounded memory; the threshold is
  yours.
- **`maxFragments`** server option (default 1024).

### Changed

- **BREAKING: a message split into more than 1024 frames closes 1009.** Before,
  a peer could send empty continuation frames forever: six bytes on the wire
  each, a Buffer each in the reassembly list, and the byte limit never moved.
  If you really expect more, raise `maxFragments`.
- **BREAKING: `Sec-WebSocket-Key` must be exactly 16 bytes of standard base64**
  (22 characters and `==`), or the handshake answers 400. Before, it was checked
  by decoding, and Node's base64 decoder skips characters it does not know, so a
  key full of junk could pass. Standard clients already send this shape.
- **Pongs are coalesced under backpressure.** A peer that sends pings and never
  reads used to make the server queue one pong per ping without bound. Now,
  while the write buffer is over its high-water mark, only the latest ping is
  answered, once it drains, as RFC 6455 5.5.3 allows. Nothing to do.
- **Releases need a lab-run certificate.** `publish.yml` gains a read-only
  `lab-certificate` job that every publishing job needs: a tag is published only
  when the fancy-labs lab has certified that exact version and commit. Consumers
  do nothing; this changes how releases are cut, not what the package does.

### Fixed

- **Nothing is read after the peer's close frame.** A half-open peer that kept
  writing after its close had its later data frames delivered as messages, and
  grew the read buffer until the close timer fired. RFC 6455 5.5.1 has the peer
  send nothing after its close; the connection now stops reading, as it already
  did after failing a connection for a protocol violation (where the bad bytes
  happened to fail again).
- **The sabotage probe runs on a Windows checkout.** Its multi-line anchors were
  LF and a `core.autocrlf` checkout is CRLF, so six of its nine sabotages could
  only ever report SKIP there. It now matches on LF and writes back in the file's
  own line endings.
- **The "refused before the 101" test knows Node 24.** It pinned Node 22's
  client (`error` and no `close`); by Node 24 the client also fires `close`, as
  the spec says. Both lines are pinned exactly, so the next change still fails.

## [0.1.1] - 2026-10-11

**No code change — nothing to do.** `0.1.1` is byte-for-byte the same library
as `0.1.0`. It exists so that a release of this package has been published by
CI, which no release had been.

### Changed

- **The tarball carries OIDC provenance.** `0.1.0` was published by hand to
  claim the npm name, so it has no attestations — and because nothing had ever
  published through `publish.yml`, nothing had established that it *can*. Take
  `0.1.1` if you verify signatures (`npm audit signatures`); the code is
  identical either way.
- **This version has a git tag and a GitHub release.** `0.1.0` had neither, so
  there was no route from the registry back to the commit it was built from.

For the record, because `0.1.0` cannot be given provenance after the fact: its
published tarball was checked against the source by rebuilding commit `29666df`
and comparing both bundles, both declaration files, README, CHANGELOG, LICENSE
and package.json — all byte-identical. Reproduction instead of a signature, but
the same conclusion.

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
