/**
 * One open WebSocket connection: the frame loop, the close handshake, and the
 * guarantees a consumer gets to rely on.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

import {
    OPCODE,
    ProtocolError,
    decodeFrame,
    decodeUtf8,
    encodeFrame,
    isControl,
    isValidCloseCode,
} from './frame.js';

/** `readyState` values, matching the browser `WebSocket` constants. */
export const READY_STATE = {
    connecting: 0,
    open: 1,
    closing: 2,
    closed: 3,
} as const;

export interface WebSocketConnectionEvents {
    /**
     * A complete message, reassembled across fragments.
     *
     * `data` is a **string** for a text message and a **Buffer** for a binary
     * one, so `JSON.parse(data)` works without a decode step on the common
     * path. `isBinary` is therefore redundant with `typeof data` -- it is kept
     * because it is the shape every WebSocket library uses, and a consumer
     * switching on it should not have to learn ours.
     */
    message: [data: string | Buffer, isBinary: boolean];
    /**
     * Fired exactly once, whatever ended the connection -- a close handshake,
     * a protocol violation, a socket error, or the peer vanishing. `1006` means
     * no close frame was exchanged.
     */
    close: [code: number, reason: string];
    error: [error: Error];
    ping: [data: Buffer];
    pong: [data: Buffer];
}

export interface ConnectionOptions {
    maxPayload: number;
    /** Milliseconds to wait for the peer's close frame before destroying the socket. */
    closeTimeoutMs: number;
    /** Negotiated subprotocol, or `null` when none was agreed. */
    protocol: string | null;
}

const EMPTY = Buffer.alloc(0);

export class WebSocketConnection extends EventEmitter<WebSocketConnectionEvents> {
    static readonly CONNECTING = READY_STATE.connecting;
    static readonly OPEN = READY_STATE.open;
    static readonly CLOSING = READY_STATE.closing;
    static readonly CLOSED = READY_STATE.closed;

    /** The upgrade request this connection was created from. */
    readonly request: IncomingMessage;
    /** Negotiated subprotocol, or `null`. */
    readonly protocol: string | null;
    readonly remoteAddress: string | undefined;

    #socket: Socket;
    #options: ConnectionOptions;
    #buffer: Buffer = EMPTY;
    #readyState: number = READY_STATE.open;

    #fragmentOpcode = 0;
    #fragments: Buffer[] = [];
    #fragmentBytes = 0;

    #started = false;
    #closeSent = false;
    #closeEmitted = false;
    #closeTimer: NodeJS.Timeout | undefined;
    #peerCode = 1006;
    #peerReason = '';

    /** Consecutive pings sent with no pong back. Read by the server heartbeat. */
    missedPongs = 0;

