import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { attachWebSocketServer, type WebSocketServer, type WebSocketServerOptions } from '../server.js';

export interface Harness {
    http: Server;
    ws: WebSocketServer;
    port: number;
    url: string;
    close: () => Promise<void>;
}

/** An HTTP server on an ephemeral port with a WebSocket server attached. */
export async function startServer(options: WebSocketServerOptions = {}): Promise<Harness> {
    const http = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('plain http still works');
    });
    const ws = attachWebSocketServer(http, options);

    await new Promise<void>((resolve) => {
        http.listen(0, '127.0.0.1', resolve);
    });
    const port = (http.address() as AddressInfo).port;

    return {
        http,
        ws,
        port,
        url: `ws://127.0.0.1:${port}`,
        close: async () => {
            ws.close();
            for (const client of ws.clients) {
                client.terminate();
            }
            await new Promise<void>((resolve) => {
                http.close(() => resolve());
                // Sockets left open by a test must not hold the suite open.
                http.closeAllConnections?.();
            });
        },
    };
}

/** Resolve once an emitter fires, or reject on a timeout. */
export function once<T>(
    target: { once: (event: string, listener: (...args: never[]) => void) => unknown },
    event: string,
    timeoutMs = 3000,
): Promise<T[]> {
    return new Promise<T[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
        target.once(event, ((...args: T[]) => {
            clearTimeout(timer);
            resolve(args);
        }) as (...args: never[]) => void);
    });
}
