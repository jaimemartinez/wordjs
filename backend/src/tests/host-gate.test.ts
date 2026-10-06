/**
 * WordJS — THE HOST GATE ON THE REAL APP: which addresses the site answers, and what each address may do.
 *
 * core/host-policy.js is unit-tested on its own (host-policy.test.ts). This file is about the WIRING, so
 * it boots the REAL Express app from ../index — the mount order is the property under test: the gate must
 * run after helmet and BEFORE CORS, the limiters and CSRF; the old migration guard must be reduced to the
 * install funnel; CORS, CSRF, collab and the cookie rules must all read the same derivation. A suite that
 * built its own express() would prove none of that.
 *
 * THE WORLD. An installed site whose main address is https://example.com, declared in a throwaway
 * wordjs-config.json the process chdirs into BEFORE any application module loads (configManager reads the
 * cwd's file; the developer's real installation is never read or written). Aliases cover every class the
 * sign-in rule distinguishes: an https alias, http aliases with and without an explicit `signIn`, a tunnel
 * name, an expired name and a declared IP. supertest connects from 127.0.0.1, so a request that keeps
 * supertest's own `Host: 127.0.0.1:<port>` arrives as a TRUSTED LOOPBACK HOP (its X-Forwarded-Host and
 * X-Forwarded-Proto are honoured, like the gateway's or the monolith's SSR listener), while a request that
 * sets `Host` to a name arrives DIRECT (a browser): forwarded headers from it are ignored and the transport
 * is plain http.
 */

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('node:net');
const http = require('http');
const bcrypt = require('bcryptjs');

const ORIGINAL_CWD = process.cwd();
const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-host-gate-${process.pid}-`));
const CONFIG_FILE = path.join(TMP_INSTALL, 'wordjs-config.json');
const STAGED = {
    installedAt: '2026-01-01T00:00:00.000Z',
    dbDriver: 'sqlite-native',
    siteUrl: 'https://example.com',
    siteAliases: [
        { url: 'https://www.example.com', mode: 'serve', source: 'admin' },
        { url: 'http://intranet.example.com:8080', signIn: true, source: 'admin' },
        { url: 'http://plain.example.com', source: 'admin' },
        { url: 'https://ab12.ngrok-free.app', source: 'cli' },
        { url: 'https://retired.example.com', expiresAt: '2001-01-01T00:00:00Z', source: 'cli' },
        { url: 'http://192.168.1.77:3000', signIn: true, source: 'admin' },
    ],
    hostPolicy: { ipLiterals: 'any' },
};
const STAGED_TEXT = JSON.stringify(STAGED, null, 2);
fs.writeFileSync(CONFIG_FILE, STAGED_TEXT);
process.chdir(TMP_INSTALL);

// The policy reads these on every request; start from a known environment and put it back afterwards.
const ENV_KEYS = ['WORDJS_ALLOWED_HOSTS', 'WORDJS_IP_HOSTS', 'WORDJS_DEV_ORIGINS', 'WORDJS_TRUST_PROXY'];
const SAVED_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) { SAVED_ENV[key] = process.env[key]; delete process.env[key]; }
process.env.WORDJS_ALLOWED_HOSTS = 'env.example.com';

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-host-gate-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
// config/app reads backend/wordjs-config.json (not the staged one), so state the site-wide values the
// legacy cookie rule and the configured CORS/CSRF origins read, to match the staged site.
config.siteUrl = 'https://example.com';
config.site.url = 'https://example.com';
config.frontendUrl = 'https://example.com';
config.nodeEnv = 'production';

const request = require('supertest');
const configManager = require('../core/configManager');
const hostPolicy = require('../core/host-policy');
const database = require('../config/database');
const roles = require('../core/roles');
const app = require('../index');

const API = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
const ADMIN = 'gate-admin';
let adminId = 0;
let server: any;

assert.strictEqual(configManager.CONFIG_FILE, CONFIG_FILE, 'the staged config must be the file configManager reads');
assert.strictEqual(configManager.isInstalled(), true, 'precondition: the staged site reads as installed');

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await roles.loadRoles();
    await require('../core/post-types').initPostTypes();
    const db = database.getDbAsync();
    const r = await db.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        [ADMIN, bcrypt.hashSync(PASSWORD, 10), `${ADMIN}@example.com`, ADMIN]);
    adminId = r.lastID;
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [adminId]);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

after(async () => {
    try { await new Promise<void>((resolve) => server.close(() => resolve())); } catch { /* already closed */ }
    try { await database.closeDatabase(); } catch { /* already closed */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { fs.rmSync(f, { force: true }); } catch { /* never created */ }
    }
    for (const key of ENV_KEYS) {
        if (SAVED_ENV[key] === undefined) delete process.env[key];
        else process.env[key] = SAVED_ENV[key];
    }
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP_INSTALL, { recursive: true, force: true }); } catch { /* */ }
});

// ─── request builders ───────────────────────────────────────────────────────────────────────────────

/** A browser talking to us directly: the address is its Host, the transport is plain http. */
const direct = (method: string, url: string, host: string) => (request(app) as any)[method](url).set('Host', host);
/** Through a trusted loopback hop (gateway / SSR listener): the address and scheme are forwarded. */
const viaHop = (method: string, url: string, host: string, proto = 'https') =>
    (request(app) as any)[method](url).set('X-Forwarded-Host', host).set('X-Forwarded-Proto', proto);

/** A cheap API route that needs nothing but the gate: the API index. */
const PROBE = `${API}/`;

/** Rewrite the staged config (and make configManager see it now, not after its 2 s revalidation). */
function stageConfig(patch: Record<string, unknown>) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...STAGED, ...patch }, null, 2));
    configManager.invalidateConfigCache();
}
function restoreConfig() {
    fs.writeFileSync(CONFIG_FILE, STAGED_TEXT);
    configManager.invalidateConfigCache();
}

function withEnv(key: string, value: string | undefined, fn: () => Promise<void>) {
    return async () => {
        const saved = process.env[key];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
        try { await fn(); } finally {
            if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
        }
    };
}

function withNodeEnv(value: string, fn: () => Promise<void>) {
    return async () => {
        const saved = config.nodeEnv;
        config.nodeEnv = value;
        try { await fn(); } finally { config.nodeEnv = saved; }
    };
}

const CRLF = '\r\n';
/** One request written by hand — the only way to send two Host headers, a host Node's client refuses, or none. */
function rawRequest(lines: string[]): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(server.address().port, '127.0.0.1', () => {
            socket.write(lines.concat(['Content-Length: 0', '', '']).join(CRLF));
        });
        let raw = '';
        socket.setTimeout(8000, () => { socket.destroy(); reject(new Error('raw socket timeout')); });
        socket.on('data', (d: Buffer) => { raw += d.toString(); });
        socket.on('error', reject);
        socket.on('close', () => resolve({
            status: Number((raw.split(CRLF)[0] || '').split(' ')[1]),
            body: raw.split(CRLF + CRLF).slice(1).join(CRLF + CRLF),
        }));
    });
}

const HOST_NOT_ALLOWED = {
    code: 'rest_host_not_allowed',
    error: 'host_not_allowed',
    message: 'This address is not configured for this site.',
    data: { status: 421 },
};

function assertRefused(res: any, what: string) {
    assert.strictEqual(res.status, 421, `${what}: expected 421, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepStrictEqual(res.body, HOST_NOT_ALLOWED, `${what}: the refusal body is exactly the documented one — no redirect, no details`);
    assert.strictEqual(res.headers['cache-control'], 'no-store', `${what}: a refusal must never be cached`);
    assert.strictEqual(res.headers['x-robots-tag'], 'noindex', `${what}: a refusal must never be indexed`);
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined,
        `${what}: the gate runs BEFORE CORS, so a refused address gets no CORS header at all`);
}

