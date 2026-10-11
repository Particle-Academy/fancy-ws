/**
 * fancy-ws — a WebSocket server for Node with zero runtime dependencies.
 *
 * Node ships a WebSocket CLIENT (the `WebSocket` global, from undici) and no
 * server. This is the server half: RFC 6455 framing over `node:http`'s
 * `upgrade` event, using nothing but `node:http`, `node:net`, `node:crypto`
 * and `node:events`.
 */
export { attachWebSocketServer, WebSocketServer } from './server.js';
export type {
    UpgradableServer,
    VerifyResult,
    WebSocketServerEvents,
    WebSocketServerOptions,
} from './server.js';

export { READY_STATE, WebSocketConnection } from './connection.js';
export type { ConnectionOptions, WebSocketConnectionEvents } from './connection.js';

// The codec and the handshake rules are exported because they are useful on
// their own -- a consumer that owns its own socket (a reverse proxy, a test
// harness, a non-HTTP transport) needs the framing without the server.
export {
    OPCODE,
    ProtocolError,
    decodeFrame,
    decodeUtf8,
    encodeFrame,
    isControl,
    isValidCloseCode,
} from './frame.js';
export type { DecodeOptions, DecodedFrame, Opcode } from './frame.js';

export { WEBSOCKET_GUID, acceptKey, inspectHandshake, negotiateProtocol } from './handshake.js';
export type { HandshakeInspection } from './handshake.js';