    constructor(socket: Socket, request: IncomingMessage, options: ConnectionOptions, initialData: Buffer) {
        super();
        this.#socket = socket;
        this.request = request;
        this.#options = options;
        this.protocol = options.protocol;
        this.remoteAddress = socket.remoteAddress;

        socket.setNoDelay(true);
        socket.removeAllListeners('data');
        socket.on('data', (chunk: Buffer) => this.#onData(chunk));
        socket.on('error', (error: Error) => this.#onSocketError(error));
        socket.on('close', () => this.#finish());
        socket.on('end', () => {
            // The peer stopped writing. If it never sent a close frame this is
            // 1006 territory, which `#finish` reports.
            if (this.#readyState !== READY_STATE.closed) {
                this.#socket.destroy();
            }
        });

        // Bytes that arrived with -- or immediately after -- the upgrade
        // request. A client is allowed to pipeline frames behind its
        // handshake, and dropping them loses the first message of a session
        // while every later one arrives.
        //
        // They are BUFFERED, not parsed: `start()` is what begins parsing, and
        // the server calls it only after emitting `connection`. Parsing here
        // would emit `message` while the consumer's listener is still one
        // statement away from being attached -- which is the same lost first
        // message by a different route, and the version that looks like it
        // works because nothing reports an event with no listeners.
        this.#buffer = initialData;
    }

    /**
     * Begin parsing. Called by the server once `connection` listeners are
     * attached; calling it twice is a no-op.
     */
    start(): void {
        if (this.#started) {
            return;
        }
        this.#started = true;
        this.#parse();
    }

    get readyState(): number {
        return this.#readyState;
    }

    /**
     * Send a message. A string goes out as text, a `Uint8Array` as binary.
     *
     * Returns `false` when the socket is not open rather than throwing. A peer
     * closing between a consumer's check and its send is ordinary, not
     * exceptional, and an exception there forces every caller into a try/catch
     * that cannot do anything useful.
     */
    send(data: string | Uint8Array): boolean {
        if (this.#readyState !== READY_STATE.open) {
            return false;
        }
        const isBinary = typeof data !== 'string';
        const payload = isBinary
            ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
            : Buffer.from(data, 'utf8');
        return this.#write(encodeFrame(isBinary ? OPCODE.binary : OPCODE.text, payload));
    }

    /** Send a ping. `data` must be 125 bytes or fewer. */
    ping(data: Uint8Array | string = EMPTY): boolean {
        return this.#writeControl(OPCODE.ping, data);
    }

    /** Send an unsolicited pong. Pongs for received pings are automatic. */
    pong(data: Uint8Array | string = EMPTY): boolean {
        return this.#writeControl(OPCODE.pong, data);
    }

    /**
     * Start a clean close. The socket stays readable until the peer's close
     * frame arrives or {@link ConnectionOptions.closeTimeoutMs} elapses.
     */
    close(code = 1000, reason = ''): void {
        if (code !== 1000 && !isValidCloseCode(code)) {
            throw new RangeError(`${code} is not a close code that may be sent`);
        }
        const reasonBytes = Buffer.from(reason, 'utf8');
        if (reasonBytes.length > 123) {
            throw new RangeError('Close reason must be 123 bytes or fewer when UTF-8 encoded');
        }
        this.#sendClose(code, reasonBytes);
    }

    /** Drop the socket now, with no close handshake. Reports 1006. */
    terminate(): void {
        this.#readyState = READY_STATE.closing;
        this.#socket.destroy();
    }

    #write(frame: Buffer): boolean {
        if (this.#socket.writableEnded || this.#socket.destroyed) {
            return false;
        }
        this.#socket.write(frame);
        return true;
    }

    #writeControl(opcode: number, data: Uint8Array | string): boolean {
        const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
        if (payload.length > 125) {
            throw new RangeError('Control frame payload must be 125 bytes or fewer');
        }
        if (this.#readyState !== READY_STATE.open) {
            return false;
        }
        return this.#write(encodeFrame(opcode, payload));
    }

    #sendClose(code: number, reasonBytes: Buffer): void {
        if (this.#closeSent) {
            return;
        }
        this.#closeSent = true;
        this.#readyState = READY_STATE.closing;

        const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
        payload.writeUInt16BE(code, 0);
        reasonBytes.copy(payload, 2);
        this.#write(encodeFrame(OPCODE.close, payload));

        this.#closeTimer = setTimeout(() => this.#socket.destroy(), this.#options.closeTimeoutMs);
        // A pending close timer must never be the reason a process stays
        // alive: the work is already done by the time it fires.
        this.#closeTimer.unref();
    }

