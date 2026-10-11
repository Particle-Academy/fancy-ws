# @particle-academy/fancy-ws

A **WebSocket server** for Node, with **zero runtime dependencies**.

Node 22 ships a WebSocket **client** — the `WebSocket` global, from undici — and
no server. This is the other half: RFC 6455 framing over `node:http`'s `upgrade`
event, built on `node:http`, `node:net`, `node:crypto` and `node:events` and
nothing else.

```bash
npm install @particle-academy/fancy-ws
```

## Quick start

```ts
import { createServer } from 'node:http';
import { attachWebSocketServer } from '@particle-academy/fancy-ws';

const http = createServer();
const ws = attachWebSocketServer(http, { path: '/remote' });

ws.on('connection', (socket, request, verified) => {
    socket.on('message', (data, isBinary) => {
        if (!isBinary) {
            socket.send(JSON.stringify({ echo: JSON.parse(data as string) }));
        }
    });
    socket.on('close', (code, reason) => console.log('gone', code, reason));
});

ws.heartbeat(30_000);
http.listen(7421);
```

It shares the server, so plain HTTP routes on the same port keep working.

## Authorise BEFORE the 101

`verify` runs during the handshake, so a refusal is a **plain HTTP response**
rather than an open-then-close.

```ts
const ws = attachWebSocketServer(http, {
    path: '/pair',
    verify: async (req) => {
        const pin = new URL(req.url ?? '/', 'http://local').searchParams.get('pin');
        if (!pin) return 401;                      // any 4xx/5xx status
        const session = await pins.claim(pin);
        if (!session) return 403;
        return { session };                        // handed to `connection`
    },
});

ws.on('connection', (socket, _req, { session }) => { /* already authorised */ });
```

| `verify` returns | result |
|---|---|
| `true` | accept; `verified` is `{}` |
| an object | accept; the object becomes `verified` |
| `false` | refuse with **403** |
| a number | refuse with that status |
| throws | **500**, and the error is emitted on the server's `error` event |

**Why before and not after.** An accept-then-close hands an unauthenticated
peer a live frame parser, however briefly, and forces the client to tell
"authorised" from "refused" by interpreting a close code. A 401 is something
every HTTP client already understands.

One measured caveat if the client is Node's own: on a refused handshake, Node
**v22.23.2** fires `error` and **no** `close`, and leaves `readyState` at
`CONNECTING` forever. A consumer waiting on `close` to learn the handshake
failed waits indefinitely — listen for `error`. This is a deviation from the
WHATWG spec's "fail the WebSocket connection", so it may change; the suite
asserts the current behaviour so a fix surfaces as a test failure here rather
than as a surprise in a consumer.

## The connection

```ts
socket.send('text');                  // or a Uint8Array for binary
socket.send(bytes);                   // returns false if not OPEN -- never throws
socket.close(1000, 'done');
socket.terminate();                   // no handshake; reports 1006
socket.ping();
socket.readyState;                    // 0/1/2/3, as in the browser
socket.remoteAddress;
socket.protocol;                      // negotiated subprotocol, or null
socket.request;                        // the upgrade IncomingMessage
```

| event | arguments |
|---|---|
| `message` | `(data: string \| Buffer, isBinary: boolean)` |
| `close` | `(code: number, reason: string)` — fires **exactly once** |
| `error` | `(error: Error)` |
| `ping` / `pong` | `(data: Buffer)` |

`data` is a **string** for text and a **Buffer** for binary, so `JSON.parse(data)`
needs no decode step. Messages are reassembled across fragments before delivery.

## Options

| option | default | |
|---|---|---|
| `path` | *(all)* | handle only this exact pathname |
| `onPathMismatch` | `'ignore'` | `'ignore'` leaves the upgrade for another listener; `'reject'` answers 404 |
| `verify` | — | authorise before the 101 (above) |
| `protocols` | — | subprotocols supported, most preferred first |
| `maxPayload` | 1 MiB | largest message, per frame **and** per reassembled message |
| `closeTimeoutMs` | 10 000 | how long to await the peer's close frame |

**`onPathMismatch: 'ignore'` is the default so this can share a port** with
other protocols — Genie's HTTP front door passes `upgrade` through for its own
surfaces. The cost is worth knowing: with no other `upgrade` listener, an
unmatched upgrade sits open until the client times out, because Node does not
answer an upgrade once any listener exists. Use `'reject'` when this is the only
WebSocket endpoint on the server.

## The heartbeat

```ts
const stop = ws.heartbeat(30_000);        // pings; drops after 2 missed pongs
```

A TCP connection to a machine that slept, lost its network, or lost power stays
`OPEN` indefinitely: nothing arrives and nothing errors, and `readyState` is a
statement about *this* end only. The pong is the only evidence the peer is still
there. The interval timer is `unref`'d, so it never keeps a process alive.

## What it does and does not do

**Does:** text, binary, fragmentation, masking enforcement, ping/pong, the close
handshake with code and reason, strict UTF-8 validation (1007), payload limits
per frame and per message (1009), minimal-length-encoding enforcement, RSV and
reserved-opcode refusal (1002), subprotocol negotiation, `https.Server` as well
as `http.Server`.

**Does not:** `permessage-deflate` (RSV1 is refused rather than ignored, so a
client offering it gets a clean failure instead of a corrupted message); a
client (Node has one built in); clustering or a pub/sub layer.

## Hostile input cannot crash the host

`EventEmitter` throws when `'error'` is emitted with no listener, so a naive
implementation lets any peer take the process down with one malformed frame.
Every error path here checks for a listener first; the close frame still carries
the protocol verdict to the peer. There is a test that drives a violation
through a connection with **no** error listener attached and then asserts the
server is still serving.

## Status

`0.1.x`. Pre-1.0, so breaking changes land in minor releases — see
[`CHANGELOG.md`](./CHANGELOG.md). Requires **Node >= 22**.

MIT © Particle Academy