/** The session cookie (and its CSRF partner) a response set, as raw Set-Cookie strings. */
function cookieNamed(res: any, name: string): string | undefined {
    return ([] as string[]).concat(res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
}
const isSecure = (setCookie: string | undefined) => /;\s*Secure/i.test(String(setCookie));

/** POST /auth/login as the seeded administrator, with the request's own origin as Origin. */
function login(req: any, origin: string, password = PASSWORD) {
    return req.set('Origin', origin).send({ username: ADMIN, password });
}

// ─── 1. Which addresses are answered ────────────────────────────────────────────────────────────────

describe('accepted addresses reach the API', () => {
    const accepted: Array<[string, string]> = [
        ['the main address', 'example.com'],
        ['the main address with its trailing dot', 'example.com.'],
        ['the main address in capitals, on another port', 'EXAMPLE.com:8443'],
        ['an https alias', 'www.example.com'],
        ['a WORDJS_ALLOWED_HOSTS entry', 'env.example.com'],
        ['localhost', 'localhost:3000'],
        ['IPv6 loopback', '[::1]:3000'],
        ['the rest of 127/8', '127.0.0.2'],
        ['a LAN IP literal (ipLiterals: any)', '192.168.1.23:3000'],
    ];
    for (const [what, host] of accepted) {
        test(`${what} (${host}) → 200`, async () => {
            const res = await direct('get', PROBE, host);
            assert.strictEqual(res.status, 200, `${host}: ${res.status} ${JSON.stringify(res.body)}`);
        });
    }

    test('an EXPIRED alias is refused like any undeclared name', async () => {
        assertRefused(await direct('get', PROBE, 'retired.example.com'), 'expired alias');
    });

    test('a forwarded host is honoured from a trusted hop (the gateway / SSR shape)', async () => {
        const res = await viaHop('get', PROBE, 'www.example.com');
        assert.strictEqual(res.status, 200);
        assertRefused(await viaHop('get', PROBE, 'attacker.example'), 'unknown host forwarded by a trusted hop');
    });
});

describe('IP literals follow hostPolicy.ipLiterals, and R4 refuses them behind an undeclared proxy', () => {
    test('own: an address of this machine is answered, any other IP is refused', withEnv('WORDJS_IP_HOSTS', 'own', async () => {
        assertRefused(await direct('get', PROBE, '203.0.113.9'), 'a documentation-range IP is never one of ours');
        const own = [...hostPolicy.ownAddresses()].find((a: string) => !a.startsWith('['));
        if (own) {
            const res = await direct('get', PROBE, `${own}:3000`);
            assert.strictEqual(res.status, 200, `${own} is this machine's own address`);
        }
        // Loopback is a rule of its own and never depends on the IP policy.
        assert.strictEqual((await direct('get', PROBE, '127.0.0.1:3000')).status, 200);
    }));

    test('none: no undeclared IP is answered, a DECLARED one still is', withEnv('WORDJS_IP_HOSTS', 'none', async () => {
        assertRefused(await direct('get', PROBE, '192.168.1.23:3000'), 'ipLiterals none');
        assert.strictEqual((await direct('get', PROBE, '192.168.1.77:3000')).status, 200,
            'an operator who lists an IP is answered there whatever the IP rule says');
    }));

    for (const [marker, value] of [['X-Forwarded-For', '198.51.100.7'], ['Via', '1.1 nginx'], ['Forwarded', 'for=198.51.100.7'], ['X-Real-IP', '198.51.100.7']]) {
        test(`R4: an IP Host carrying ${marker} from an untrusted peer is a proxy that rewrote Host → 421 + "forward Host" hint`, async () => {
            hostPolicy.refusedHosts.clear();
            const res = await direct('get', PROBE, '192.168.1.23:3000').set(marker, value);
            assertRefused(res, `${marker} on an IP literal`);
            const entry = hostPolicy.refusedHosts.list().find((e: any) => e.host === '192.168.1.23');
            assert.ok(entry, 'the refusal is recorded for the admin page');
            assert.strictEqual(entry.hint, 'forward-host');
        });
    }

    test('R4 does not touch the direct request (a phone on the LAN), nor a declared IP, nor a trusted hop', async () => {
        assert.strictEqual((await direct('get', PROBE, '192.168.1.23:3000')).status, 200, 'no proxy markers → answered');
        assert.strictEqual((await direct('get', PROBE, '192.168.1.77:3000').set('X-Forwarded-For', '198.51.100.7')).status, 200,
            'a declared IP is matched before the IP-literal rule');
        assert.strictEqual((await viaHop('get', PROBE, '192.168.1.23:3000').set('X-Forwarded-For', '198.51.100.7')).status, 200,
            'from a trusted hop the forwarded host IS the browser\'s');
    });
});

describe('review #6: a frontend replica pinned to this backend by IP needs trustProxy, and the refusal says so', () => {
    /**
     * The real app behind a server that reports `peer` as every connection's remote address: a replica
     * on another machine, which supertest (always 127.0.0.1) cannot otherwise be.
     */
    const fromPeer = (peer: string) => http.createServer((req: any, res: any) => {
        Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true });
        app(req, res);
    });
    // documentation/multi-node.md: the replica on 10.0.1.30 proxies /api to WORDJS_BACKEND_URL=
    // http://10.0.1.23:4000 (frontend/backend-proxy-target.js: Host = the target, X-Forwarded-Host = the
    // browser's Host), behind a load balancer that adds X-Forwarded-For.
    const throughReplica = () => request(fromPeer('10.0.1.30')).get(PROBE).set('Host', '10.0.1.23:4000')
        .set('X-Forwarded-Host', 'example.com').set('X-Forwarded-Proto', 'https').set('X-Forwarded-For', '198.51.100.7');

    test('not in trustProxy → 421, and the log names the peer and WORDJS_TRUST_PROXY', async () => {
        hostPolicy.refusedHosts.clear();
        const warned: string[] = [];
        const realWarn = console.warn;
        console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
        let res: any;
        try {
            res = await throughReplica();
        } finally {
            console.warn = realWarn;
        }
        assertRefused(res, 'replica without trustProxy');
        assert.ok(warned.some((line) => /421 for 10\.0\.1\.23:4000 \(proxied-ip\): 10\.0\.1\.30 forwards X-Forwarded-Host but is not in trustProxy; if it is your frontend replica or proxy, set WORDJS_TRUST_PROXY=10\.0\.1\.30/.test(line)),
            `expected the trustProxy advice, got ${JSON.stringify(warned)}`);
    });

    test('inside WORDJS_TRUST_PROXY → answered as the browser\'s address', withEnv('WORDJS_TRUST_PROXY', '10.0.1.30', async () => {
        const res = await throughReplica();
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    }));
});

