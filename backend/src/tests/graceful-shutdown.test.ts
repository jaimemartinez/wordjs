/**
 * GRACEFUL SHUTDOWN — a termination signal drains the process instead of cutting its requests.
 *
 * SIGTERM used to call saveDatabase() and process.exit(0) at once: the requests in flight were cut and
 * /readyz kept answering 200 until the process vanished, so every deploy answered 5xx. core/graceful-
 * shutdown now marks the process draining (/readyz 503 before its cache), closes the tracked listeners
 * while letting running requests finish, cuts what is left at the timeout, flushes and exits 0.
 *
 * These tests drive the REAL module against real http servers on ephemeral ports.
 *
 * MUTATION PROOF: exit before closing the servers — the slow request is cut and its test fails; drop
 * the isDraining check in createReadinessProbe — the cached 200 is served and the readiness test
 * fails; drop the closeAllConnections timer — the stuck-request test never settles; close the
 * closeLast server in the first phase — the ordering test sees it closed first.
 */

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const gs = require('../core/graceful-shutdown');
const { createReadinessProbe } = require('../core/readiness');

function listen(handler: (req: any, res: any) => void): Promise<{ server: any; port: number }> {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

function get(port: number, path = '/'): Promise<{ status: number; body: string; connection?: string }> {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path, agent: false }, (res: any) => {
            let body = '';
            res.on('data', (c: any) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body, connection: res.headers.connection }));
        }).on('error', reject);
    });
}

const env = (over: Record<string, string> = {}) => ({ WORDJS_SHUTDOWN_DRAIN_DELAY_MS: '0', WORDJS_SHUTDOWN_TIMEOUT_MS: '2000', ...over });

