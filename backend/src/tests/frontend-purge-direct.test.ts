/**
 * NO REGRESSION on the DIRECT purge path (monolith + single-host split).
 *
 * The cross-machine work rerouted CLUSTER purges through the gateway. The two deployments that already
 * worked must keep working EXACTLY as before — a publish on a monolith or a co-located split has to
 * reach the frontend's /api/revalidate immediately, with the shared secret, without a gateway hop.
 *
 * This drives the real module end to end: the content hook's entry point (purgeFrontend), the 1.5 s
 * debounce, the transport choice, and a genuine HTTP request into a stub frontend — no mocked sockets.
 *
 * MUTATION PROOF: make purgeTransport return the gateway branch unconditionally and every test here
 * times out (nothing arrives at either stub). Drop the `x-revalidate-secret` header and the first test
 * fails. Delete the monolith branch and the last test's purge lands on the dead split URL instead.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// A stub frontend that resolves as soon as it is purged.
function stubFrontend() {
    const received: any[] = [];
    const waiters: any[] = [];
    const server = http.createServer((req: any, res: any) => {
        let body = '';
        req.on('data', (c: any) => (body += c));
        req.on('end', () => {
            const hit = { url: req.url, method: req.method, secret: req.headers['x-revalidate-secret'], body };
            received.push(hit);
            waiters.splice(0).forEach((w: any) => w(hit));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"revalidated":true}');
        });
    });
    // Always waits for the NEXT arrival (never resolves with one already seen), so a test can assert
    // "exactly one more request" after a burst.
    const next = (ms = 8000) => new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no purge arrived within ${ms}ms`)), ms);
        waiters.push((hit: any) => { clearTimeout(timer); resolve(hit); });
    });
    return { server, received, next };
}
const listen = (server: any) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server: any) => new Promise<void>((r) => (server ? server.close(() => r()) : r()));

describe('direct purge — monolith and single-host split reach the frontend as before', () => {
    let dir: string;
    let cwd: string;
    let split: any;      // the co-located frontend named by config.frontendUrl
    let mono: any;       // the in-process Next server a monolith answers on (process.env.PORT)
    let monoPort: number;
    let purgeFrontend: any;

    before(async () => {
        cwd = process.cwd();
        split = stubFrontend();
        mono = stubFrontend();
        const splitPort = await listen(split.server);
        monoPort = await listen(mono.server);

        // A site config exactly like a single-host split: co-located frontend, no cluster enrollment.
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-purge-direct-'));
        fs.writeFileSync(path.join(dir, 'wordjs-config.json'), JSON.stringify({
            installedAt: new Date().toISOString(),
            dbDriver: 'sqlite-native',
            siteUrl: 'http://localhost:3000',
            frontendUrl: `http://127.0.0.1:${splitPort}`,
            revalidateSecret: 'lab-secret',
        }));
        // configManager resolves its config path from the cwd at load time, so move first and require
        // the module under test only afterwards.
        process.chdir(dir);
        ({ purgeFrontend } = require('../core/frontend-purge'));
    });

    after(async () => {
        process.chdir(cwd);
        await close(split.server);
        await close(mono.server);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    test('a content change reaches the co-located frontend, authenticated, within the debounce window', async () => {
        purgeFrontend(['posts', 'post:hello'], ['/', '/hello']);
        const hit = await split.next();
        assert.strictEqual(hit.url, '/api/revalidate');
        assert.strictEqual(hit.method, 'POST');
        assert.strictEqual(hit.secret, 'lab-secret', 'the shared secret still authenticates the purge');
        assert.deepStrictEqual(JSON.parse(hit.body), { tags: ['posts', 'post:hello'], paths: ['/', '/hello'] });
    });

    test('bursts are coalesced: 50 queued changes still produce ONE request', async () => {
        const seen = split.received.length;
        for (let i = 0; i < 50; i++) purgeFrontend([`post:${i}`], [`/p${i}`]);
        await split.next();
        await new Promise((r) => setTimeout(r, 400));
        assert.strictEqual(split.received.length, seen + 1, 'the 1.5s debounce still coalesces');
    });

    test('monolith purges its OWN port, ignoring the split-mode frontendUrl', async () => {
        const seenSplit = split.received.length;
        const prevMode = process.env.WORDJS_MODE;
        const prevPort = process.env.PORT;
        process.env.WORDJS_MODE = 'mono';
        process.env.PORT = String(monoPort);
        try {
            purgeFrontend(['settings'], ['/']);
            const hit = await mono.next();
            assert.strictEqual(hit.url, '/api/revalidate');
            assert.ok(hit.secret, 'the monolith still authenticates its own purge');
            assert.strictEqual(split.received.length, seenSplit, 'nothing went to the split-mode address');
        } finally {
            if (prevMode === undefined) delete process.env.WORDJS_MODE; else process.env.WORDJS_MODE = prevMode;
            if (prevPort === undefined) delete process.env.PORT; else process.env.PORT = prevPort;
        }
    });
});
