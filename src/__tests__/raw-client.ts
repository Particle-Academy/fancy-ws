/**
 * A hand-rolled WebSocket CLIENT for the tests, speaking frames over a raw
 * socket.
 *
 * It exists because Node's built-in `WebSocket` is a well-behaved client, and a
 * well-behaved client cannot test the rules that only a misbehaving one
 * triggers: an unmasked frame, a reserved opcode, a fragment sequence, a close
 * code that must not be sent, a 10-byte header claiming four gigabytes. The
 * undici round-trips in `server.test.ts` cover the path a real consumer takes;
 * this covers the path an attacker takes.
 */
import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';

import { type DecodedFrame, decodeFrame } from '../frame.js';

export interface RawHandshake {
    status: number;
    statusLine: string;
    headers: Record<string, string>;
    body: string;
    /** Present only on a 101. */
    client?: RawClient;
}

/** Encode a frame the way a CLIENT must: always masked. */
export function maskedFrame(opcode: number, payload: Buffer, fin = true): Buffer {
    const key = randomBytes(4);
    const masked = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i += 1) {
        masked[i] = (payload[i] as number) ^ (key[i % 4] as number);
    }

    let header: Buffer;
    if (payload.length <= 125) {
        header = Buffer.allocUnsafe(2);
        header[1] = 0x80 | payload.length;
    } else if (payload.length <= 0xffff) {
        header = Buffer.allocUnsafe(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
    } else {
        header = Buffer.allocUnsafe(10);
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    return Buffer.concat([header, key, masked]);
}

export class RawClient {
    readonly socket: Socket;
    #buffer: Buffer;
    #queue: DecodedFrame[] = [];
    #wake: (() => void) | null = null;
    #ended = false;
    #error: Error | null = null;

    constructor(socket: Socket, rest: Buffer) {
        this.socket = socket;
        this.#buffer = rest;
        socket.on('data', (chunk: Buffer) => {
            this.#buffer = Buffer.concat([this.#buffer, chunk]);
            this.#pump();
        });
        socket.on('close', () => {
            this.#ended = true;
            this.#wake?.();
        });
        socket.on('error', (error: Error) => {
            // A peer resetting the connection is a normal outcome of several of
            // these tests, so it is recorded rather than thrown.
            this.#error = error;
            this.#ended = true;
            this.#wake?.();
        });
        this.#pump();
    }

    get closed(): boolean {
        return this.#ended;
    }

    get socketError(): Error | null {
        return this.#error;
    }

    #pump(): void {
        for (;;) {
            const frame = decodeFrame(this.#buffer, { mask: 'forbidden', maxPayload: 64 * 1024 * 1024 });
            if (frame === null) {
                return;
            }
            this.#buffer = this.#buffer.subarray(frame.consumed);
            this.#queue.push(frame);
            this.#wake?.();
        }
    }

    /** Next frame from the server, or throw if the socket ends first. */
    async next(timeoutMs = 3000): Promise<DecodedFrame> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const frame = this.#queue.shift();
            if (frame !== undefined) {
                return frame;
            }
            if (this.#ended) {
                throw new Error('Socket closed before a frame arrived');
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error('Timed out waiting for a frame');
            }
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, Math.min(remaining, 50));
                this.#wake = () => {
                    clearTimeout(timer);
                    this.#wake = null;
                    resolve();
                };
            });
        }
    }

    /** Wait for the socket to end. Resolves; never rejects. */
    async waitForClose(timeoutMs = 3000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!this.#ended && Date.now() < deadline) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 20);
                this.#wake = () => {
                    clearTimeout(timer);
                    this.#wake = null;
                    resolve();
                };
            });
        }
    }

    send(opcode: number, payload: Buffer | string = Buffer.alloc(0), fin = true): void {
        const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
        this.socket.write(maskedFrame(opcode, body, fin));
    }

    /** Write bytes verbatim — for frames that no correct encoder would produce. */
    sendBytes(bytes: Buffer): void {
        this.socket.write(bytes);
    }

    destroy(): void {
        this.socket.destroy();
    }
}

/**
 * Perform an opening handshake by hand and report what came back, whatever the
 * status. Returns a {@link RawClient} only on a 101.
 */
export async function rawHandshake(
    port: number,
    path = '/',
    headerOverrides: Record<string, string | null> = {},
    /**
     * Frames to write in the SAME `write()` as the request, before any
     * response. RFC 6455 permits this and Node's own client never does it, so
     * nothing but a hand-rolled client can test that the bytes survive an
     * `await` inside `verify`.
     */
    pipelined?: Buffer,
    /**
     * Delay before writing `pipelined`, in ms. `undefined` writes it in the
     * same `write()` as the request, so it lands in Node's `head` buffer; a
     * number writes it as a SEPARATE segment, which arrives as a `data` event
     * instead. Those are two different code paths on the server and only one
     * of them is `head`.
     */
    pipelineAfterMs?: number,
): Promise<RawHandshake> {
    const headers: Record<string, string | null> = {
        Host: `127.0.0.1:${port}`,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
        ...headerOverrides,
    };

    const method = headers['@method'] ?? 'GET';
    delete headers['@method'];

    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });

    const lines = [`${method} ${path} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
        if (value !== null) {
            lines.push(`${name}: ${value}`);
        }
    }
    lines.push('', '');
    const requestBytes = Buffer.from(lines.join('\r\n'), 'latin1');
    if (pipelined && pipelineAfterMs === undefined) {
        socket.write(Buffer.concat([requestBytes, pipelined]));
    } else {
        socket.write(requestBytes);
        if (pipelined) {
            setTimeout(() => socket.write(pipelined), pipelineAfterMs).unref();
        }
    }

    // Read until the end of the response head.
    let buffer = Buffer.alloc(0);
    await new Promise<void>((resolve, reject) => {
        const onData = (chunk: Buffer): void => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.includes('\r\n\r\n')) {
                socket.off('data', onData);
                resolve();
            }
        };
        socket.on('data', onData);
        socket.once('error', reject);
        socket.once('close', () => resolve());
        setTimeout(() => reject(new Error('Timed out waiting for the handshake response')), 3000);
    });

    const separator = buffer.indexOf('\r\n\r\n');
    const head = buffer.subarray(0, separator < 0 ? buffer.length : separator).toString('latin1');
    const rest = separator < 0 ? Buffer.alloc(0) : buffer.subarray(separator + 4);

    const [statusLine = '', ...headerLines] = head.split('\r\n');
    const status = Number.parseInt(statusLine.split(' ')[1] ?? '0', 10);
    const responseHeaders: Record<string, string> = {};
    for (const line of headerLines) {
        const colon = line.indexOf(':');
        if (colon > 0) {
            responseHeaders[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
    }

    if (status === 101) {
        return { status, statusLine, headers: responseHeaders, body: '', client: new RawClient(socket, rest) };
    }

    const body = rest.toString('utf8');
    socket.destroy();
    return { status, statusLine, headers: responseHeaders, body };
}
