/**
 * What the server does to a client that breaks the protocol.
 *
 * Node's built-in client cannot produce any of these, which is why the raw
 * client exists. Every case here asserts the CLOSE CODE the peer is told,
 * because that code is the only part of the verdict that leaves the process.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { OPCODE } from '../frame.js';
import { startServer, type Harness } from './harness.js';
import { maskedFrame, rawHandshake, type RawClient } from './raw-client.js';

let harness: Harness | undefined;

afterEach(async () => {
    await harness?.close();
    harness = undefined;
});

/** Open a raw client, failing the test if the handshake did not reach 101. */
async function rawClient(port: number, path = '/'): Promise<RawClient> {
    const response = await rawHandshake(port, path);
    expect(response.status).toBe(101);
    expect(response.headers['sec-websocket-accept']).toBeTruthy();
    if (!response.client) {
        throw new Error('Handshake did not produce a client');
    }
    return response.client;
}

/** The close code the server sent, read off the wire. */
async function closeCodeFrom(client: RawClient): Promise<number> {
    const frame = await client.next();
    expect(frame.opcode).toBe(OPCODE.close);
    expect(frame.payload.length).toBeGreaterThanOrEqual(2);
    return frame.payload.readUInt16BE(0);
}

describe('framing violations', () => {
    it('closes 1002 on an unmasked client frame', async () => {
        harness = await startServer();
        const client = await rawClient(harness.port);
        // A correct client always masks. An unmasked frame is the shape
        // masking exists to prevent, so it is refused rather than tolerated.
        client.sendBytes(Buffer.concat([Buffer.from([0x81, 0x05]), Buffer.from('hello')]));
        expect(await closeCodeFrom(client)).toBe(1002);
        await client.waitForClose();
        expect(client.closed).toBe(true);
    });

    it('closes 1002 on a reserved opcode', async () => {
        harness = await startServer();
        const client = await rawClient(harness.port);
        const frame = maskedFrame(OPCODE.text, Buffer.from('x'));
        frame[0] = 0x80 | 0x3;
        client.sendBytes(frame);
        expect(await closeCodeFrom(client)).toBe(1002);
    });

    it('closes 1002 on a set RSV bit', async () => {
        harness = await startServer();
        const client = await rawClient(harness.port);
        const frame = maskedFrame(OPCODE.text, Buffer.from('x'));
        frame[0] = (frame[0] as number) | 0x40;
        client.sendBytes(frame);
        expect(await closeCodeFrom(client)).toBe(1002);
    });

    it('closes 1007 on invalid UTF-8 in a text frame', async () => {
        harness = await startServer();
        const client = await rawClient(harness.port);
        client.send(OPCODE.text, Buffer.from([0xc3, 0x28]));
        expect(await closeCodeFrom(client)).toBe(1007);
    });

    it('closes 1002 on a continuation with no message in progress', async () => {
        harness = await startServer();
        const client = await rawClient(harness.port);
        client.send(OPCODE.continuation, Buffer.from('orphan'));
        expect(await closeCodeFrom(client)).toBe(1002);
    });

    it('closes 1002 on a new data frame interrupting a fragmented message', async () => {
        harness = await startServer();
        const client = await rawClient(harness.port);
        client.send(OPCODE.text, Buffer.from('start'), false);
        client.send(OPCODE.text, Buffer.from('interrupting'));
        expect(await closeCodeFrom(client)).toBe(1002);
    });
});

