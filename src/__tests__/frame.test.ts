import { describe, expect, it } from 'vitest';

import {
    OPCODE,
    ProtocolError,
    decodeFrame,
    decodeUtf8,
    encodeFrame,
    isControl,
    isValidCloseCode,
} from '../frame.js';
import { maskedFrame } from './raw-client.js';

const SERVER_READ = { mask: 'required', maxPayload: 1024 * 1024 } as const;
const CLIENT_READ = { mask: 'forbidden', maxPayload: 1024 * 1024 } as const;

describe('encodeFrame', () => {
    it('uses the smallest length encoding for each boundary', () => {
        expect(encodeFrame(OPCODE.text, Buffer.alloc(125)).length).toBe(2 + 125);
        expect(encodeFrame(OPCODE.text, Buffer.alloc(126)).length).toBe(4 + 126);
        expect(encodeFrame(OPCODE.text, Buffer.alloc(0xffff)).length).toBe(4 + 0xffff);
        expect(encodeFrame(OPCODE.text, Buffer.alloc(0x10000)).length).toBe(10 + 0x10000);
    });

    it('never sets the mask bit', () => {
        const frame = encodeFrame(OPCODE.text, Buffer.from('hello'));
        expect((frame[1] as number) & 0x80).toBe(0);
    });

    it('sets FIN by default and clears it on request', () => {
        expect((encodeFrame(OPCODE.text, Buffer.alloc(0))[0] as number) & 0x80).toBe(0x80);
        expect((encodeFrame(OPCODE.text, Buffer.alloc(0), false)[0] as number) & 0x80).toBe(0);
    });
});

describe('decodeFrame', () => {
    it('round-trips a server frame at every length boundary', () => {
        for (const size of [0, 1, 125, 126, 0xffff, 0x10000]) {
            const payload = Buffer.alloc(size, 0xab);
            const decoded = decodeFrame(encodeFrame(OPCODE.binary, payload), CLIENT_READ);
            expect(decoded).not.toBeNull();
            expect(decoded?.opcode).toBe(OPCODE.binary);
            expect(decoded?.payload.length).toBe(size);
            expect(decoded?.payload.equals(payload)).toBe(true);
        }
    });

    it('unmasks a client frame', () => {
        const payload = Buffer.from('the quick brown fox', 'utf8');
        const decoded = decodeFrame(maskedFrame(OPCODE.text, payload), SERVER_READ);
        expect(decoded?.payload.toString('utf8')).toBe('the quick brown fox');
    });

    it('returns null — not an error — at every truncation point', () => {
        const frame = maskedFrame(OPCODE.text, Buffer.alloc(200, 1));
        for (let cut = 0; cut < frame.length; cut += 1) {
            expect(decodeFrame(frame.subarray(0, cut), SERVER_READ)).toBeNull();
        }
        expect(decodeFrame(frame, SERVER_READ)).not.toBeNull();
    });

    it('reports how many bytes it consumed, so a pipelined frame survives', () => {
        const first = maskedFrame(OPCODE.text, Buffer.from('one'));
        const second = maskedFrame(OPCODE.text, Buffer.from('two'));
        const decoded = decodeFrame(Buffer.concat([first, second]), SERVER_READ);
        expect(decoded?.consumed).toBe(first.length);
    });

    it('refuses an unmasked frame from a client', () => {
        const error = grabError(() => decodeFrame(encodeFrame(OPCODE.text, Buffer.from('x')), SERVER_READ));
        expect(error.code).toBe(1002);
        expect(error.message).toMatch(/must be masked/);
    });

    it('refuses a masked frame from a server', () => {
        const error = grabError(() => decodeFrame(maskedFrame(OPCODE.text, Buffer.from('x')), CLIENT_READ));
        expect(error.code).toBe(1002);
        expect(error.message).toMatch(/must not be masked/);
    });

    it.each([0x10, 0x20, 0x40])('refuses a set RSV bit (0x%s)', (bit) => {
        const frame = maskedFrame(OPCODE.text, Buffer.from('x'));
        frame[0] = (frame[0] as number) | bit;
        expect(grabError(() => decodeFrame(frame, SERVER_READ)).code).toBe(1002);
    });

    it.each([0x3, 0x7, 0xb, 0xf])('refuses reserved opcode 0x%s', (opcode) => {
        const frame = maskedFrame(OPCODE.text, Buffer.from('x'));
        frame[0] = 0x80 | opcode;
        expect(grabError(() => decodeFrame(frame, SERVER_READ)).code).toBe(1002);
    });

    it('refuses a fragmented control frame', () => {
        const frame = maskedFrame(OPCODE.ping, Buffer.alloc(0), false);
        expect(grabError(() => decodeFrame(frame, SERVER_READ)).message).toMatch(/must not be fragmented/);
    });

    it('refuses a control frame over 125 bytes', () => {
        const frame = maskedFrame(OPCODE.ping, Buffer.alloc(126));
        expect(grabError(() => decodeFrame(frame, SERVER_READ)).message).toMatch(/125 bytes or fewer/);
    });

    it('refuses a 16-bit length that should have been 7-bit', () => {
        // 100 bytes announced with the 126 marker. A correct encoder cannot
        // produce this; a peer probing for a lenient parser can.
        const payload = Buffer.alloc(100);
        const frame = Buffer.concat([
            Buffer.from([0x81, 0x80 | 126, 0x00, 0x64]),
            Buffer.alloc(4),
            payload,
        ]);
        expect(grabError(() => decodeFrame(frame, SERVER_READ)).message).toMatch(/minimally encoded/);
    });

    it('refuses a 64-bit length that should have been 16-bit', () => {
        const header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(1000n, 2);
        const frame = Buffer.concat([header, Buffer.alloc(4), Buffer.alloc(1000)]);
        expect(grabError(() => decodeFrame(frame, SERVER_READ)).message).toMatch(/minimally encoded/);
    });

    it('rejects an oversize payload from the HEADER ALONE, before any body arrives', () => {
        // The point of the limit. This header is 10 bytes and claims a
        // terabyte; a check that waited for the body would be a memory
        // amplifier rather than a limit.
        const header = Buffer.alloc(10);
        header[0] = 0x82;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(1n << 40n, 2);
        const error = grabError(() => decodeFrame(header, { mask: 'required', maxPayload: 1024 }));
        expect(error.code).toBe(1009);
    });

    it('refuses a length no runtime can address', () => {
        const header = Buffer.alloc(10);
        header[0] = 0x82;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE((1n << 63n) - 1n, 2);
        expect(grabError(() => decodeFrame(header, SERVER_READ)).code).toBe(1009);
    });

    it('accepts a payload exactly at maxPayload', () => {
        const frame = maskedFrame(OPCODE.binary, Buffer.alloc(1024));
        expect(decodeFrame(frame, { mask: 'required', maxPayload: 1024 })?.payload.length).toBe(1024);
    });

    it('copies the payload rather than viewing the input', () => {
        const frame = maskedFrame(OPCODE.binary, Buffer.from([1, 2, 3]));
        const decoded = decodeFrame(frame, SERVER_READ);
        frame.fill(0);
        expect([...(decoded?.payload ?? [])]).toEqual([1, 2, 3]);
    });
});