// ─── 2. Unknown addresses ───────────────────────────────────────────────────────────────────────────

describe('an address the site does not answer gets 421 before anything else runs', () => {
    const cases: Array<[string, string, string]> = [
        ['GET', 'get', `${API}/posts`],
        ['POST', 'post', `${API}/auth/login`],
        ['GET', 'get', `${API}/setup/status`],
        ['POST', 'post', `${API}/setup/migrate`],
        ['OPTIONS (CORS preflight)', 'options', `${API}/posts`],
    ];
    for (const [label, method, url] of cases) {
        test(`${label} ${url} on attacker.example → 421`, async () => {
            let r = direct(method, url, 'attacker.example').set('Origin', 'http://attacker.example');
            if (method === 'options') r = r.set('Access-Control-Request-Method', 'POST');
            assertRefused(await r, `${label} ${url}`);
        });
    }

    test('/setup/* is gated after install — it was the old guard\'s blind spot', async () => {
        assertRefused(await direct('get', `${API}/setup/status`, 'rebind.test'), '/setup/status');
    });

    test('a forged X-Forwarded-Host from a direct client is ignored — in both directions', async () => {
        assertRefused(await direct('get', PROBE, 'rebind.test:4000').set('X-Forwarded-Host', 'example.com'),
            'DNS rebinding page naming the real site in X-Forwarded-Host');
        const res = await direct('get', PROBE, 'example.com').set('X-Forwarded-Host', 'evil.example');
        assert.strictEqual(res.status, 200, 'the Host the browser used decides, not the header it added');
    });

    test('review #3: WORDJS_TRUST_PROXY=loopback does not hand the rebinding page its X-Forwarded-Host back', withEnv('WORDJS_TRUST_PROXY', 'loopback', async () => {
        // supertest connects from 127.0.0.1 — exactly the peer a rebinding page on rebind.attacker → 127.0.0.1
        // is — so under loopback trust every request below arrives from an 'operator' hop.
        assertRefused(await direct('get', PROBE, 'rebind.attacker:4000').set('X-Forwarded-Host', 'example.com'),
            'a rebinding page under operator trust');
        assert.strictEqual((await direct('get', PROBE, '10.0.0.5:4000').set('X-Forwarded-Host', 'www.example.com')).status, 200,
            'a trusted proxy that dials WordJS by IP still relays the browser\'s address');
        assertRefused(await direct('get', PROBE, '10.0.0.5:4000').set('X-Forwarded-Host', 'attacker.example'),
            'and it is that relayed address the gate judges');
    }));

    test('a refused host is recorded, with a hint, for the admin page', async () => {
        hostPolicy.refusedHosts.clear();
        await direct('get', PROBE, 'www.example.com.evil.example');
        await direct('get', PROBE, 'abcd.trycloudflare.com');
        const hosts = hostPolicy.refusedHosts.list().map((e: any) => [e.host, e.hint]);
        assert.deepStrictEqual(hosts, [['abcd.trycloudflare.com', 'tunnel'], ['www.example.com.evil.example', null]]);
    });
});

describe('malformed Host headers are a 400, an absent one passes to the gates that already fail closed', () => {
    test('two Host headers → 400 rest_invalid_host (Node keeps the first and drops the second)', async () => {
        const res = await rawRequest([`GET ${PROBE} HTTP/1.1`, 'Host: example.com', 'Host: attacker.example', 'Connection: close']);
        assert.strictEqual(res.status, 400);
        assert.strictEqual(JSON.parse(res.body).code, 'rest_invalid_host');
    });

    for (const bad of ['evil.example@localhost', 'localhost:1@evil.example', '127.1', 'example.com:99999']) {
        test(`Host: ${bad} → 400 rest_invalid_host`, async () => {
            const res = await rawRequest([`GET ${PROBE} HTTP/1.1`, `Host: ${bad}`, 'Connection: close']);
            assert.strictEqual(res.status, 400, `${bad}: ${res.status} ${res.body}`);
            assert.strictEqual(JSON.parse(res.body).code, 'rest_invalid_host');
        });
    }

    test('HTTP/1.0 with no Host passes the gate (health checks); a mutation is still refused by CSRF', async () => {
        const get = await rawRequest([`GET ${PROBE} HTTP/1.0`]);
        assert.strictEqual(get.status, 200, 'host-less HTTP/1.0 must reach the API, as it always did');
        const post = await rawRequest([`POST ${API}/posts HTTP/1.0`, 'Origin: http://undefined']);
        assert.strictEqual(post.status, 403);
        assert.strictEqual(JSON.parse(post.body).code, 'rest_csrf_invalid');
    });
});

