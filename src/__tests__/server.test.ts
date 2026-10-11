/**
 * Round-trips against Node's OWN WebSocket client (the `WebSocket` global,
 * from undici). A real client over a real socket -- no mock of our own
 * framing, which would only prove the encoder agrees with the decoder.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { WebSocketConnection } from '../connection.js';
import { READY_STATE } from '../connection.js';
import { OPCODE } from '../frame.js';
import { startServer, type Harness } from './harness.js';
import { maskedFrame, rawHandshake } from './raw-client.js';

let harness: Harness | undefined;
const openClients: WebSocket[] = [];

afterEach(async () => {
    for (const client of openClients.splice(0)) {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
            client.close();
        }
    }
    await harness?.close();
    harness = undefined;
});

async function openClient(url: string, protocols?: string | string[]): Promise<WebSocket> {
    const client = new WebSocket(url, protocols as string[]);
    client.binaryType = 'arraybuffer';
    openClients.push(client);
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for open')), 3000);
        client.addEventListener('open', () => {
            clearTimeout(timer);
            resolve();
        });
        client.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error('Client errored before open'));
        });
    });
    return client;
}

function nextMessage(client: WebSocket, timeoutMs = 3000): Promise<string | ArrayBuffer> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for a message')), timeoutMs);
        client.addEventListener(
            'message',
            (event) => {
                clearTimeout(timer);
                resolve(event.data as string | ArrayBuffer);
            },
            { once: true },
        );
    });
}

function nextClose(client: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for close')), timeoutMs);
        client.addEventListener(
            'close',
            (event) => {
                clearTimeout(timer);
                resolve(event as unknown as { code: number; reason: string });
            },
            { once: true },
        );
    });
}

/** Resolve with the next accepted connection. */
function nextConnection(h: Harness, timeoutMs = 3000): Promise<[WebSocketConnection, Record<string, unknown>]> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for a connection')), timeoutMs);
        h.ws.once('connection', (socket, _req, verified) => {
            clearTimeout(timer);
            resolve([socket, verified]);
        });
    });
}

describe('round-trips with Node\'s built-in WebSocket client', () => {
    it('echoes a text message', async () => {
        harness = await startServer();
        harness.ws.on('connection', (socket) => {
            socket.on('message', (data) => {
                socket.send(`echo: ${data as string}`);
            });
        });

        const client = await openClient(harness.url);
        client.send('hello');
        expect(await nextMessage(client)).toBe('echo: hello');
    });

    it('delivers text as a string and binary as a Buffer', async () => {
        harness = await startServer();
        const received: Array<[unknown, boolean]> = [];
        harness.ws.on('connection', (socket) => {
            socket.on('message', (data, isBinary) => received.push([data, isBinary]));
        });

        const client = await openClient(harness.url);
        client.send('a string');
        client.send(new Uint8Array([1, 2, 3]));
        await vi_waitFor(() => received.length === 2);

        expect(received[0]).toEqual(['a string', false]);
        expect(received[1]?.[1]).toBe(true);
        expect(Buffer.isBuffer(received[1]?.[0])).toBe(true);
        expect([...(received[1]?.[0] as Buffer)]).toEqual([1, 2, 3]);
    });

    it('round-trips a payload larger than a 16-bit length can describe', async () => {
        // 70 KiB forces the 64-bit header in BOTH directions, which is the
        // branch a small-message test never reaches.
        harness = await startServer({ maxPayload: 1024 * 1024 });
        harness.ws.on('connection', (socket) => {
            socket.on('message', (data) => socket.send(data as Buffer));
        });

        const client = await openClient(harness.url);
        const payload = Buffer.alloc(70 * 1024);
        for (let i = 0; i < payload.length; i += 1) {
            payload[i] = i % 256;
        }
        client.send(payload);
        const echoed = await nextMessage(client, 6000);
        expect(Buffer.from(echoed as ArrayBuffer).equals(payload)).toBe(true);
    });

    it('reassembles a message the client split across frames', async () => {
        harness = await startServer();
        const messages: string[] = [];
        harness.ws.on('connection', (socket) => {
            socket.on('message', (data) => messages.push(data as string));
        });

        // undici fragments outgoing messages above its own threshold, so a
        // large send exercises the continuation path without hand-framing.
        const client = await openClient(harness.url);
        const text = 'x'.repeat(200 * 1024);
        client.send(text);
        await vi_waitFor(() => messages.length === 1, 6000);
        expect(messages[0]?.length).toBe(text.length);
    });
});