    /**
     * Report an error without ever being able to crash the consumer.
     *
     * `EventEmitter` THROWS on an `'error'` emit with no listener, so a naive
     * `emit('error', ...)` here hands any peer a way to take the process down
     * with one malformed frame -- client-controlled input deciding whether the
     * host survives. The close frame already carries the protocol verdict to
     * the peer, so a missing listener means the detail is dropped, not that
     * the connection is mishandled.
     */
    #reportError(error: Error): void {
        if (this.listenerCount('error') > 0) {
            this.emit('error', error);
        }
    }

    #onSocketError(error: Error): void {
        this.#reportError(error);
        this.#socket.destroy();
    }

    #fail(code: number, message: string): void {
        this.#reportError(new ProtocolError(code, message));
        this.#sendClose(code, Buffer.from(message, 'utf8').subarray(0, 123));
        // RFC 6455 7.1.7: after failing the connection a server does not wait
        // for the peer's close frame. The timer from #sendClose is the backstop
        // for a CLEAN close, not for this.
        this.#socket.end();
    }

    #onData(chunk: Buffer): void {
        if (this.#readyState === READY_STATE.closed) {
            return;
        }
        this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
        if (this.#started) {
            this.#parse();
        }
    }

    #parse(): void {
        for (;;) {
            let frame;
            try {
                frame = decodeFrame(this.#buffer, {
                    mask: 'required',
                    maxPayload: this.#options.maxPayload,
                });
            } catch (error) {
                const protocolError = error as ProtocolError;
                this.#fail(protocolError.code ?? 1002, protocolError.message);
                return;
            }
            if (frame === null) {
                return;
            }
            this.#buffer = this.#buffer.subarray(frame.consumed);
            if (!this.#handleFrame(frame.fin, frame.opcode, frame.payload)) {
                return;
            }
        }
    }

    /** @returns whether to keep parsing. */
    #handleFrame(fin: boolean, opcode: number, payload: Buffer): boolean {
        if (isControl(opcode)) {
            return this.#handleControl(opcode, payload);
        }

        if (opcode === OPCODE.continuation) {
            if (this.#fragmentOpcode === 0) {
                this.#fail(1002, 'Continuation frame with no message in progress');
                return false;
            }
            this.#fragmentBytes += payload.length;
            // The per-FRAME limit is enforced in the codec. This is the
            // per-MESSAGE one, and without it maxPayload is not a limit at all:
            // a peer sends maxPayload-sized fragments forever and the
            // reassembly buffer grows without bound while every individual
            // frame passes the check.
            if (this.#fragmentBytes > this.#options.maxPayload) {
                this.#fail(1009, 'Reassembled message exceeds maxPayload');
                return false;
            }
            this.#fragments.push(payload);
            if (!fin) {
                return true;
            }
            const opcodeForMessage = this.#fragmentOpcode;
            const complete = Buffer.concat(this.#fragments);
            this.#fragmentOpcode = 0;
            this.#fragments = [];
            this.#fragmentBytes = 0;
            return this.#deliver(opcodeForMessage, complete);
        }

        if (this.#fragmentOpcode !== 0) {
            this.#fail(1002, 'Expected a continuation frame');
            return false;
        }

        if (fin) {
            return this.#deliver(opcode, payload);
        }

        this.#fragmentOpcode = opcode;
        this.#fragments = [payload];
        this.#fragmentBytes = payload.length;
        if (this.#fragmentBytes > this.#options.maxPayload) {
            this.#fail(1009, 'Reassembled message exceeds maxPayload');
            return false;
        }
        return true;
    }

    #handleControl(opcode: number, payload: Buffer): boolean {
        if (opcode === OPCODE.ping) {
            this.emit('ping', payload);
            if (this.#readyState === READY_STATE.open) {
                this.#write(encodeFrame(OPCODE.pong, payload));
            }
            return true;
        }

        if (opcode === OPCODE.pong) {
            this.missedPongs = 0;
            this.emit('pong', payload);
            return true;
        }

        // Close.
        if (payload.length === 1) {
            this.#fail(1002, 'Close frame payload must be empty or at least two bytes');
            return false;
        }

        if (payload.length === 0) {
            // No status. Reported locally as 1005; echoed as an empty close,
            // because 1005 must never go on the wire.
            this.#peerCode = 1005;
            this.#peerReason = '';
            if (!this.#closeSent) {
                this.#closeSent = true;
                this.#readyState = READY_STATE.closing;
                this.#write(encodeFrame(OPCODE.close, EMPTY));
            }
            this.#socket.end();
            return false;
        }

        const code = payload.readUInt16BE(0);
        if (!isValidCloseCode(code)) {
            this.#fail(1002, `${code} is not a close code that may be sent`);
            return false;
        }
        let reason: string;
        try {
            reason = decodeUtf8(payload.subarray(2));
        } catch {
            this.#fail(1007, 'Close reason is not valid UTF-8');
            return false;
        }

        this.#peerCode = code;
        this.#peerReason = reason;
        this.#sendClose(code, payload.subarray(2, 125));
        this.#socket.end();
        return false;
    }

    #deliver(opcode: number, payload: Buffer): boolean {
        if (opcode === OPCODE.text) {
            let text: string;
            try {
                text = decodeUtf8(payload);
            } catch {
                this.#fail(1007, 'Text payload is not valid UTF-8');
                return false;
            }
            this.emit('message', text, false);
            return true;
        }
        this.emit('message', payload, true);
        return true;
    }

    #finish(): void {
        if (this.#closeEmitted) {
            return;
        }
        this.#closeEmitted = true;
        this.#readyState = READY_STATE.closed;
        if (this.#closeTimer) {
            clearTimeout(this.#closeTimer);
        }
        this.#buffer = EMPTY;
        this.#fragments = [];
        this.emit('close', this.#peerCode, this.#peerReason);
    }
}
