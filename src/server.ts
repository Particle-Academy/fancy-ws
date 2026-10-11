/**
 * Attaching a WebSocket server to an existing `http.Server`.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

import { WebSocketConnection, type ConnectionOptions } from './connection.js';
import { acceptKey, inspectHandshake, negotiateProtocol } from './handshake.js';

/**
 * The shape this package needs from a server, rather than `http.Server`
 * itself: `https.Server` extends `tls.Server`, NOT `http.Server`, so naming the
 * concrete class would exclude the TLS case for no reason. Anything that emits
 * `upgrade` works, which includes both.
 */
export interface UpgradableServer {
    on(event: 'upgrade', listener: (req: IncomingMessage, socket: Socket, head: Buffer) => void): unknown;
    off(event: 'upgrade', listener: (req: IncomingMessage, socket: Socket, head: Buffer) => void): unknown;
}

/**
 * What `verify` may return.
 *
 * - `true` — accept, with `{}` as the verified value.
 * - `false` — refuse with **403**.
 * - a number — refuse with that HTTP status (401 for "authenticate", 404 to
 *   hide the endpoint's existence, 429 for a rate limit).
 * - an object — accept, and the object is handed to the `connection` listener.
 *   This is how an authenticated identity reaches the connection without a
 *   second lookup or a `WeakMap` keyed on the request.
 */
export type VerifyResult = boolean | number | Record<string, unknown>;

export interface WebSocketServerOptions {
    /**
     * Only handle upgrades whose pathname matches exactly. Omit to handle every
     * upgrade this server emits.
     */
    path?: string;
    /**
     * What to do with an upgrade whose path does not match.
     *
     * `'ignore'` (the default) leaves the socket for another `upgrade`
     * listener, so this can share a server with other protocols. The cost is
     * real and worth knowing: with NO other listener, an unmatched upgrade sits
     * open until the client times out, because Node does not answer an upgrade
     * once a listener exists.
     *
     * `'reject'` answers 404 instead. Correct when this is the only WebSocket
     * endpoint on the server, and wrong the moment something else wants the
     * same port.
     */
    onPathMismatch?: 'ignore' | 'reject';
    /**
     * Authorise the handshake **before** the 101.
     *
     * Running here rather than after the upgrade is the whole point: a refusal
     * is a plain HTTP response the client's error handling already understands,
     * where an accept-then-close gives a client an `open` event followed by a
     * close code it has to interpret -- and gives an unauthenticated peer a
     * live frame parser, however briefly.
     *
     * A thrown error is a 500 and is reported on the server's `error` event.
     */
    verify?: (req: IncomingMessage) => VerifyResult | Promise<VerifyResult>;
    /** Subprotocols this server supports, most preferred first. */
    protocols?: string[];
    /** Largest message accepted, per frame and per reassembled message. Default 1 MiB. */
    maxPayload?: number;
    /** How long to wait for the peer's close frame. Default 10_000 ms. */
    closeTimeoutMs?: number;
}

export interface WebSocketServerEvents {
    /**
     * A connection is open. `verified` is whatever `verify` returned (`{}` when
     * it returned `true` or was not supplied).
     */
    connection: [socket: WebSocketConnection, request: IncomingMessage, verified: Record<string, unknown>];
    /** A handshake-time failure. Per-connection errors go to the connection. */
    error: [error: Error];
}

const STATUS_TEXT: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    426: 'Upgrade Required',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
};