describe('verify', () => {
    it('hands what it returned to the connection listener', async () => {
        harness = await startServer({ verify: () => ({ user: 'glenn', pin: '482913' }) });
        const pending = nextConnection(harness);
        await openClient(harness.url);
        const [, verified] = await pending;
        expect(verified).toEqual({ user: 'glenn', pin: '482913' });
    });

    it('passes {} when it returns true', async () => {
        harness = await startServer({ verify: () => true });
        const pending = nextConnection(harness);
        await openClient(harness.url);
        expect((await pending)[1]).toEqual({});
    });

    it('refuses with a plain 403 and never opens the socket', async () => {
        harness = await startServer({ verify: () => false });
        let connections = 0;
        harness.ws.on('connection', () => {
            connections += 1;
        });

        const response = await rawHandshake(harness.port);
        expect(response.status).toBe(403);
        expect(response.client).toBeUndefined();
        expect(connections).toBe(0);
    });

    it('refuses with the status it returns', async () => {
        harness = await startServer({ verify: () => 401 });
        const response = await rawHandshake(harness.port);
        expect(response.status).toBe(401);
        expect(response.statusLine).toContain('Unauthorized');
    });

    it('runs BEFORE the 101, so a client never sees open-then-close', async () => {
        harness = await startServer({ verify: () => 403 });
        const client = new WebSocket(harness.url);
        openClients.push(client);

        const events: string[] = [];
        for (const name of ['open', 'error', 'close', 'message']) {
            client.addEventListener(name, () => events.push(name));
        }
        await vi_waitFor(() => events.length > 0);
        await new Promise((resolve) => setTimeout(resolve, 300));

        // `open` NEVER fires -- that is the whole point of verifying before the
        // 101. An accept-then-close would fire it, and the consumer would then
        // have to tell "authorised" from "refused" by reading a close code.
        //
        // And exactly ONE event arrives: `error`. Measured on Node v22.23.2 --
        // its built-in client fires no `close` for a refused handshake and
        // leaves readyState at CONNECTING (0) permanently, which is a
        // deviation from the WHATWG spec's "fail the WebSocket connection".
        // Asserted here so an upstream fix shows up as a failure in OUR suite
        // rather than as a consumer waiting forever on a `close` that the
        // README promised would not come.
        expect(events).toEqual(['error']);
        expect(client.readyState).toBe(WebSocket.CONNECTING);
    });

    it('awaits an async verify, and keeps frames the client pipelined meanwhile', async () => {
        // A client may send frames without waiting for the 101. If those bytes
        // are dropped while verify awaits, the FIRST message of a session is
        // lost and every later one arrives -- which reads as an application
        // bug anywhere but here.
        //
        // This needs the RAW client: Node's own client waits for the 101
        // before sending, so a test written against it passes with the
        // early-data collection deleted. That is how this test was written
        // first, and a sabotage run is what caught it.
        harness = await startServer({
            verify: async () => {
                await new Promise((resolve) => setTimeout(resolve, 120));
                return { slow: true };
            },
        });
        const messages: string[] = [];
        harness.ws.on('connection', (socket) => {
            socket.on('message', (data) => messages.push(data as string));
        });

        const response = await rawHandshake(
            harness.port,
            '/',
            {},
            maskedFrame(OPCODE.text, Buffer.from('pipelined ahead of the 101')),
        );
        expect(response.status).toBe(101);
        await vi_waitFor(() => messages.length === 1);
        expect(messages).toEqual(['pipelined ahead of the 101']);
        response.client?.destroy();
    });

    it('keeps a frame that arrives in a LATER segment while verify is still awaiting', async () => {
        // The sibling of the test above, and a genuinely separate code path.
        // Bytes written with the request land in Node's `head` buffer; bytes
        // written a moment later arrive as a `data` event, and between the
        // upgrade and the 101 nobody is listening for one unless the server
        // collects them. A sabotage run is what separated these two -- the
        // same-segment test passes with the `data` collection deleted, because
        // `head` already carried the frame.
        harness = await startServer({
            verify: async () => {
                await new Promise((resolve) => setTimeout(resolve, 150));
                return true;
            },
        });
        const messages: string[] = [];
        harness.ws.on('connection', (socket) => {
            socket.on('message', (data) => messages.push(data as string));
        });

        const response = await rawHandshake(
            harness.port,
            '/',
            {},
            maskedFrame(OPCODE.text, Buffer.from('a second segment')),
            30,
        );
        expect(response.status).toBe(101);
        await vi_waitFor(() => messages.length === 1);
        expect(messages).toEqual(['a second segment']);
        response.client?.destroy();
    });

    it('answers 500 and reports a thrown verify on the server error event', async () => {
        harness = await startServer({
            verify: () => {
                throw new Error('database is on fire');
            },
        });
        const errors: Error[] = [];
        harness.ws.on('error', (error) => errors.push(error));

        const response = await rawHandshake(harness.port);
        expect(response.status).toBe(500);
        expect(errors.map((error) => error.message)).toEqual(['database is on fire']);
    });

    it('sees the request, so a PIN in the query string is checkable', async () => {
        harness = await startServer({
            verify: (req) => {
                const url = new URL(req.url ?? '/', 'http://127.0.0.1');
                return url.searchParams.get('pin') === '482913' ? { paired: true } : 401;
            },
        });

        expect((await rawHandshake(harness.port, '/?pin=000000')).status).toBe(401);
        const pending = nextConnection(harness);
        await openClient(`${harness.url}/?pin=482913`);
        expect((await pending)[1]).toEqual({ paired: true });
    });
});