describe('graceful shutdown', () => {
    beforeEach(() => gs.resetForTests());

    test('a request in flight finishes; new connections are refused; then it flushes and exits 0', async () => {
        let release: () => void = () => {};
        const { server, port } = await listen((req, res) => {
            if (req.url === '/slow') { release = () => res.end('done'); return; }
            res.end('ok');
        });
        gs.trackServer(server);
        const slow = get(port, '/slow');
        await new Promise((r) => setTimeout(r, 50)); // the slow request is now in flight

        const calls: string[] = [];
        const stopped = gs.shutdown('SIGTERM', { env: env(), flush: () => calls.push('flush'), exit: (c: number) => calls.push(`exit:${c}`) });
        assert.strictEqual(gs.isDraining(), true);
        await new Promise((r) => setTimeout(r, 50));
        await assert.rejects(get(port, '/'), 'the closed listener accepts no new connection');
        assert.deepStrictEqual(calls, [], 'nothing exits while a request is running');

        release();
        const res = await slow;
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body, 'done', 'the request in flight was answered, not cut');
        await stopped;
        assert.deepStrictEqual(calls, ['flush', 'exit:0']);
    });

    test('a response sent while draining says Connection: close', async () => {
        let release: () => void = () => {};
        const { server, port } = await listen((_req, res) => { release = () => res.end('x'); });
        gs.trackServer(server);
        const pending = get(port);
        await new Promise((r) => setTimeout(r, 50));
        const stopped = gs.shutdown('SIGTERM', { env: env(), exit: () => {} });
        release();
        // The header is set on 'request'; this request arrived before the drain, so it is decided by
        // whether the response was still unsent — it was.
        await pending;
        await stopped;
        const { server: s2, port: p2 } = await listen((_req, res) => res.end('y'));
        gs.trackServer(s2); // draining is still set: a response from a tracked server now closes
        const r2 = await get(p2);
        assert.strictEqual(r2.connection, 'close');
        s2.close();
    });

    test('a request that never ends is cut at the timeout, and the process still exits', async () => {
        const { server, port } = await listen(() => { /* never answers */ });
        gs.trackServer(server);
        const stuck = get(port).catch(() => 'cut');
        await new Promise((r) => setTimeout(r, 50));
        let code: number | null = null;
        const t0 = Date.now();
        await gs.shutdown('SIGTERM', { env: env({ WORDJS_SHUTDOWN_TIMEOUT_MS: '200' }), exit: (c: number) => { code = c; } });
        assert.strictEqual(code, 0);
        assert.ok(Date.now() - t0 < 1500, 'bounded by the timeout');
        assert.strictEqual(await stuck, 'cut');
    });

    test('an open event stream is ended at once instead of holding the drain until the timeout', async () => {
        const { server, port } = await listen((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: hello\n\n');
        });
        gs.trackServer(server);
        // A keep-alive agent, like a browser's: the socket outlives the response.
        const agent = new http.Agent({ keepAlive: true });
        const stream = new Promise<{ body: string }>((resolve, reject) => {
            http.get({ host: '127.0.0.1', port, path: '/events', agent }, (res: any) => {
                let body = '';
                res.on('data', (c: any) => { body += c; });
                res.on('end', () => resolve({ body }));
            }).on('error', reject);
        });
        await new Promise((r) => setTimeout(r, 50));
        const t0 = Date.now();
        await gs.shutdown('SIGTERM', { env: env({ WORDJS_SHUTDOWN_TIMEOUT_MS: '5000' }), exit: () => {} });
        assert.ok(Date.now() - t0 < 2000, 'not held until the 5 s timeout');
        assert.match((await stream).body, /data: hello/, 'the stream ended cleanly, not cut');
        agent.destroy();
    });

    test('an upgraded connection (WebSocket) is closed instead of holding the drain until the timeout', async () => {
        const net = require('net');
        const { server, port } = await listen((_q, r) => r.end());
        server.on('upgrade', (_req: any, socket: any) => {
            socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        });
        gs.trackServer(server);
        const client = net.connect(port, '127.0.0.1');
        const closed = new Promise<void>((resolve) => client.on('close', () => resolve()));
        client.on('error', () => { /* destroyed by the server */ });
        await new Promise<void>((resolve) => {
            client.once('data', () => resolve());
            client.write('GET /hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        });
        const t0 = Date.now();
        await gs.shutdown('SIGTERM', { env: env({ WORDJS_SHUTDOWN_TIMEOUT_MS: '5000' }), exit: () => {} });
        assert.ok(Date.now() - t0 < 2000, 'not held until the 5 s timeout');
        await closed;
    });

    test('the closeLast listener closes only after the others are done', async () => {
        const order: string[] = [];
        const a = await listen((_q, r) => r.end());
        const b = await listen((_q, r) => r.end());
        a.server.on('close', () => order.push('public'));
        b.server.on('close', () => order.push('loopback'));
        gs.trackServer(b.server, { closeLast: true });
        gs.trackServer(a.server);
        await gs.shutdown('SIGTERM', { env: env(), exit: () => {} });
        assert.deepStrictEqual(order, ['public', 'loopback']);
    });

    test('shutdown is idempotent and the drain delay is waited first', async () => {
        const slept: number[] = [];
        let exits = 0;
        const opts = { env: env({ WORDJS_SHUTDOWN_DRAIN_DELAY_MS: '1234' }), sleep: async (ms: number) => { slept.push(ms); }, exit: () => { exits++; } };
        const p1 = gs.shutdown('SIGTERM', opts);
        const p2 = gs.shutdown('SIGINT', opts);
        assert.strictEqual(p1, p2);
        await p1;
        assert.deepStrictEqual(slept, [1234]);
        assert.strictEqual(exits, 1);
    });

    test('defaults: no delay outside Kubernetes, 5 s inside; timeouts are clamped', () => {
        assert.strictEqual(gs.drainDelayMs({}), 0);
        assert.strictEqual(gs.drainDelayMs({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }), 5000);
        assert.strictEqual(gs.drainDelayMs({ WORDJS_SHUTDOWN_DRAIN_DELAY_MS: '999999' }), 60000);
        assert.strictEqual(gs.drainDelayMs({ WORDJS_SHUTDOWN_DRAIN_DELAY_MS: 'abc' }), 0);
        assert.strictEqual(gs.shutdownTimeoutMs({}), 10000);
        assert.strictEqual(gs.shutdownTimeoutMs({ WORDJS_SHUTDOWN_TIMEOUT_MS: '-5' }), 0);
    });

    test('in a real process, SIGTERM lets the request in flight finish, then exits 0 after flushing', async () => {
        const { spawn } = require('child_process');
        const path = require('path');
        const mod = path.join(__dirname, '..', 'core', 'graceful-shutdown.ts').replace(/\\/g, '/');
        const script = `
            const http = require('http');
            const gs = require(${JSON.stringify(mod)});
            let release = null;
            const server = gs.trackServer(http.createServer((req, res) => { release = () => res.end('done'); process.send('in-flight'); }));
            gs.installSignalHandlers({ flush: () => process.send('flush') });
            process.on('message', (m) => { if (m === 'term') process.emit('SIGTERM', 'SIGTERM'); if (m === 'release') release(); });
            server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));`;
        const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], { env: { ...process.env, WORDJS_SHUTDOWN_DRAIN_DELAY_MS: '0', WORDJS_SHUTDOWN_TIMEOUT_MS: '5000' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
        const seen: string[] = [];
        const next = (pred: (m: any) => boolean) => new Promise<any>((resolve) => {
            const on = (m: any) => { if (pred(m)) { child.off('message', on); resolve(m); } };
            child.on('message', on);
        });
        child.on('message', (m: any) => { if (typeof m === 'string') seen.push(m); });
        const exited = new Promise<number>((resolve) => child.on('exit', (code: number) => resolve(code)));
        const guard = setTimeout(() => child.kill(), 30000); // never leave a child behind
        after(() => { clearTimeout(guard); if (child.exitCode === null) child.kill(); });
        const { port } = await next((m) => m && m.port);
        const req = get(port, '/slow');
        await next((m) => m === 'in-flight');
        child.send('term');
        await new Promise((r) => setTimeout(r, 200));
        assert.ok(!seen.includes('flush'), 'nothing is flushed while the request runs');
        child.send('release');
        const res = await req;
        assert.strictEqual(res.body, 'done');
        assert.strictEqual(await exited, 0);
        assert.ok(seen.includes('flush'));
    });

    test('index.ts, monolith.js and the split supervisor are wired to it', () => {
        const fs = require('fs');
        const path = require('path');
        const index = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
        assert.match(index, /graceful-shutdown'\)\.installSignalHandlers\(/);
        assert.match(index, /graceful-shutdown'\)\.trackServer\(server\)/);
        assert.match(index, /isDraining: \(\) => require\('\.\/core\/graceful-shutdown'\)\.isDraining\(\)/);
        assert.doesNotMatch(index, /process\.on\('SIGTERM'/, 'no handler that exits without draining');
        const mono = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'monolith.js'), 'utf8');
        assert.match(mono, /trackServer\(server\);/);
        assert.match(mono, /trackServer\(installClientAbortGuard\(http\.createServer\(backendApp\)\), \{ closeLast: true \}\)/);
        const sup = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
        assert.match(sup, /child\.kill\(sig\)/, 'the split supervisor passes the signal on instead of dying under the app');
    });

    test('/readyz answers 503 draining at once, even over a cached 200', async () => {
        let draining = false;
        const probe = createReadinessProbe({
            isInstalled: () => true, isBooted: () => true, isDraining: () => draining,
            checkDatabase: async () => ({ status: 'OK' }), ttlMs: 60000,
        });
        assert.strictEqual((await probe()).statusCode, 200);
        draining = true;
        const r = await probe();
        assert.strictEqual(r.statusCode, 503);
        assert.strictEqual(r.body.status, 'draining');
    });
});