describe('exempt paths are answered on any address, exactly as before', () => {
    for (const p of ['/health', '/healthz', '/readyz', '/metrics', '/favicon.ico', '/uploads/nope.png',
        '/.well-known/acme-challenge/token', '/themes/default/style.css', '/plugins/x/public/a.css', '/public/css/missing.css']) {
        test(`${p} on attacker.example is not refused`, async () => {
            const res = await direct('get', p, 'attacker.example');
            assert.notStrictEqual(res.status, 421, `${p} must stay exempt (probes are often addressed by pod IP)`);
            assert.notStrictEqual(res.status, 400);
        });
    }
});

describe('before install, and without a valid siteUrl, the gate steps aside', () => {
    test('not installed: any address reaches the install funnel (503 setup_required), /setup answers', async () => {
        const real = configManager.isInstalled;
        configManager.isInstalled = () => false;
        try {
            const res = await direct('get', `${API}/posts`, 'attacker.example');
            assert.strictEqual(res.status, 503);
            assert.strictEqual(res.body.error, 'setup_required');
            // routes/setup.ts captured its own isInstalled at load, so only the gate's answer is asserted:
            // an address it would refuse after install reaches the wizard's endpoint before it.
            const status = await direct('get', `${API}/setup/status`, 'attacker.example');
            assert.strictEqual(status.status, 200);
        } finally {
            configManager.isInstalled = real;
        }
    });

    test('installed but siteUrl missing: answered (parity), and an admin notice is raised', async () => {
        const real = configManager.getConfig;
        configManager.getConfig = () => ({ installedAt: STAGED.installedAt, dbDriver: STAGED.dbDriver });
        try {
            const res = await direct('get', PROBE, 'attacker.example');
            assert.strictEqual(res.status, 200, 'with no canonical every address is answered, as the old guard did');
        } finally {
            configManager.getConfig = real;
        }
        const { getOption } = require('../core/options');
        let notices: any[] = [];
        for (let i = 0; i < 50 && !notices.some((n: any) => n && n.id === 'site.address.missing-canonical'); i++) {
            await new Promise((r) => setTimeout(r, 20));
            const raw = await getOption('admin_notices', []);
            notices = Array.isArray(raw) ? raw : [];
        }
        assert.ok(notices.some((n: any) => n && n.id === 'site.address.missing-canonical' && n.type === 'error'),
            `the missing-canonical condition must reach /admin/notices, got ${JSON.stringify(notices)}`);
    });
});

// ─── 3. CORS ────────────────────────────────────────────────────────────────────────────────────────

describe('CORS same-origin compares host:port AND scheme of the address the request was sent to', () => {
    const acao = (res: any) => res.headers['access-control-allow-origin'];

    test('same host, same port, same scheme → reflected with credentials', async () => {
        const res = await direct('get', PROBE, 'www.example.com').set('Origin', 'http://www.example.com');
        assert.strictEqual(acao(res), 'http://www.example.com');
        assert.strictEqual(res.headers['access-control-allow-credentials'], 'true');
    });

    test('another port is another origin (:8443 must not read the :443 API)', async () => {
        const res = await direct('get', PROBE, 'www.example.com').set('Origin', 'http://www.example.com:8443');
        assert.strictEqual(acao(res), undefined);
    });

    test('R14: another scheme is another origin', async () => {
        const https = await viaHop('get', PROBE, 'www.example.com', 'https').set('Origin', 'https://www.example.com');
        assert.strictEqual(acao(https), 'https://www.example.com');
        const downgraded = await viaHop('get', PROBE, 'www.example.com', 'https').set('Origin', 'http://www.example.com');
        assert.strictEqual(acao(downgraded), undefined, 'a plain-http page must not get credentialed reads of the https API');
    });

    test('a trailing-dot page keeps matching its own host', async () => {
        const res = await direct('get', PROBE, 'www.example.com.').set('Origin', 'http://www.example.com.');
        assert.strictEqual(acao(res), 'http://www.example.com.');
    });

    test('aliases never vouch for each other', async () => {
        const res = await direct('get', PROBE, 'www.example.com').set('Origin', 'http://intranet.example.com:8080');
        assert.strictEqual(acao(res), undefined);
    });

    test('R3: gatewayUrl is not a browser origin', async () => {
        const saved = config.gatewayUrl;
        config.gatewayUrl = 'https://gw.internal.example';
        try {
            const res = await direct('get', PROBE, 'www.example.com').set('Origin', 'https://gw.internal.example');
            assert.strictEqual(acao(res), undefined);
            const site = await direct('get', PROBE, 'www.example.com').set('Origin', 'https://example.com');
            assert.strictEqual(acao(site), 'https://example.com', 'the configured site origin is still allowed');
        } finally {
            config.gatewayUrl = saved;
        }
    });

    test('development: any loopback origin, [::1] included; production: none', async () => {
        await withNodeEnv('development', async () => {
            for (const origin of ['http://localhost:3000', 'http://127.0.0.1:5173', 'http://[::1]:3000']) {
                const res = await direct('get', PROBE, 'example.com').set('Origin', origin);
                assert.strictEqual(acao(res), origin, `${origin} in development`);
            }
        })();
        const res = await direct('get', PROBE, 'example.com').set('Origin', 'http://[::1]:3000');
        assert.strictEqual(acao(res), undefined, 'production never reflects a loopback origin it was not sent to');
    });
});