describe('path routing', () => {
    it('handles only the configured path', async () => {
        harness = await startServer({ path: '/remote' });
        const ok = await rawHandshake(harness.port, '/remote');
        expect(ok.status).toBe(101);
        ok.client?.destroy();
    });

    it('matches the path with a query string attached', async () => {
        harness = await startServer({ path: '/remote' });
        const ok = await rawHandshake(harness.port, '/remote?pin=1');
        expect(ok.status).toBe(101);
        ok.client?.destroy();
    });

    it('answers 404 for a mismatch when asked to reject', async () => {
        harness = await startServer({ path: '/remote', onPathMismatch: 'reject' });
        expect((await rawHandshake(harness.port, '/elsewhere')).status).toBe(404);
    });

    it('leaves a mismatched upgrade for another listener when ignoring', async () => {
        harness = await startServer({ path: '/remote' });
        const seen: string[] = [];
        harness.http.on('upgrade', (req, socket) => {
            // A second protocol sharing the port. This is why 'ignore' is the
            // default: answering 404 here would break it.
            if (req.url === '/other') {
                seen.push(req.url);
                socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: other\r\n\r\n');
                socket.end();
            }
        });

        const response = await rawHandshake(harness.port, '/other');
        expect(seen).toEqual(['/other']);
        expect(response.headers.upgrade).toBe('other');
    });

    it('leaves plain HTTP requests on the same server alone', async () => {
        harness = await startServer({ path: '/remote' });
        const response = await fetch(`http://127.0.0.1:${harness.port}/anything`);
        expect(await response.text()).toBe('plain http still works');
    });
});

describe('subprotocols', () => {
    it('echoes a protocol both sides support', async () => {
        harness = await startServer({ protocols: ['genie.v1', 'genie.v0'] });
        const client = await openClient(harness.url, ['genie.v0', 'genie.v1']);
        expect(client.protocol).toBe('genie.v1');
    });

    it('omits the header when nothing matches', async () => {
        harness = await startServer({ protocols: ['genie.v1'] });
        const response = await rawHandshake(harness.port, '/', { 'Sec-WebSocket-Protocol': 'something-else' });
        expect(response.status).toBe(101);
        expect(response.headers['sec-websocket-protocol']).toBeUndefined();
        response.client?.destroy();
    });
});

