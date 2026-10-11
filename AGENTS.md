# AGENTS.md — fancy-ws

`CLAUDE.md` is a symlink to this file.

**This file describes THIS REPO'S CODE and nothing else.** Process rules —
lifecycle, version policy, publishing procedure, backports — live in the
envelope's `RULES.md` and must never be copied here: a maintenance branch would
then carry a frozen copy of a rule that has since changed, with nothing to flag
it.

## What this package is

A **WebSocket server** for Node with zero runtime dependencies. Node 22 ships a
WebSocket **client** (the `WebSocket` global, from undici) and no server; this
is the other half.

It is **not** a client, not a pub/sub layer, and not a transport abstraction. It
turns `node:http`'s `upgrade` event into RFC 6455 frames and hands them to a
listener.

## Layout

| file | what lives there |
|---|---|
| `src/frame.ts` | the RFC 6455 codec. Pure functions over Buffers — no sockets, no state. Every framing rule is testable without opening a port. |
| `src/handshake.ts` | what makes an upgrade a WebSocket one, and what the 101 must say. A function of the request headers alone. |
| `src/connection.ts` | one open connection: the frame loop, reassembly, the close handshake. |
| `src/server.ts` | the `upgrade` listener, path routing, `verify`, the heartbeat. |

The split is deliberate: the two files with no I/O hold most of the rules, which
is why `frame.test.ts` and `handshake.test.ts` run in milliseconds and cover the
cases a live socket makes awkward to reach.

## The four invariants

Everything else is detail. Each of these has a test that fails if it is broken,
and each was verified by **breaking the code on purpose and watching the suite
go red** — see "Sabotage" below.

### 1. AUTHORISATION HAPPENS BEFORE THE 101

`verify` runs during the handshake. A refusal is a plain HTTP status.

An accept-then-close would hand an unauthenticated peer a live frame parser,
and would force every client to tell "authorised" from "refused" by
interpreting a close code. It also loses the HTTP status, which is the one
signal every client's error handling already understands.

### 2. A PEER CANNOT CRASH THE HOST

`EventEmitter` **throws** when `'error'` is emitted with no listener. So a bare
`this.emit('error', …)` on a malformed frame hands any peer a one-frame process
kill — client-controlled input deciding whether the host survives.

Every error path goes through a guard that checks `listenerCount('error')`
first. The close frame still carries the verdict to the peer, so a missing
listener loses the detail, not the handling. **Never replace that guard with a
direct emit**, and never "fix" it by attaching a no-op listener in the
constructor — that would silence a consumer's own handler.

### 3. `maxPayload` IS TWO CHECKS, AND BOTH ARE LOAD-BEARING

- **Per frame**, read from the declared length in the header *before any body is
  buffered*. A 10-byte header can claim 2^63 bytes; a check that waited for the
  body would be a memory amplifier rather than a limit.
- **Per reassembled message.** Without it the first check is not a limit at all:
  a peer sends under-limit fragments forever and the reassembly buffer grows
  without bound while every individual frame passes.

### 4. THE SOCKET STAYS PAUSED UNTIL THE HANDSHAKE IS AUTHORISED

Node hands over `head` — bytes the client pipelined in the same TCP segment as
its request — because it has already removed them from the stream. Those are
carried to the connection by hand. Bytes in a **later** segment need nothing:
the socket is paused, so Node buffers them and releases them when the
connection attaches its own listener.

An earlier draft collected them into an array during `verify`. That put the
socket into flowing mode and held an unbounded buffer **for an unauthenticated
peer**. Paused, the socket fills to its high-water mark and then stops reading,
which is the backpressure that peer should get. Do not re-add a collector.

## The ordering trap, because it will bite again

`WebSocketConnection` buffers its initial data and parses nothing until
`start()` is called. The server calls `start()` **after** emitting
`connection`.

The first version parsed in the constructor, and a message the client had
pipelined was therefore emitted while the consumer's `socket.on('message', …)`
was still one statement away from existing. Nothing reports an event with no
listeners, so the symptom was "the first message of a session goes missing and
every later one arrives" — which reads as an application bug anywhere but here.

**If you add anything to the constructor that can emit, it has the same
problem.**

## Testing

```bash
npm test            # 99 tests
npx tsc --noEmit
npx tsup && node scripts/smoke.mjs
```

Four suites, and the split matters:

- `frame.test.ts` / `handshake.test.ts` — the rules, with no socket. The accept
  key is asserted against **RFC 6455's own worked example** rather than against
  our implementation, so a wrong GUID cannot agree with itself.
- `server.test.ts` — round-trips against **Node's own `WebSocket` client**. A
  real client over a real socket; nothing mocks our framing.
- `protocol.test.ts` — the same, through `src/__tests__/raw-client.ts`, a
  hand-rolled client that misbehaves on purpose. **A well-behaved client cannot
  test the rules only a misbehaving one triggers**: an unmasked frame, a
  reserved opcode, a fragment sequence, a close code that must not be sent.

`scripts/smoke.mjs` tests the **built artifact** through both entry points the
manifest advertises, and asserts the dependency claim against the bundle's own
text. The suite imports `src/`, so it says nothing about what a consumer
receives — a wrong `exports` map passes a green suite and fails on install.

### Sabotage — how these tests were shown to have teeth

`scripts/sabotage.py` breaks one invariant at a time and asserts the suite goes
red (`python -I scripts/sabotage.py`). It edits `src/` and restores it in a
`finally`, so do not run it on a dirty tree -- and it is deliberately NOT wired
into npm scripts or CI, because a check that mutates the source it checks is not
one you want attached to a push. On a brand-new package this is the only way to
tell an asserting test from a decorative one, because nothing has ever failed.

It found two real defects in its first run, and both were in places that looked
fine:

1. **The constructor-ordering bug above.** The test that claimed to cover
   pipelined frames passed with the early-data handling deleted, because Node's
   own client *does not pipeline* — it waits for the 101. The test had never
   exercised the path named in its own title.
2. **The unbounded pre-auth buffer.** Removing the `data` collector changed
   nothing, which is how we learned it was not load-bearing — and that keeping
   it was worse than redundant.

It also produced a **false** MISSED twice, which is the lesson worth carrying:
`vitest -t <pattern>` with a pattern that matches no test **skips everything and
exits 0**, indistinguishable from "the sabotage ran and nothing noticed". The
probe now counts selected tests and reports `NO-TEST` instead of a verdict. A
filter is a claim about test names; check it.

## Things that surprise people

- **The published bundle imports `events`, not `node:events`.** tsup strips the
  prefix, and every bundled package in this kit ships that way. It is safe —
  Node resolves builtins ahead of `node_modules` for both `require` and bare
  ESM specifiers — but an auditor reading the tarball sees different specifiers
  than the source.
- **A refused handshake gives Node's own client `error` and no `close`**, with
  `readyState` stuck at `CONNECTING`. Measured on v22.23.2; it deviates from the
  WHATWG spec, and the suite asserts the current behaviour so an upstream fix
  arrives as a failure here rather than as a confused consumer.
- **`send()` returns `false` instead of throwing** when the socket is not open.
  A peer closing between a consumer's check and its send is ordinary, and an
  exception there forces every caller into a try/catch that cannot do anything
  useful.
- **`onPathMismatch` defaults to `'ignore'`**, so an unmatched upgrade with no
  other listener hangs until the client times out. That is the price of sharing
  a port, and it is the right default here because Genie's front door passes
  `upgrade` through for its own surfaces.