// ─── 4. CSRF ────────────────────────────────────────────────────────────────────────────────────────

describe('CSRF origin pinning on an accepted alias', () => {
    test('a foreign Origin is refused on an alias', async () => {
        const res = await direct('post', `${API}/posts`, 'www.example.com').set('Origin', 'https://evil.example').send({});
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.body.code, 'rest_csrf_invalid');
    });

    test('another alias is a foreign Origin too', async () => {
        const res = await direct('post', `${API}/posts`, 'www.example.com').set('Origin', 'http://plain.example.com').send({});
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.body.code, 'rest_csrf_invalid');
    });

    test('a forged X-Forwarded-Host cannot make a hostile Origin same-origin', async () => {
        const res = await direct('post', `${API}/posts`, 'www.example.com')
            .set('X-Forwarded-Host', 'evil.example').set('Origin', 'http://evil.example').send({});
        assert.strictEqual(res.status, 403, 'X-Forwarded-Host from a direct client used to name the "same" origin');
        assert.strictEqual(res.body.code, 'rest_csrf_invalid');
    });

    test('the request\'s own origin passes (trailing dot and capitals normalised on both sides)', async () => {
        const res = await direct('post', `${API}/posts`, 'WWW.example.com.').set('Origin', 'http://www.example.com.').send({});
        assert.notStrictEqual(res.status, 403, JSON.stringify(res.body));
        assert.strictEqual(res.status, 401, 'past CSRF, the posts route itself asks for a session');
    });
});

// ─── 5. Sessions: the sign-in rule and the cookie's Secure attribute ────────────────────────────────