describe('closing', () => {
    it('reports the code and reason the client sent', async () => {
        harness = await startServer();
        const pending = nextConnection(harness);
        const client = await openClient(harness.url);
        const [socket] = await pending;

        const closed = new Promise<[number, string]>((resolve) => {
            socket.on('close', (code, reason) => resolve([code, reason]));
        });
        client.close(4001, 'done here');
        expect(await closed).toEqual([4001, 'done here']);
    });

    it('delivers a server-initiated close to the client', async () => {
        harness = await startServer();
        const pending = nextConnection(harness);
        const client = await openClient(harness.url);
        const [socket] = await pending;

        const closing = nextClose(client);
        socket.close(1001, 'going away');
        const event = await closing;
        expect([event.code, event.reason]).toEqual([1001, 'going away']);
    });

    it('fires close exactly once, even when the socket is destroyed mid-handshake', async () => {
        harness = await startServer();
        const pending = nextConnection(harness);
        await openClient(harness.url);
        const [socket] = await pending;

        let closes = 0;
        socket.on('close', () => {
            closes += 1;
        });
        socket.close();
        socket.terminate();
        socket.terminate();
        await vi_waitFor(() => closes > 0);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(closes).toBe(1);
    });

    it('refuses to send a close code that must not go on the wire', async () => {
        harness = await startServer();
        const pending = nextConnection(harness);
        await openClient(harness.url);
        const [socket] = await pending;

        expect(() => socket.close(1006)).toThrow(RangeError);
        expect(() => socket.close(1005)).toThrow(RangeError);
        expect(() => socket.close(1000, 'x'.repeat(200))).toThrow(RangeError);
    });

    it('send() returns false rather than throwing once closed', async () => {
        harness = await startServer();
        const pending = nextConnection(harness);
        await openClient(harness.url);
        const [socket] = await pending;

        expect(socket.send('while open')).toBe(true);
        socket.terminate();
        await vi_waitFor(() => socket.readyState === READY_STATE.closed);
        expect(socket.send('after close')).toBe(false);
    });

    it('drops the connection from clients when it ends', async () => {
        harness = await startServer();
        const pending = nextConnection(harness);
        const client = await openClient(harness.url);
        await pending;
        expect(harness.ws.clients.size).toBe(1);

        client.close();
        await vi_waitFor(() => harness?.ws.clients.size === 0);
        expect(harness.ws.clients.size).toBe(0);
    });
});

describe('connection surface', () => {
    it('exposes the peer address and the upgrade request', async () => {
        harness = await startServer();
        const pending = nextConnection(harness);
        await openClient(`${harness.url}/x?y=1`);
        const [socket] = await pending;
        expect(socket.remoteAddress).toBe('127.0.0.1');
        expect(socket.request.url).toBe('/x?y=1');
        expect(socket.readyState).toBe(READY_STATE.open);
    });

    it('answers a client ping with a pong automatically', async () => {
        harness = await startServer();
        const pending = nextConnection(harness);
        await openClient(harness.url);
        const [socket] = await pending;

        // Node's client sends no pings of its own, so this comes from the raw
        // path; what is asserted here is that the server SEES it.
        const pinged = new Promise<Buffer>((resolve) => socket.on('ping', resolve));
        const raw = await rawHandshake(harness.port);
        raw.client?.send(0x9, Buffer.from('are you there'));
        const frame = await raw.client?.next();
        expect(frame?.opcode).toBe(0xa);
        expect(frame?.payload.toString('utf8')).toBe('are you there');
        raw.client?.destroy();
        void pinged;
    });

    it('carries several concurrent connections independently', async () => {
        harness = await startServer();
        harness.ws.on('connection', (socket, req) => {
            socket.on('message', () => socket.send(req.url ?? '?'));
        });

        const clients = await Promise.all([
            openClient(`${harness.url}/one`),
            openClient(`${harness.url}/two`),
            openClient(`${harness.url}/three`),
        ]);
        const replies = await Promise.all(
            clients.map((client) => {
                const pending = nextMessage(client);
                client.send('who am i');
                return pending;
            }),
        );
        expect(replies.sort()).toEqual(['/one', '/three', '/two']);
    });
});

/** Minimal poll-until-true; vitest's own waitFor is not in this version's core. */
async function vi_waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error('Timed out waiting for a condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