describe('isControl', () => {
    it('splits data from control at 0x8', () => {
        expect([OPCODE.continuation, OPCODE.text, OPCODE.binary].map(isControl)).toEqual([false, false, false]);
        expect([OPCODE.close, OPCODE.ping, OPCODE.pong].map(isControl)).toEqual([true, true, true]);
    });
});

describe('isValidCloseCode', () => {
    it('accepts the codes a peer may send', () => {
        for (const code of [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 3000, 4999]) {
            expect(isValidCloseCode(code), `${code} should be sendable`).toBe(true);
        }
    });

    it('refuses the local-only and reserved codes', () => {
        // 1005 and 1006 are the ones that matter: they are what an application
        // REPORTS when no close frame or an abnormal end happened, so a peer
        // putting either on the wire is claiming something only the receiver
        // can know.
        for (const code of [0, 999, 1004, 1005, 1006, 1015, 1016, 2000, 2999, 5000, 65535, 1.5]) {
            expect(isValidCloseCode(code), `${code} should be refused`).toBe(false);
        }
    });
});

describe('decodeUtf8', () => {
    it('decodes valid UTF-8, multi-byte included', () => {
        expect(decodeUtf8(Buffer.from('héllo — 世界', 'utf8'))).toBe('héllo — 世界');
    });

    it('refuses invalid UTF-8 with a 1007 instead of substituting U+FFFD', () => {
        // Lenient decoding is worse than strict here: substitution turns a
        // transport error into plausible data that fails somewhere else.
        for (const bytes of [[0xc3], [0x80], [0xe2, 0x28, 0xa1], [0xf8, 0x88, 0x80, 0x80, 0x80]]) {
            const error = grabError(() => decodeUtf8(Buffer.from(bytes)));
            expect(error.code).toBe(1007);
        }
    });
});

function grabError(run: () => unknown): ProtocolError {
    try {
        run();
    } catch (error) {
        expect(error).toBeInstanceOf(ProtocolError);
        return error as ProtocolError;
    }
    throw new Error('Expected a ProtocolError, but the call returned normally');
}