function abortHandshake(socket: Socket, status: number, message: string, headers: Record<string, string> = {}): void {
    if (socket.destroyed || socket.writableEnded) {
        return;
    }
    const body = Buffer.from(`${message}\n`, 'utf8');
    const lines = [
        `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
        'Connection: close',
        'Content-Type: text/plain; charset=utf-8',
        `Content-Length: ${body.length}`,
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '',
        '',
    ];
    socket.write(Buffer.concat([Buffer.from(lines.join('\r\n'), 'latin1'), body]));
    socket.end();
}

export class WebSocketServer extends EventEmitter<WebSocketServerEvents> {
    /** Every open connection. Maintained by the server; do not mutate. */
    readonly clients = new Set<WebSocketConnection>();

    #server: UpgradableServer;
    #options: WebSocketServerOptions;
    #connectionOptions: ConnectionOptions;
    #onUpgrade: (req: IncomingMessage, socket: Socket, head: Buffer) => void;
    #detached = false;

    constructor(server: UpgradableServer, options: WebSocketServerOptions) {
        super();
        this.#server = server;
        this.#options = options;
        this.#connectionOptions = {
            maxPayload: options.maxPayload ?? 1024 * 1024,
            closeTimeoutMs: options.closeTimeoutMs ?? 10_000,
            protocol: null,
        };
        this.#onUpgrade = (req, socket, head) => {
            void this.#handleUpgrade(req, socket, head);
        };
        server.on('upgrade', this.#onUpgrade);
    }

    /**
     * Ping every client on an interval and drop the ones that stop answering.
     *
     * A TCP connection to a machine that lost power, slept, or changed network
     * stays `OPEN` indefinitely -- nothing arrives, nothing errors, and
     * `readyState` is a statement about this end only. The pong is the only
     * evidence the peer is still there.
     *
     * @param intervalMs how often to ping.
     * @param misses how many unanswered pings end the connection. Default 2.
     * @returns a function that stops the heartbeat.
     */
    heartbeat(intervalMs: number, { misses = 2 }: { misses?: number } = {}): () => void {
        const timer = setInterval(() => {
            for (const client of this.clients) {
                if (client.missedPongs >= misses) {
                    // terminate, not close: a peer that is not answering pings
                    // will not answer a close handshake either, so waiting for
                    // one only delays reclaiming the socket.
                    client.terminate();
                    continue;
                }
                client.missedPongs += 1;
                client.ping();
            }
        }, intervalMs);
        // A heartbeat must not be what keeps a process alive. Without this,
        // every consumer has to remember to unref or their CLI never exits.
        timer.unref();
        return () => clearInterval(timer);
    }

    /** Stop handling upgrades. Existing connections are left alone. */
    detach(): void {
        if (this.#detached) {
            return;
        }
        this.#detached = true;
        this.#server.off('upgrade', this.#onUpgrade);
    }

    /** Stop handling upgrades and close every open connection. */
    close(code = 1001, reason = 'Server shutting down'): void {
        this.detach();
        for (const client of [...this.clients]) {
            client.close(code, reason);
        }
    }

    async #handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
        // Until a connection owns it, nothing is listening for this socket's
        // errors -- and an 'error' with no listener is a process crash. A peer
        // that resets mid-handshake must not be able to take the host down.
        const ignoreError = (): void => {};
        socket.on('error', ignoreError);

        if (this.#options.path !== undefined) {
            const pathname = (req.url ?? '/').split('?')[0];
            if (pathname !== this.#options.path) {
                if (this.#options.onPathMismatch === 'reject') {
                    abortHandshake(socket, 404, 'No WebSocket endpoint at this path');
                } else {
                    // Leave the socket untouched for another listener --
                    // including its error handler, which is not ours to own.
                    socket.off('error', ignoreError);
                }
                return;
            }
        }

        const inspection = inspectHandshake(req);
        if (!inspection.ok) {
            abortHandshake(socket, inspection.status, inspection.message, inspection.headers);
            return;
        }

        // `head` is whatever the client pipelined in the SAME segment as its
        // request -- allowed by RFC 6455, and Node hands it over here because
        // it has already removed those bytes from the stream. Nothing else
        // will ever deliver them, so they are carried to the connection by
        // hand.
        //
        // Bytes in a LATER segment need no handling, and this originally had a
        // `data` collector for them. It was removed after a sabotage run
        // showed the collector was not load-bearing: the socket is PAUSED
        // here, so Node buffers further data and releases it when the
        // connection attaches its own listener. Keeping the collector was
        // worse than redundant -- it put the socket into flowing mode and
        // accumulated an unbounded array for as long as `verify` ran, which is
        // an unbounded buffer for an UNAUTHENTICATED peer. Paused, the socket
        // fills to its high-water mark and then stops reading, which is the
        // backpressure we want on exactly that peer.
        let verified: Record<string, unknown> = {};
        if (this.#options.verify) {
            let result: VerifyResult;
            try {
                result = await this.#options.verify(req);
            } catch (error) {
                this.#reportError(error instanceof Error ? error : new Error(String(error)));
                abortHandshake(socket, 500, 'Handshake verification failed');
                return;
            }
            if (result === false) {
                abortHandshake(socket, 403, 'Forbidden');
                return;
            }
            if (typeof result === 'number') {
                abortHandshake(socket, result, STATUS_TEXT[result] ?? 'Refused');
                return;
            }
            if (result !== true) {
                verified = result;
            }
        }

        if (socket.destroyed) {
            return;
        }

        const protocol = negotiateProtocol(inspection.protocols, this.#options.protocols);
        const responseLines = [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${acceptKey(inspection.key)}`,
        ];
        if (protocol !== null) {
            responseLines.push(`Sec-WebSocket-Protocol: ${protocol}`);
        }
        responseLines.push('', '');
        socket.write(responseLines.join('\r\n'));

        socket.off('error', ignoreError);

        const connection = new WebSocketConnection(
            socket,
            req,
            { ...this.#connectionOptions, protocol },
            head,
        );
        this.clients.add(connection);
        connection.on('close', () => this.clients.delete(connection));
        this.emit('connection', connection, req, verified);
        // Only now: a frame the client pipelined behind its handshake is
        // already buffered, and parsing it before the listeners above exist
        // would deliver it to nobody.
        connection.start();
    }

    /** Same no-listener guard as the connection's: see `WebSocketConnection`. */
    #reportError(error: Error): void {
        if (this.listenerCount('error') > 0) {
            this.emit('error', error);
        }
    }
}

/**
 * Serve WebSocket connections on an existing HTTP server.
 *
 * ```ts
 * const http = createServer();
 * const ws = attachWebSocketServer(http, {
 *     path: '/remote',
 *     verify: async (req) => {
 *         const pin = new URL(req.url ?? '/', 'http://x').searchParams.get('pin');
 *         return pin && (await pins.claim(pin)) ? { pin } : 401;
 *     },
 * });
 *
 * ws.on('connection', (socket, _req, verified) => {
 *     socket.on('message', (data) => socket.send(`echo: ${data}`));
 * });
 * ws.heartbeat(30_000);
 * ```
 */
export function attachWebSocketServer(
    server: UpgradableServer,
    options: WebSocketServerOptions = {},
): WebSocketServer {
    return new WebSocketServer(server, options);
}
