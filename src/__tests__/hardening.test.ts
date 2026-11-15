/**
 * Resource bounds a hostile peer must not be able to exceed, and data the
 * server must stop accepting once a connection is ending. Each case here is a
 * way to make the SERVER hold memory, or act on input, that it should not.
 */
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import type { WebSocketConnection } from '../connection.js';
import { OPCODE } from '../frame.js';
import { inspectHandshake } from '../handshake.js';
import { once, startServer, type Harness } from './harness.js';
import { maskedFrame, rawHandshake, type RawClient } from './raw-client.js';

let harness: Harness | undefined;

afterEach(async () => {
    await harness?.close();
    harness = undefined;
});

async function open(options: Parameters<typeof startServer>[0] = {}): Promise<{ client: RawClient; server: WebSocketConnection; messages: Array<string | Buffer> }> {
    harness = await startServer(options);
    const messages: Array<string | Buffer> = [];
    const connected = once<WebSocketConnection>(harness.ws as never, 'connection');
    const response = await rawHandshake(harness.port);
    expect(response.status).toBe(101);
    const [server] = await connected;
    server!.on('message', (data) => messages.push(data));
    return { client: response.client!, server: server!, messages };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function closeCode(client: RawClient): Promise<number> {
    for (;;) {
        const frame = await client.next();
        if (frame.opcode === OPCODE.close) {
            return frame.payload.readUInt16BE(0);
        }
    }
}

describe('bufferedAmount', () => {
    it('reports the bytes queued for a peer that is not reading', async () => {
        const { client, server } = await open();
        expect(server.bufferedAmount).toBe(0);
        client.socket.pause();
        const chunk = 'x'.repeat(64 * 1024);
        for (let i = 0; i < 200; i++) {
            server.send(chunk);
        }
        expect(server.bufferedAmount).toBeGreaterThan(1024 * 1024);
        client.destroy();
    });
});

describe('a ping flood from a peer that does not read', () => {
    it('cannot grow the pong backlog without bound, and the latest ping is still answered', async () => {
        const { client, server } = await open();
        client.socket.pause();
        // Enough pings that answering every one would queue far more than the
        // kernel's socket buffers absorb (about 12 MB of pongs; a smaller
        // flood fits in loopback buffers and never backs up into Node).
        const COUNT = 100_000;
        const pings: Buffer[] = [];
        for (let i = 0; i < COUNT; i++) {
            const payload = Buffer.alloc(125, i % 256);
            payload.writeUInt32BE(i, 0);
            pings.push(maskedFrame(OPCODE.ping, payload));
        }
        let received = 0;
        server.on('ping', () => (received += 1));
        client.sendBytes(Buffer.concat(pings));
        // Measured once the server has processed EVERY ping, so the reading is
        // the backlog, not a moment in the middle of the flood.
        const until = Date.now() + 15_000;
        while (received < COUNT && Date.now() < until) {
            await sleep(20);
        }
        expect(received).toBe(COUNT);
        // Answered one by one, the backlog would be megabytes. Coalesced, it
        // stays near one socket buffer's worth.
        expect(server.bufferedAmount).toBeLessThan(512 * 1024);

        client.socket.resume();
        let last = -1;
        const deadline = Date.now() + 10_000;
        while (last !== COUNT - 1 && Date.now() < deadline) {
            const frame = await client.next(5000);
            if (frame.opcode === OPCODE.pong) {
                last = frame.payload.readUInt32BE(0);
            }
        }
        expect(last).toBe(COUNT - 1);
        client.destroy();
    }, 40_000);
});

describe('fragment count', () => {
    it('closes 1009 on more fragments than maxFragments, however small they are', async () => {
        const { client } = await open({ maxFragments: 100 });
        const frames = [maskedFrame(OPCODE.text, Buffer.alloc(0), false)];
        for (let i = 0; i < 150; i++) {
            frames.push(maskedFrame(OPCODE.continuation, Buffer.alloc(0), false));
        }
        client.sendBytes(Buffer.concat(frames));
        expect(await closeCode(client)).toBe(1009);
    });

    it('has a default, so empty continuation frames cannot be sent forever', async () => {
        const { client } = await open();
        const frames = [maskedFrame(OPCODE.text, Buffer.alloc(0), false)];
        for (let i = 0; i < 20_000; i++) {
            frames.push(maskedFrame(OPCODE.continuation, Buffer.alloc(0), false));
        }
        client.sendBytes(Buffer.concat(frames));
        expect(await closeCode(client)).toBe(1009);
    });

    it('still reassembles a message in exactly maxFragments frames', async () => {
        const { client, messages } = await open({ maxFragments: 4 });
        client.send(OPCODE.text, 'a', false);
        client.send(OPCODE.continuation, 'b', false);
        client.send(OPCODE.continuation, 'c', false);
        client.send(OPCODE.continuation, 'd', true);
        await sleep(100);
        expect(messages).toEqual(['abcd']);
    });
});

describe('nothing is acted on once the connection is ending', () => {
    // A hostile peer keeps its write side open after the server ends its own
    // (a half-open socket), so the server keeps receiving. A well-behaved
    // client closes on the server's FIN and would hide the gap.
    function halfOpen(client: RawClient): void {
        (client.socket as unknown as { allowHalfOpen: boolean }).allowHalfOpen = true;
    }

    it('delivers no message sent after the peer\'s close frame', async () => {
        const { client, messages } = await open();
        halfOpen(client);
        client.sendBytes(Buffer.concat([maskedFrame(OPCODE.close, Buffer.from([0x03, 0xe8])), maskedFrame(OPCODE.text, Buffer.from('same segment'))]));
        await sleep(50);
        client.send(OPCODE.text, 'after close');
        await sleep(150);
        expect(messages).toEqual([]);
    });

    it('delivers no message sent after a protocol violation failed the connection', async () => {
        const { client, messages } = await open();
        halfOpen(client);
        // Unmasked: a 1002.
        client.sendBytes(Buffer.concat([Buffer.from([0x81, 0x02, 0x68, 0x69]), maskedFrame(OPCODE.text, Buffer.from('same segment'))]));
        await sleep(50);
        client.send(OPCODE.text, 'after failure');
        await sleep(150);
        expect(messages).toEqual([]);
    });
});

describe('Sec-WebSocket-Key', () => {
    function request(key: string): IncomingMessage {
        return {
            method: 'GET',
            url: '/',
            headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': key },
        } as unknown as IncomingMessage;
    }

    it.each([
        ['characters base64 does not have', '!!!!dGhlIHNhbXBsZSBub25jZQ=='],
        ['whitespace inside', 'dGhlIHNhbXBs ZSBub25jZQ=='],
        ['missing padding', 'dGhlIHNhbXBsZSBub25jZQ'],
        ['a URL-safe alphabet', 'dGhlIHNhbXBsZSBub25jZQ_-'],
    ])('refuses a key with %s, even when it decodes to 16 bytes', (_label, key) => {
        expect(inspectHandshake(request(key))).toMatchObject({ ok: false, status: 400 });
    });

    it('accepts the RFC example key', () => {
        expect(inspectHandshake(request('dGhlIHNhbXBsZSBub25jZQ==')).ok).toBe(true);
    });
});
