/**
 * The opening handshake: what makes an upgrade request a WebSocket one, and
 * what the 101 must say back.
 *
 * Kept away from the socket for the same reason as the frame codec -- every
 * rule here is a function of the request headers alone, so it can be asserted
 * without a port.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc6455#section-4.2
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * RFC 6455 4.2.2: the fixed GUID concatenated with the client's key before
 * hashing. It is a constant, not a secret -- the handshake proves the server
 * speaks WebSocket, never that it is authorised. Authorisation is `verify`.
 */
export const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** `Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key`. */
export function acceptKey(key: string): string {
    return createHash('sha1')
        .update(key + WEBSOCKET_GUID)
        .digest('base64');
}

export type HandshakeInspection =
    | { ok: true; key: string; protocols: string[] }
    | { ok: false; status: number; message: string; headers?: Record<string, string> };

/** Case-insensitive membership in a comma-separated header value. */
function listContains(value: string | undefined, token: string): boolean {
    if (!value) {
        return false;
    }
    return value
        .split(',')
        .some((part) => part.trim().toLowerCase() === token);
}

/**
 * Decide whether a request is a valid RFC 6455 opening handshake.
 *
 * Returns the status to answer with on refusal rather than throwing, so the
 * caller writes ONE kind of response and the rules stay readable as a list.
 */
export function inspectHandshake(req: IncomingMessage): HandshakeInspection {
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
        return { ok: false, status: 405, message: 'WebSocket handshake must be a GET' };
    }

    if ((req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
        return { ok: false, status: 400, message: 'Expected "Upgrade: websocket"' };
    }

    if (!listContains(req.headers.connection, 'upgrade')) {
        return { ok: false, status: 400, message: 'Expected "Connection: Upgrade"' };
    }

    // Version before key: a client on a draft version gets told which version
    // to speak, and that answer is useful whatever its key looks like. The
    // other order would refuse a draft client with a key complaint it cannot
    // act on.
    const version = req.headers['sec-websocket-version'];
    if (version !== '13') {
        return {
            ok: false,
            status: 426,
            message: 'Unsupported WebSocket version; this server speaks 13',
            headers: { 'Sec-WebSocket-Version': '13' },
        };
    }

    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) {
        return { ok: false, status: 400, message: 'Missing or malformed Sec-WebSocket-Key' };
    }

    const protocols = (req.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

    return { ok: true, key, protocols };
}

/**
 * Pick a subprotocol, or `null` for "do not echo one".
 *
 * RFC 6455 4.2.2 is strict here and it is the rule implementations break: the
 * server MUST NOT name a subprotocol the client did not offer. A client that
 * sees an unoffered value is required to fail the connection, so echoing
 * eagerly breaks the handshake it was meant to complete.
 */
export function negotiateProtocol(offered: string[], supported: string[] | undefined): string | null {
    if (!supported || supported.length === 0) {
        return null;
    }
    return supported.find((candidate) => offered.includes(candidate)) ?? null;
}
