/**
 * RFC 6455 frame codec. Pure functions over Buffers, no sockets, no state
 * beyond what a caller passes in -- which is the whole reason it is a separate
 * module: every framing rule below is testable without opening a port.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc6455#section-5
 */

/** Frame opcodes. Opcodes >= 0x8 are control frames. */
export const OPCODE = {
    continuation: 0x0,
    text: 0x1,
    binary: 0x2,
    close: 0x8,
    ping: 0x9,
    pong: 0xa,
} as const;

export type Opcode = (typeof OPCODE)[keyof typeof OPCODE];

const KNOWN_OPCODES: ReadonlySet<number> = new Set(Object.values(OPCODE));

/**
 * A framing or protocol violation, carrying the close code the peer must be
 * told. RFC 6455 is specific about which code goes with which violation, and
 * the code is the only part of this the peer ever sees -- so it travels with
 * the error rather than being re-derived at the catch site.
 */
export class ProtocolError extends Error {
    readonly code: number;

    constructor(code: number, message: string) {
        super(message);
        this.name = 'ProtocolError';
        this.code = code;
    }
}

export interface DecodedFrame {
    fin: boolean;
    opcode: number;
    /** Unmasked payload. A fresh Buffer -- never a view onto the input. */
    payload: Buffer;
    /** Bytes consumed from the input, so the caller can advance its buffer. */
    consumed: number;
}

export interface DecodeOptions {
    /**
     * `'required'` for frames read by a SERVER, `'forbidden'` for frames read
     * by a client. RFC 6455 5.1: a client must mask every frame it sends and a
     * server must mask none, and both directions are a 1002 when violated.
     *
     * There is no `'either'`, deliberately. Accepting both is how an
     * implementation ends up relaying an unmasked client frame -- the exact
     * case masking exists to prevent (it defeats cache poisoning through
     * intermediaries that mistake a frame for a request).
     */
    mask: 'required' | 'forbidden';
    /**
     * Largest payload accepted for a single frame. Checked against the DECLARED
     * length before any bytes are buffered, so a frame claiming 2^63 costs
     * nothing. Exceeding it is a 1009.
     */
    maxPayload: number;
}

/** Whether an opcode denotes a control frame (close / ping / pong). */
export function isControl(opcode: number): boolean {
    return (opcode & 0x8) !== 0;
}

/**
 * Encode one frame. Never masked: this package is the server half, and a
 * server that masks is as wrong as a client that does not.
 */