describe('sign-in per address class (production, https main address)', () => {
    async function expectSignedIn(req: any, origin: string, secure: boolean, what: string) {
        const res = await login(req, origin);
        assert.strictEqual(res.status, 200, `${what}: ${res.status} ${JSON.stringify(res.body)}`);
        const session = cookieNamed(res, 'wordjs_token');
        const csrf = cookieNamed(res, 'wjs_csrf');
        assert.ok(session && csrf, `${what}: both cookies are set`);
        assert.strictEqual(isSecure(session), secure, `${what}: session cookie Secure should be ${secure}: ${session}`);
        assert.strictEqual(isSecure(csrf), secure, `${what}: the CSRF partner travels with the same Secure attribute`);
        assert.ok(!/;\s*Domain=/i.test(String(session)), `${what}: cookies stay host-only`);
    }
    async function expectRefused(req: any, origin: string, reason: string, what: string) {
        const res = await login(req, origin);
        assert.strictEqual(res.status, 403, `${what}: ${res.status} ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.code, 'rest_insecure_transport', what);
        assert.strictEqual(res.body.data.reason, reason, what);
        assert.strictEqual(cookieNamed(res, 'wordjs_token'), undefined, `${what}: no session cookie, not even a Secure one`);
    }

    test('the main address keeps today\'s rule: signed in, Secure because the site is https', async () => {
        await expectSignedIn(direct('post', `${API}/auth/login`, 'example.com'), 'http://example.com', true, 'canonical');
    });

    test('loopback keeps today\'s rule', async () => {
        await expectSignedIn(direct('post', `${API}/auth/login`, 'localhost:3000'), 'http://localhost:3000', true, 'loopback');
    });

    test('an https alias reached over https → signed in, Secure', async () => {
        await expectSignedIn(viaHop('post', `${API}/auth/login`, 'www.example.com', 'https'), 'https://www.example.com', true, 'https alias over https');
    });

    test('R9: an https alias reached over plain http → refused (the real transport decides, not the declaration)', async () => {
        await expectRefused(direct('post', `${API}/auth/login`, 'www.example.com'), 'http://www.example.com', 'transport', 'https alias over http');
    });

    test('an http alias with an explicit signIn: true → signed in over http, not Secure', async () => {
        await expectSignedIn(direct('post', `${API}/auth/login`, 'intranet.example.com:8080'), 'http://intranet.example.com:8080', false, 'http alias opted in');
    });

    test('an http alias without signIn → refused over http', async () => {
        await expectRefused(direct('post', `${API}/auth/login`, 'plain.example.com'), 'http://plain.example.com', 'transport', 'http alias by default');
    });

    test('R2: an undeclared IP literal → refused even over https (the session outlives the address)', async () => {
        await expectRefused(viaHop('post', `${API}/auth/login`, '192.168.1.23:3000', 'https'), 'https://192.168.1.23:3000', 'address', 'IP over https');
        await expectRefused(direct('post', `${API}/auth/login`, '192.168.1.23:3000'), 'http://192.168.1.23:3000', 'transport', 'IP over http');
    });

    test('R2: a tunnel alias → refused even over https unless it opts in', async () => {
        await expectRefused(viaHop('post', `${API}/auth/login`, 'ab12.ngrok-free.app', 'https'), 'https://ab12.ngrok-free.app', 'address', 'tunnel alias');
    });

    test('a declared IP alias with signIn: true over http → signed in, not Secure', async () => {
        await expectSignedIn(direct('post', `${API}/auth/login`, '192.168.1.77:3000'), 'http://192.168.1.77:3000', false, 'declared IP opted in');
    });

    test('hostPolicy.ipSignIn enables undeclared IPs — over https only on an https site', async () => {
        stageConfig({ hostPolicy: { ipLiterals: 'any', ipSignIn: true } });
        try {
            await expectSignedIn(viaHop('post', `${API}/auth/login`, '192.168.1.23:3000', 'https'), 'https://192.168.1.23:3000', true, 'IP opted in, https');
            await expectRefused(direct('post', `${API}/auth/login`, '192.168.1.23:3000'), 'http://192.168.1.23:3000', 'transport', 'IP opted in, http');
        } finally {
            restoreConfig();
        }
    });

    test('a WORDJS_ALLOWED_HOSTS entry: signed in over https, refused over http', async () => {
        await expectSignedIn(viaHop('post', `${API}/auth/login`, 'env.example.com', 'https'), 'https://env.example.com', true, 'env host over https');
        await expectRefused(direct('post', `${API}/auth/login`, 'env.example.com'), 'http://env.example.com', 'transport', 'env host over http');
    });

    test('development: every accepted address may sign in — the phone on the LAN IP', withNodeEnv('development', async () => {
        await expectSignedIn(direct('post', `${API}/auth/login`, '192.168.1.23:3000'), 'http://192.168.1.23:3000', false, 'dev phone by IP');
        await expectSignedIn(direct('post', `${API}/auth/login`, 'www.example.com'), 'http://www.example.com', true, 'dev https alias over http keeps its declared Secure');
    }));

    test('R13: a refused address answers BEFORE the password is evaluated', async () => {
        const auth = require('../routes/auth');
        const bucket = auth.lockBucket('login', ADMIN);
        const before = await auth.loginFailCount(bucket);
        const res = await login(direct('post', `${API}/auth/login`, '192.168.1.23:3000'), 'http://192.168.1.23:3000', 'definitely-wrong');
        assert.strictEqual(res.status, 403, 'a wrong password on a refused address is not a 401: the credential was never looked at');
        assert.strictEqual(res.body.code, 'rest_insecure_transport');
        assert.strictEqual(await auth.loginFailCount(bucket), before, 'no failure was counted against the account');
    });

    test('R13: register is refused the same way, before anything in the body is read', async () => {
        const res = await direct('post', `${API}/auth/register`, 'plain.example.com').set('Origin', 'http://plain.example.com')
            .send({ username: 'newcomer', email: 'newcomer@example.org', password: 'long-enough-password' });
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.body.code, 'rest_insecure_transport', 'not rest_cannot_register: the address is refused first');
    });

    test('R13: GET /auth/me tells the login screen whether to render the form', async () => {
        const refused = await direct('get', `${API}/auth/me`, '192.168.1.23:3000');
        assert.strictEqual(refused.status, 401);
        assert.strictEqual(refused.body.code, 'rest_not_logged_in');
        assert.strictEqual(refused.body.data.signIn, false);
        assert.strictEqual(refused.body.data.signInRefused, 'transport');
        const allowed = await direct('get', `${API}/auth/me`, 'example.com');
        assert.strictEqual(allowed.status, 401);
        assert.strictEqual(allowed.body.data.signIn, true);
        assert.strictEqual(allowed.body.data.signInRefused, undefined);
    });

    test('a session refreshed on a refused address is refused too (the rule lives in the one cookie door)', async () => {
        const { generateToken } = require('../middleware/auth');
        const token = generateToken({ id: adminId, userLogin: ADMIN });
        const res = await direct('post', `${API}/auth/refresh`, 'plain.example.com')
            .set('Origin', 'http://plain.example.com')
            .set('Cookie', `wordjs_token=${token}; wjs_csrf=t`).set('X-CSRF-Token', 't');
        assert.strictEqual(res.status, 403, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'rest_insecure_transport');
        assert.strictEqual(cookieNamed(res, 'wordjs_token'), undefined);
    });
});

// ─── 6. The interlock's "in use" signal (R7) ────────────────────────────────────────────────────────

describe('only an AUTHENTICATED request marks a declared address as in use', () => {
    beforeEach(() => hostPolicy.lastSeen.clear());
    afterEach(() => hostPolicy.lastSeen.clear());

    test('anonymous traffic is seen but never counts as use', async () => {
        await direct('get', PROBE, 'www.example.com');
        const entry = hostPolicy.lastSeen.get('www.example.com');
        assert.ok(entry && entry.seenAt > 0, 'a declared address is recorded as seen');
        assert.strictEqual(entry.authenticatedAt, null);
        await direct('get', PROBE, '192.168.1.23:3000');
        assert.strictEqual(hostPolicy.lastSeen.get('192.168.1.23'), null, 'undeclared IPs are never recorded (bounded state)');
    });

    test('a request that authenticated marks its address as in use', async () => {
        const { generateToken } = require('../middleware/auth');
        const token = generateToken({ id: adminId, userLogin: ADMIN });
        const res = await viaHop('get', `${API}/auth/me`, 'www.example.com', 'https').set('Cookie', `wordjs_token=${token}`);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const entry = hostPolicy.lastSeen.get('www.example.com');
        assert.ok(entry && typeof entry.authenticatedAt === 'number', `expected authenticatedAt, got ${JSON.stringify(entry)}`);
    });
});

// ─── 7. Sessions are bound to the address they were minted on (R2) ─────────────────────────────────

describe('R2: retiring an address retires the sessions minted on it', () => {
    const jwt = require('jsonwebtoken');
    const sessionFrom = (res: any) => String(cookieNamed(res, 'wordjs_token')).split(';')[0].slice('wordjs_token='.length);
    /** The session lifetime config.jwt.expiresIn gives, in seconds. */
    const configuredLifetime = () => {
        const probe = jwt.decode(jwt.sign({}, config.jwt.secret, { expiresIn: config.jwt.expiresIn }));
        return probe.exp - probe.iat;
    };

    test('a session carries the address it was minted on — the main address too (review #10); loopback carries nothing', async () => {
        const alias = await login(viaHop('post', `${API}/auth/login`, 'www.example.com', 'https'), 'https://www.example.com');
        assert.strictEqual(alias.status, 200, JSON.stringify(alias.body));
        assert.strictEqual(jwt.decode(sessionFrom(alias)).mh, 'www.example.com');
        const main = await login(direct('post', `${API}/auth/login`, 'example.com'), 'http://example.com');
        assert.strictEqual(main.status, 200, JSON.stringify(main.body));
        const claims = jwt.decode(sessionFrom(main));
        assert.strictEqual(claims.mh, 'example.com');
        assert.strictEqual(claims.exp - claims.iat, configuredLifetime(), 'the main address has no expiry: the full configured lifetime');
        const loopback = await login(direct('post', `${API}/auth/login`, 'localhost:3000'), 'http://localhost:3000');
        assert.strictEqual(loopback.status, 200, JSON.stringify(loopback.body));
        assert.strictEqual(jwt.decode(sessionFrom(loopback)).mh, undefined);
    });

    test('review #10: dropping the old main address ends the sessions minted on it; keep and redirect do not', async () => {
        const siteAddress = require('../core/site-address');
        const res = await login(direct('post', `${API}/auth/login`, 'example.com'), 'http://example.com');
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const token = sessionFrom(res);
        const me = () => direct('get', `${API}/auth/me`, 'new.example.com').set('Cookie', `wordjs_token=${token}`);
        for (const [oldAddress, expected] of [['keep', 200], ['redirect', 200], ['drop', 401]] as Array<[string, number]>) {
            // The very plan PUT /site-address/canonical commits, applied to the staged site.
            const plan = siteAddress.planCanonical(JSON.parse(STAGED_TEXT), { url: 'https://new.example.com', oldAddress, actorId: adminId, via: 'ui', now: Date.now() });
            stageConfig(plan.patch);
            try {
                const after = await me();
                assert.strictEqual(after.status, expected, `${oldAddress}: ${JSON.stringify(after.body)}`);
                if (expected === 401) assert.strictEqual(after.body.code, 'rest_token_revoked');
            } finally {
                restoreConfig();
            }
        }
    });

    test('a config with no valid main address does not revoke main-address sessions (the gate answers every address then)', async () => {
        const res = await login(direct('post', `${API}/auth/login`, 'example.com'), 'http://example.com');
        const token = sessionFrom(res);
        assert.strictEqual(jwt.decode(token).mh, 'example.com');
        stageConfig({ siteUrl: 'https,https://example.com' });
        try {
            const me = await direct('get', `${API}/auth/me`, 'example.com').set('Cookie', `wordjs_token=${token}`);
            assert.strictEqual(me.status, 200, `a broken siteUrl must not sign everyone out: ${JSON.stringify(me.body)}`);
        } finally {
            restoreConfig();
        }
    });

    test('removing the alias ends its sessions — wherever they are replayed', async () => {
        const res = await login(viaHop('post', `${API}/auth/login`, 'www.example.com', 'https'), 'https://www.example.com');
        const token = sessionFrom(res);
        // Replayed on the MAIN address: the binding is to the claim, not to the request's Host.
        const me = () => direct('get', `${API}/auth/me`, 'example.com').set('Cookie', `wordjs_token=${token}`);
        assert.strictEqual((await me()).status, 200, 'while the alias exists the session works on any accepted address');
        stageConfig({ siteAliases: STAGED.siteAliases.filter((a: any) => a.url !== 'https://www.example.com') });
        try {
            const after = await me();
            assert.strictEqual(after.status, 401, JSON.stringify(after.body));
            assert.strictEqual(after.body.code, 'rest_token_revoked');
        } finally {
            restoreConfig();
        }
        assert.strictEqual((await me()).status, 200, 'the alias is back, and so is the session');
    });

    test('a session never outlives the alias it was minted on', async () => {
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
        stageConfig({ siteAliases: [...STAGED.siteAliases, { url: 'https://soon.example.com', expiresAt: expiresAt.toISOString() }] });
        try {
            const res = await login(viaHop('post', `${API}/auth/login`, 'soon.example.com', 'https'), 'https://soon.example.com');
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            const { exp, mh } = jwt.decode(sessionFrom(res));
            assert.strictEqual(mh, 'soon.example.com');
            assert.ok(exp <= Math.floor(expiresAt.getTime() / 1000), `exp ${exp} must not pass the alias expiry`);
        } finally {
            restoreConfig();
        }
    });

    describe('review #1: a credential minted from a bound session is never less bound', () => {
        const SOON = new Date(Date.now() + 60 * 60 * 1000);
        const SOON_SECONDS = Math.floor(SOON.getTime() / 1000);
        const WITH_SOON = [...STAGED.siteAliases, { url: 'https://soon.example.com', expiresAt: SOON.toISOString(), source: 'admin' }];
        /** What the next holder of soon.example.com does with a returning victim's cookies: replay them on the main address. */
        const onMain = (method: string, url: string, token: string) => direct(method, url, 'example.com').set('Origin', 'http://example.com')
            .set('Cookie', `wordjs_token=${token}; wjs_csrf=t`).set('X-CSRF-Token', 't');
        async function aliasSession(): Promise<string> {
            const res = await login(viaHop('post', `${API}/auth/login`, 'soon.example.com', 'https'), 'https://soon.example.com');
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            return sessionFrom(res);
        }
        beforeEach(() => stageConfig({ siteAliases: WITH_SOON }));
        afterEach(() => restoreConfig());

        test('(a) a refresh on the main address keeps the alias binding and its expiry cap', async () => {
            const refreshed = await onMain('post', `${API}/auth/refresh`, await aliasSession());
            assert.strictEqual(refreshed.status, 200, JSON.stringify(refreshed.body));
            const { mh, exp } = jwt.decode(sessionFrom(refreshed));
            assert.strictEqual(mh, 'soon.example.com', 'the refreshed session is bound where the presented one was');
            assert.ok(exp <= SOON_SECONDS, `exp ${exp} must not pass the alias expiry ${SOON_SECONDS}`);
        });

        test('(b) once the alias is removed, the refreshed session is revoked with it', async () => {
            const refreshed = sessionFrom(await onMain('post', `${API}/auth/refresh`, await aliasSession()));
            stageConfig({ siteAliases: STAGED.siteAliases });
            const me = await direct('get', `${API}/auth/me`, 'example.com').set('Cookie', `wordjs_token=${refreshed}`);
            assert.strictEqual(me.status, 401, JSON.stringify(me.body));
            assert.strictEqual(me.body.code, 'rest_token_revoked');
        });

        test('(a\') a main-address session keeps sliding: a refresh gives the full lifetime again', async () => {
            const main = await login(direct('post', `${API}/auth/login`, 'example.com'), 'http://example.com');
            const refreshed = await onMain('post', `${API}/auth/refresh`, sessionFrom(main));
            assert.strictEqual(refreshed.status, 200, JSON.stringify(refreshed.body));
            const claims = jwt.decode(sessionFrom(refreshed));
            assert.strictEqual(claims.mh, 'example.com');
            assert.strictEqual(claims.exp - claims.iat, configuredLifetime());
        });

        test('(c) an alias-bound session may not mint an API token; a main-address session still may', async () => {
            const bound = await onMain('post', `${API}/auth/tokens`, await aliasSession()).send({ name: 'from-alias', scopes: ['*'] });
            assert.strictEqual(bound.status, 403, JSON.stringify(bound.body));
            assert.strictEqual(bound.body.code, 'rest_token_bound_session');
            assert.strictEqual(bound.body.token, undefined);
            const main = await login(direct('post', `${API}/auth/login`, 'example.com'), 'http://example.com');
            const created = await onMain('post', `${API}/auth/tokens`, sessionFrom(main)).send({ name: 'from-main', scopes: ['read'] });
            assert.strictEqual(created.status, 201, JSON.stringify(created.body));
            assert.match(created.body.token, /^wjt_/);
            const loopback = await login(direct('post', `${API}/auth/login`, 'localhost:3000'), 'http://localhost:3000');
            const fromLoopback = await direct('post', `${API}/auth/tokens`, 'localhost:3000').set('Origin', 'http://localhost:3000')
                .set('Cookie', `wordjs_token=${sessionFrom(loopback)}; wjs_csrf=t`).set('X-CSRF-Token', 't').send({ name: 'from-loopback', scopes: ['read'] });
            assert.strictEqual(fromLoopback.status, 201, JSON.stringify(fromLoopback.body));
            for (const id of [created.body.id, fromLoopback.body.id]) {
                await onMain('delete', `${API}/auth/tokens/${id}`, sessionFrom(main));
            }
        });

        test('(d) an alias-bound session may not create an account nor change someone else\'s; its own profile and a main-address session still may', async () => {
            const main = sessionFrom(await login(direct('post', `${API}/auth/login`, 'example.com'), 'http://example.com'));
            const stamp = Date.now();
            const other = await onMain('post', `${API}/users`, main).send({ username: `bound_other_${stamp}`, email: `bound_other_${stamp}@example.com`, password: 'Str0ng-Passw0rd-xyz!', role: 'subscriber' });
            assert.strictEqual(other.status, 201, `a main-address session creates accounts: ${JSON.stringify(other.body)}`);
            const otherId = other.body.id;
            try {
                const bound = await aliasSession();
                const created = await onMain('post', `${API}/users`, bound).send({ username: `bound_new_${stamp}`, email: `bound_new_${stamp}@example.com`, password: 'Str0ng-Passw0rd-xyz!', role: 'administrator' });
                assert.strictEqual(created.status, 403, JSON.stringify(created.body));
                assert.strictEqual(created.body.code, 'rest_account_bound_session');
                const edited = await onMain('put', `${API}/users/${otherId}`, bound).send({ email: `taken_${stamp}@example.com` });
                assert.strictEqual(edited.status, 403, JSON.stringify(edited.body));
                assert.strictEqual(edited.body.code, 'rest_account_bound_session');
                const own = await onMain('put', `${API}/users/${adminId}`, bound).send({ displayName: 'Admin via alias' });
                assert.notStrictEqual(own.body && own.body.code, 'rest_account_bound_session', 'its own profile stays editable');
            } finally {
                await onMain('delete', `${API}/users/${otherId}`, main);
            }
        });
    });

    test('a live collaboration stream re-verifies the binding too', async () => {
        const Post = require('../models/Post');
        const post = await Post.create({ authorId: adminId, title: 'Bound draft', type: 'post', status: 'draft' });
        const collab = require('../routes/collab');
        const revalidate = (mh: string) => collab._makeRevalidate({
            get: () => undefined,
            cookies: { wordjs_token: jwt.sign({ userId: adminId, username: ADMIN, mh }, config.jwt.secret, { expiresIn: '1h' }) },
            user: { id: adminId },
        }, post.id);
        assert.strictEqual(await revalidate('www.example.com')(), true, 'a session from an accepted alias keeps its stream');
        assert.strictEqual(await revalidate('gone.example.com')(), false, 'a session from a retired address loses it');
    });
});

describe('the collaboration stream asks the same same-origin question', () => {
    const { generateToken } = require('../middleware/auth');
    const stream = (host: string) => direct('get', `${API}/collab/999999/stream?siteId=s_aaaa`, host)
        .set('Cookie', `wordjs_token=${generateToken({ id: adminId, userLogin: ADMIN })}`);

    test('its own origin passes, normalised like the request host (trailing dot, capitals)', async () => {
        const res = await stream('WWW.example.com.').set('Origin', 'http://www.example.com.');
        assert.strictEqual(res.status, 404, `past sameOrigin the missing post answers: ${res.status} ${JSON.stringify(res.body)}`);
    });

    test('a forged X-Forwarded-Host cannot make a hostile page same-origin', async () => {
        const res = await stream('www.example.com').set('X-Forwarded-Host', 'evil.example').set('Origin', 'http://evil.example');
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.body.code, 'rest_csrf_invalid');
    });
});

// ─── 8. /setup after install ────────────────────────────────────────────────────────────────────────

describe('/setup after install', () => {
    test('/setup/status reads no host: the same body whatever the headers say', async () => {
        const a = await direct('get', `${API}/setup/status`, 'example.com');
        const b = await direct('get', `${API}/setup/status`, 'www.example.com').set('X-Forwarded-Host', 'evil.example').set('X-Forwarded-Proto', 'http');
        assert.strictEqual(a.status, 200);
        assert.deepStrictEqual(a.body, { installed: true });
        assert.deepStrictEqual(b.body, a.body);
    });

    test('/setup/migrate is gone: 410 for every method, and nothing is read or written', async () => {
        const before = fs.readFileSync(CONFIG_FILE, 'utf8');
        const post = await direct('post', `${API}/setup/migrate`, 'example.com').set('Origin', 'http://example.com')
            .send({ username: ADMIN, password: PASSWORD });
        assert.strictEqual(post.status, 410, JSON.stringify(post.body));
        assert.strictEqual(post.body.code, 'rest_migrate_removed');
        const get = await direct('get', `${API}/setup/migrate`, 'example.com');
        assert.strictEqual(get.status, 410);
        assert.strictEqual(fs.readFileSync(CONFIG_FILE, 'utf8'), before, 'the config file is untouched');
        assert.strictEqual(cookieNamed(post, 'wordjs_token'), undefined);
    });
});