describe('maxPayload', () => {
    it('closes 1009 on a single oversize frame', async () => {
        harness = await startServer({ maxPayload: 1024 });
        const client = await rawClient(harness.port);
        client.send(OPCODE.binary, Buffer.alloc(2048));
        expect(await closeCodeFrom(client)).toBe(1009);
    });

    it('closes 1009 when FRAGMENTS add up past the limit', async () => {
        // Without a per-message check, maxPayload is not a limit: a peer sends
        // under-limit fragments forever and the reassembly buffer grows without
        // bound while every individual frame passes.
        harness = await startServer({ maxPayload: 1024 });
        const client = await rawClient(harness.port);
        client.send(OPCODE.binary, Buffer.alloc(600), false);
        client.send(OPCODE.continuation, Buffer.alloc(600), true);
        expect(await closeCodeFrom(client)).toBe(1009);
    });

    it('accepts a message exactly at the limit', async () => {
        harness = await startServer({ maxPayload: 1024 });
        const sizes: number[] = [];
        harness.ws.on('connection', (socket) => {
            socket.on('message', (data) => sizes.push((data as Buffer).length));
        });
        const client = await rawClient(harness.port);
        client.send(OPCODE.binary, Buffer.alloc(1024));
        await waitFor(() => sizes.length === 1);
        expect(sizes).toEqual([1024]);
        client.destroy();
    });
});

describe('fragmentation', () => {
    it('reassembles a text message split across three frames', async () => {
        harness = await startServer();
        const messages: Array<string | Buffer> = [];
        harness.ws.on('connection', (socket) => {
            socket.on('message', (data) => messages.push(data));
        });

        const client = await rawClient(harness.port);
        client.send(OPCODE.text, Buffer.from('one '), false);
        client.send(OPCODE.continuation, Buffer.from('two '), false);
        client.send(OPCODE.continuation, Buffer.from('three'), true);

        await waitFor(() => messages.length === 1);
        expect(messages[0]).toBe('one two three');
        client.destroy();
    });

    it('handles a control frame interleaved between fragments', async () => {
        // RFC 6455 5.4 explicitly allows this, and it is the case a naive
        // "collect until FIN" loop corrupts by appending the ping payload to
        // the message.
        harness = await startServer();
        const messages: Array<string | Buffer> = [];
        harness.ws.on('connection', (socket) => {
            socket.on('message', (data) => messages.push(data));
        });

        const client = await rawClient(harness.port);
        client.send(OPCODE.text, Buffer.from('frag'), false);
        client.send(OPCODE.ping, Buffer.from('mid'));
        const pong = await client.next();
        expect(pong.opcode).toBe(OPCODE.pong);
        expect(pong.payload.toString('utf8')).toBe('mid');
        client.send(OPCODE.continuation, Buffer.from('ment'), true);

        await waitFor(() => messages.length === 1);
        expect(messages[0]).toBe('fragment');
        client.destroy();
    });

    it('validates UTF-8 over the whole reassembled message, not per fragment', async () => {
        // A multi-byte character split across two frames is VALID. A decoder
        // that validated each fragment would reject correct traffic -- and the
        // failure would look like a client bug.
        harness = await startServer();
        const messages: Array<string | Buffer> = [];
        harness.ws.on('connection', (socket) => {
            socket.on('message', (data) => messages.push(data));
        });

        const encoded = Buffer.from('世界', 'utf8');
        const client = await rawClient(harness.port);
        client.send(OPCODE.text, encoded.subarray(0, 2), false);
        client.send(OPCODE.continuation, encoded.subarray(2), true);

        await waitFor(() => messages.length === 1);
        expect(messages[0]).toBe('世界');
        client.destroy();
    });
});

