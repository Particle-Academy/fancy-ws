/**
 * Smoke-test the BUILT artifact, through both entry points.
 *
 * The suite imports `src/`, so it says nothing about what a consumer receives:
 * a wrong `exports` map, a dts that does not resolve, or an ESM-only build
 * required from CJS all pass a green suite and fail on install. This imports
 * `dist/` the two ways the manifest advertises and opens a real connection
 * through each.
 *
 *   node scripts/smoke.mjs
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';

const require = createRequire(import.meta.url);

const checks = [];
function check(name, ok, detail = '') {
    checks.push({ name, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

/** Open a server with `attach`, round-trip one message, return what came back. */
async function roundTrip(attach) {
    const http = createServer();
    const ws = attach(http, { path: '/smoke', verify: () => ({ who: 'smoke' }) });
    const seen = [];
    ws.on('connection', (socket, _req, verified) => {
        seen.push(verified);
        socket.on('message', (data) => socket.send(`echo:${data}`));
    });
    await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address();

    const client = new WebSocket(`ws://127.0.0.1:${port}/smoke`);
    const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out')), 5000);
        client.addEventListener('open', () => client.send('hello'));
        client.addEventListener('message', (event) => {
            clearTimeout(timer);
            resolve(event.data);
        });
        client.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error('client error'));
        });
    });
    client.close();
    ws.close();
    await new Promise((resolve) => http.close(resolve));
    return { reply, verified: seen[0] };
}

// 1. ESM, the way `exports.import` advertises.
const esm = await import('../dist/index.js');
check('ESM import exposes attachWebSocketServer', typeof esm.attachWebSocketServer === 'function');
check('ESM import exposes WebSocketConnection', typeof esm.WebSocketConnection === 'function');
check('ESM import exposes the frame codec', typeof esm.encodeFrame === 'function' && typeof esm.decodeFrame === 'function');

const esmResult = await roundTrip(esm.attachWebSocketServer);
check('ESM build round-trips a message', esmResult.reply === 'echo:hello', `got ${JSON.stringify(esmResult.reply)}`);
check('ESM build hands verify output to the listener', esmResult.verified?.who === 'smoke');

// 2. CJS, the way `exports.require` advertises. A named require from a CJS
//    bundle is the exact thing that broke on another package in this estate,
//    so it is asserted rather than assumed.
const cjs = require('../dist/index.cjs');
check('CJS require exposes attachWebSocketServer', typeof cjs.attachWebSocketServer === 'function');
const cjsResult = await roundTrip(cjs.attachWebSocketServer);
check('CJS build round-trips a message', cjsResult.reply === 'echo:hello', `got ${JSON.stringify(cjsResult.reply)}`);

// 3. Zero runtime dependencies, read off the manifest rather than claimed.
const manifest = require('../package.json');
const runtimeDeps = Object.keys(manifest.dependencies ?? {});
const peerDeps = Object.keys(manifest.peerDependencies ?? {});
check('no runtime dependencies', runtimeDeps.length === 0, runtimeDeps.join(', ') || 'none');
check('no peer dependencies', peerDeps.length === 0, peerDeps.join(', ') || 'none');

// 4. The bundle imports nothing but Node builtins. The claim is about the
//    ARTIFACT, so it is checked against the artifact's own text and against
//    Node's own list of builtins -- not against a list written here, which
//    would only record what someone expected.
//
//    Note the specifiers are BARE (`events`, `crypto`) even though the source
//    writes `node:events`: tsup strips the prefix, and every bundled package
//    in this kit ships that way (verified against fancy-pty's dist). It is
//    safe -- Node resolves builtins ahead of node_modules for both `require`
//    and bare ESM specifiers, so a userland package of the same name cannot
//    shadow one -- but it means an auditor reading the TARBALL sees different
//    specifiers than the source, which is worth knowing before filing it as a
//    finding.
const { readFileSync } = await import('node:fs');
const { builtinModules } = await import('node:module');
const builtins = new Set(builtinModules);
const bundle = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
const imports = [...bundle.matchAll(/(?:from|require\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
const foreign = [
    ...new Set(
        imports.filter(
            (id) => !id.startsWith('.') && !builtins.has(id) && !builtins.has(id.replace(/^node:/, '')),
        ),
    ),
];
check('bundle imports only Node builtins', foreign.length === 0, foreign.join(', ') || 'none');
check(
    'bundle imports at least one builtin (the check above can see them)',
    imports.some((id) => builtins.has(id.replace(/^node:/, ''))),
    [...new Set(imports.filter((id) => !id.startsWith('.')))].join(', '),
);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