export function encodeFrame(opcode: number, payload: Buffer, fin = true): Buffer {
    const length = payload.length;
    let header: Buffer;

    if (length <= 125) {
        header = Buffer.allocUnsafe(2);
        header[1] = length;
    } else if (length <= 0xffff) {
        header = Buffer.allocUnsafe(4);
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.allocUnsafe(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }

    header[0] = (fin ? 0x80 : 0x00) | opcode;
    return Buffer.concat([header, payload]);
}

/**
 * Decode one frame from the front of `buf`.
 *
 * Returns `null` when more bytes are needed -- which is NOT an error and is the
 * normal case on a stream. Throws {@link ProtocolError} for a violation, and
 * the caller is expected to fail the connection with `error.code`.
 */
export function decodeFrame(buf: Buffer, options: DecodeOptions): DecodedFrame | null {
    if (buf.length < 2) {
        return null;
    }

    const first = buf[0] as number;
    const second = buf[1] as number;

    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    const lengthByte = second & 0x7f;

    // RSV1-3. We negotiate no extensions, so a set bit means the peer is
    // speaking something we did not agree to. permessage-deflate would set RSV1
    // -- which is exactly why this must refuse rather than ignore: ignoring it
    // would hand a deflated payload to a consumer as if it were the message.
    if ((first & 0x70) !== 0) {
        throw new ProtocolError(1002, 'RSV bits must be zero when no extension is negotiated');
    }

    if (!KNOWN_OPCODES.has(opcode)) {
        throw new ProtocolError(1002, `Reserved opcode 0x${opcode.toString(16)}`);
    }

    if (isControl(opcode)) {
        if (!fin) {
            throw new ProtocolError(1002, 'Control frames must not be fragmented');
        }
        if (lengthByte > 125) {
            throw new ProtocolError(1002, 'Control frame payload must be 125 bytes or fewer');
        }
    }

    if (options.mask === 'required' && !masked) {
        throw new ProtocolError(1002, 'Frames sent by a client must be masked');
    }
    if (options.mask === 'forbidden' && masked) {
        throw new ProtocolError(1002, 'Frames sent by a server must not be masked');
    }

    let offset = 2;
    let length = lengthByte;

    if (lengthByte === 126) {
        if (buf.length < offset + 2) {
            return null;
        }
        length = buf.readUInt16BE(offset);
        offset += 2;
        // 5.2: "the minimal number of bytes MUST be used to encode the
        // length". A non-minimal encoding is the signature of a peer probing
        // for a lenient parser, and accepting it means two byte sequences mean
        // the same frame -- which is a desynchronisation waiting to happen.
        if (length < 126) {
            throw new ProtocolError(1002, 'Payload length is not minimally encoded');
        }
    } else if (lengthByte === 127) {
        if (buf.length < offset + 8) {
            return null;
        }
        const big = buf.readBigUInt64BE(offset);
        offset += 8;
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new ProtocolError(1009, 'Payload length exceeds what this runtime can address');
        }
        length = Number(big);
        if (length <= 0xffff) {
            throw new ProtocolError(1002, 'Payload length is not minimally encoded');
        }
    }

    // Before buffering anything. A frame header claiming a huge length is 10
    // bytes on the wire, so a check that waited for the body to arrive would be
    // a memory amplifier rather than a limit.
    if (length > options.maxPayload) {
        throw new ProtocolError(1009, `Frame payload of ${length} bytes exceeds maxPayload`);
    }

    const maskOffset = offset;
    if (masked) {
        offset += 4;
    }

    if (buf.length < offset + length) {
        return null;
    }

    const payload = Buffer.allocUnsafe(length);
    buf.copy(payload, 0, offset, offset + length);

    if (masked) {
        const m0 = buf[maskOffset] as number;
        const m1 = buf[maskOffset + 1] as number;
        const m2 = buf[maskOffset + 2] as number;
        const m3 = buf[maskOffset + 3] as number;
        for (let i = 0; i < length; i += 1) {
            const key = i % 4 === 0 ? m0 : i % 4 === 1 ? m1 : i % 4 === 2 ? m2 : m3;
            payload[i] = (payload[i] as number) ^ key;
        }
    }

    return { fin, opcode, payload, consumed: offset + length };
}

/**
 * Close codes a peer may legitimately put on the wire.
 *
 * 1004 is undefined, 1005 and 1006 are "no status received" and "abnormal
 * closure" -- values an application reports locally and that must never be
 * SENT -- and 1015 is a TLS failure, likewise local-only. 1016-2999 are
 * reserved for future protocol use. Everything else in 3000-4999 is the
 * library/application range and is allowed through untouched.
 */
export function isValidCloseCode(code: number): boolean {
    if (!Number.isInteger(code)) {
        return false;
    }
    if (code >= 3000 && code <= 4999) {
        return true;
    }
    if (code < 1000 || code > 1015) {
        return false;
    }
    return code !== 1004 && code !== 1005 && code !== 1006 && code !== 1015;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Decode a text payload, refusing invalid UTF-8 with a 1007.
 *
 * RFC 6455 requires this rather than suggesting it, and a lenient decoder is
 * worse than a strict one in a specific way: U+FFFD substitution turns a
 * transport error into plausible-looking data, so the corruption surfaces
 * somewhere else entirely as a parse failure the consumer cannot attribute.
 */
export function decodeUtf8(payload: Buffer): string {
    try {
        return UTF8.decode(payload);
    } catch {
        throw new ProtocolError(1007, 'Text payload is not valid UTF-8');
    }
}