describe('the close handshake', () => {
    it('echoes the code the client sent and then ends the socket', async () => {
        harness = await startServer();
        const client = await rawClient(harness.port);
        const payload = Buffer.alloc(2 + 3);
        payload.writeUInt16BE(1000, 0);
        payload.write('bye', 2);
        client.send(OPCODE.close, payload);

        const frame = await client.next();
        expect(frame.opcode).toBe(OPCODE.close);
        expect(frame.payload.readUInt16BE(0)).toBe(1000);
        await client.waitForClose();
        expect(client.closed).toBe(true);
    });

    it('reports 1005 locally for an empty close, and does not put 1005 on the wire', async () => {
        harness = await startServer();
        const codes: number[] = [];
        harness.ws.on('connection', (socket) => {
            socket.on('close', (code) => codes.push(code));
        });

        const client = await rawClient(harness.port);
        client.send(OPCODE.close, Buffer.alloc(0));
        const frame = await client.next();
        expect(frame.opcode).toBe(OPCODE.close);
        expect(frame.payload.length).toBe(0);

        await waitFor(() => codes.length === 1);
        expect(codes).toEqual([1005]);
    });

    it('closes 1002 on a one-byte close payload', async () => {
        harness = await startServer();
        const client = await rawClient(harness.port);
        client.send(OPCODE.close, Buffer.from([0x03]));
        expect(await closeCodeFrom(client)).toBe(1002);
    });

    it.each([1005, 1006, 999, 1016])('closes 1002 on close code %i, which may not be sent', async (code) => {
        harness = await startServer();
        const client = await rawClient(harness.port);
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code, 0);
        client.send(OPCODE.close, payload);
        expect(await closeCodeFrom(client)).toBe(1002);
    });

    it('reports 1006 when the peer vanishes without a close frame', async () => {
        harness = await startServer();
        const codes: number[] = [];
        harness.ws.on('connection', (socket) => {
            socket.on('close', (code) => codes.push(code));
        });

        const client = await rawClient(harness.port);
        client.destroy();
        await waitFor(() => codes.length === 1);
        expect(codes).toEqual([1006]);
    });
});

describe('the heartbeat', () => {
    it('drops a connection that stops answering pings', async () => {
        // A socket to a machine that slept or lost its network stays OPEN
        // forever: nothing arrives and nothing errors. The pong is the only
        // evidence the peer is still there.
        harness = await startServer();
        const stop = harness.ws.heartbeat(40);
        const client = await rawClient(harness.port);

        await client.waitForClose(3000);
        expect(client.closed).toBe(true);
        stop();
    });

    it('leaves a connection alone while it keeps answering', async () => {
        harness = await startServer();
        const stop = harness.ws.heartbeat(40);
        const client = await rawClient(harness.port);

        for (let i = 0; i < 4; i += 1) {
            const frame = await client.next(1000);
            expect(frame.opcode).toBe(OPCODE.ping);
            client.send(OPCODE.pong, frame.payload);
        }
        expect(client.closed).toBe(false);
        stop();
        client.destroy();
    });
});

describe('hostile input cannot take the process down', () => {
    it('survives a protocol violation on a connection with no error listener', async () => {
        // EventEmitter THROWS on an 'error' emit with no listener, so a naive
        // emit here would hand any peer a one-frame process kill. Deliberately
        // NO error listener is attached.
        harness = await startServer();
        const offender = await rawClient(harness.port);
        offender.sendBytes(Buffer.from([0x81, 0x05, ...Buffer.from('hello')]));
        await offender.waitForClose();

        // The proof is that the server is still here.
        harness.ws.on('connection', (socket) => {
            socket.on('message', (data) => socket.send(`still alive: ${data as string}`));
        });
        const survivor = await rawClient(harness.port);
        survivor.send(OPCODE.text, Buffer.from('ping'));
        const frame = await survivor.next();
        expect(frame.payload.toString('utf8')).toBe('still alive: ping');
        survivor.destroy();
    });

    it('answers a bad handshake with a plain HTTP error rather than hanging', async () => {
        harness = await startServer();
        const missingKey = await rawHandshake(harness.port, '/', { 'Sec-WebSocket-Key': null });
        expect(missingKey.status).toBe(400);

        const wrongVersion = await rawHandshake(harness.port, '/', { 'Sec-WebSocket-Version': '8' });
        expect(wrongVersion.status).toBe(426);
        expect(wrongVersion.headers['sec-websocket-version']).toBe('13');

        const post = await rawHandshake(harness.port, '/', { '@method': 'POST' });
        expect(post.status).toBe(405);
    });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error('Timed out waiting for a condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
