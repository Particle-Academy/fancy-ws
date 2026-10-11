import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';

import { acceptKey, inspectHandshake, negotiateProtocol } from '../handshake.js';

function request(headers: Record<string, string>, method = 'GET'): IncomingMessage {
    return { method, url: '/', headers } as unknown as IncomingMessage;
}

const VALID = {
    upgrade: 'websocket',
    connection: 'Upgrade',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'sec-websocket-version': '13',
};

describe('acceptKey', () => {
    it('matches the worked example in RFC 6455 section 1.3', () => {
        // A golden vector from the specification itself, rather than from our
        // own implementation. If the GUID or the digest were wrong, a test
        // computing the expected value the same way would agree with the bug.
        expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    });
});

describe('inspectHandshake', () => {
    it('accepts a valid handshake', () => {
        const result = inspectHandshake(request(VALID));
        expect(result).toEqual({ ok: true, key: 'dGhlIHNhbXBsZSBub25jZQ==', protocols: [] });
    });

    it('accepts the Upgrade header in any case, and inside a Connection list', () => {
        const result = inspectHandshake(
            request({ ...VALID, upgrade: 'WebSocket', connection: 'keep-alive, Upgrade' }),
        );
        expect(result.ok).toBe(true);
    });

    it('refuses a non-GET method', () => {
        expect(inspectHandshake(request(VALID, 'POST'))).toMatchObject({ ok: false, status: 405 });
    });

    it.each([
        ['a missing Upgrade header', { upgrade: undefined }],
        ['the wrong Upgrade token', { upgrade: 'h2c' }],
        ['a missing Connection header', { connection: undefined }],
        ['a Connection header without upgrade', { connection: 'keep-alive' }],
    ])('refuses %s with a 400', (_label, overrides) => {
        const headers = { ...VALID, ...overrides } as Record<string, string>;
        expect(inspectHandshake(request(headers))).toMatchObject({ ok: false, status: 400 });
    });

    it('answers an unsupported version with 426 AND the version it speaks', () => {
        const result = inspectHandshake(request({ ...VALID, 'sec-websocket-version': '8' }));
        expect(result).toMatchObject({ ok: false, status: 426 });
        expect(result.ok === false && result.headers).toEqual({ 'Sec-WebSocket-Version': '13' });
    });

    it('reports the version before the key, so a draft client gets an actionable answer', () => {
        const result = inspectHandshake({
            method: 'GET',
            url: '/',
            headers: { ...VALID, 'sec-websocket-version': '8', 'sec-websocket-key': 'nope' },
        } as unknown as IncomingMessage);
        expect(result).toMatchObject({ status: 426 });
    });

    it.each([
        ['missing', undefined],
        ['not base64 of 16 bytes', 'c2hvcnQ='],
        ['too long', Buffer.alloc(24).toString('base64')],
    ])('refuses a Sec-WebSocket-Key that is %s', (_label, key) => {
        const headers: Record<string, string> = { ...VALID };
        if (key === undefined) {
            delete headers['sec-websocket-key'];
        } else {
            headers['sec-websocket-key'] = key;
        }
        expect(inspectHandshake(request(headers))).toMatchObject({ ok: false, status: 400 });
    });

    it('parses the offered subprotocols', () => {
        const result = inspectHandshake(request({ ...VALID, 'sec-websocket-protocol': 'genie.v1, chat ,' }));
        expect(result.ok === true && result.protocols).toEqual(['genie.v1', 'chat']);
    });
});

describe('negotiateProtocol', () => {
    it('picks the server\'s first supported protocol that the client offered', () => {
        expect(negotiateProtocol(['chat', 'genie.v1'], ['genie.v1', 'chat'])).toBe('genie.v1');
    });

    it('never echoes a protocol the client did not offer', () => {
        // RFC 6455 4.2.2. A client seeing an unoffered value must fail the
        // connection, so echoing eagerly breaks the handshake it completes.
        expect(negotiateProtocol(['chat'], ['genie.v1'])).toBeNull();
    });

    it('stays silent when the server declares no protocols', () => {
        expect(negotiateProtocol(['chat'], undefined)).toBeNull();
        expect(negotiateProtocol(['chat'], [])).toBeNull();
    });
});
