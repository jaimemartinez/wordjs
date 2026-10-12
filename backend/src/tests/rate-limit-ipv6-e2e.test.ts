/**
 * AN IPv6 /64 IS ONE CLIENT — END TO END, on a real core limiter and on a real plugin route.
 *
 * client-ip-ipv6-bucket.test.ts proves the primitive (core/client-ip ipBucket / pluginClientKey) and the
 * login throttle. What it could not see is the WIRING: index.ts keys every IP limiter through its own
 * `ipKey`, and core/plugin-isolate hands each plugin route its `req.clientKey`. Put `ipKey` back to
 * clientIp(), or compute the plugin key from `req.ip` again, and every unit test stays green while a
 * client holding a /64 gets a fresh budget — and a fresh plugin identity — per address.
 *
 * So this file drives the consumers themselves:
 *   · the REAL app exported by index.ts (its trust-proxy setting, its authLimiter of 10 per hour on
 *     /api/v1/auth/register) over supertest, with the client address in X-Forwarded-For — the one hop
 *     index.ts trusts outside the monolith;
 *   · the comment limiter routes/comments.ts builds for itself (its twin outside index.ts), through the
 *     real router;
 *   · a REAL isolated plugin whose route echoes `req.clientKey`, loaded through loadIsolatedPlugin and
 *     served by host Express exactly as an installed plugin's route is.
 *
 *   · and EVERY per-IP limiter index.ts mounts — the global API bucket, collaboration, analytics, auth,
 *     the failed-login backstop, uploads, form submissions and setup — each through its own budget: one
 *     limiter given its own keyGenerator is invisible to a test that only drives another.
 *
 * MUTATION PROOF: `const ipKey = (req) => clientIp(req)` in index.ts lets the 11th request from the same
 * /64 through; keying the comment limiter on clientIp() lets the 6th guest comment through; computing
 * plugin-isolate's clientKey from `req.ip` gives two addresses of one /64 two keys. Swapping the
 * keyGenerator of any ONE limiter in index.ts for `(req) => clientIp(req)` lets its budget+1-th request
 * from the /64 through; deleting it (express-rate-limit's own default groups IPv6 by /56) refuses the
 * neighbouring /64 that shares the /56.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
config.dbPath = path.join(os.tmpdir(), `wjs-ipv6-e2e-${process.pid}-${Date.now()}.db`);
config.dbDriver = 'sqlite-native';
// Budgets index.ts reads ONCE, when it builds its limiters — set before it is first required (below), so
// every limiter's budget fits a test: the global bucket stays above every other limiter's budget (a probe
// of another limiter must never be refused by it first), and the failed-login backstop is small.
config.api.rateLimit.max = 80;
config.auth.loginIpFailPerHour = 8;

const request = require('supertest');
const express = require('express');

describe('a core limiter of the real app counts a /64 as one client', () => {
    let app: any;
    const configManager = require('../core/configManager');
    const real = { isInstalled: configManager.isInstalled, getConfig: configManager.getConfig };
    const savedEmbedded = process.env.WORDJS_EMBEDDED;

    before(() => {
        // Outside the monolith index.ts trusts exactly one X-Forwarded-For hop (the gateway's).
        delete process.env.WORDJS_EMBEDDED;
        app = require('../index');
        // An INSTALLED site, declared in memory (the public-surface-hardening.test.ts pattern): otherwise the
        // install guard answers 503 to every API request before any router runs.
        configManager.isInstalled = () => true;
        configManager.getConfig = () => ({ installedAt: '2020-01-01T00:00:00.000Z', dbDriver: config.dbDriver });
    });
    after(() => {
        configManager.isInstalled = real.isInstalled;
        configManager.getConfig = real.getConfig;
        if (savedEmbedded === undefined) delete process.env.WORDJS_EMBEDDED; else process.env.WORDJS_EMBEDDED = savedEmbedded;
    });

    // authLimiter (10 per hour) is mounted on the /auth/register subtree; a GET below it is counted and
    // then answered by the routers, so the probe creates nothing.
    const probe = (from: string) => request(app).get(`${config.api.prefix}/auth/register/rate-probe`).set('X-Forwarded-For', from);

    it('precondition: the app trusts the forwarded hop', () => {
        assert.ok(app.get('trust proxy'), 'index.ts set no trust proxy — the forwarded address would be ignored');
    });

    it('ten addresses of one /64 spend one budget: the eleventh, from yet another address of it, is refused', async () => {
        for (let i = 1; i <= 10; i++) {
            const r = await probe(`2001:db8:5:5::${i.toString(16)}`);
            assert.notStrictEqual(r.status, 429, `request ${i} was already limited`);
        }
        const eleventh = await probe('2001:db8:5:5:ffff:ffff:ffff:ffff');
        assert.strictEqual(eleventh.status, 429, `the /64 got a fresh budget: ${eleventh.status} ${JSON.stringify(eleventh.body)}`);
    });

    it('another /64 (and an IPv4 client) still has its own budget (control)', async () => {
        assert.notStrictEqual((await probe('2001:db8:5:6::1')).status, 429);
        assert.notStrictEqual((await probe('198.51.100.7')).status, 429);
    });
});

// EVERY per-IP limiter index.ts mounts, each through its own budget. The probes are chosen to be answered
// without a database (an unknown path below the limiter's mount, or the exact route with an empty body):
// what is measured is the limiter, which counts a request before anything after it runs.
describe('every per-IP limiter of the real app counts a /64 as one client', () => {
    let app: any;
    const configManager = require('../core/configManager');
    const real = { isInstalled: configManager.isInstalled, getConfig: configManager.getConfig };
    const savedEmbedded = process.env.WORDJS_EMBEDDED;
    const collab = require('../core/collab-rooms');
    const savedConns = collab.CONFIG.MAX_CONNS_PER_USER_POST;
    const savedConsole = { log: console.log, warn: console.warn, error: console.error };
    const P = config.api.prefix;

    // The collaboration budget is DERIVED from collab-rooms' CONFIG (index.ts collabWindowMax: 10 frames/s
    // × MAX_CONNS_PER_USER_POST × 60 s × 2, read at the first collab request), 3600 per minute as shipped.
    // Scaled down through that same input so the budget is 60 and the test sends 61 requests, not 3601.
    const COLLAB_CONNS = 0.05;

    interface LimiterCase { name: string; budget: number; message: string; probe: (from: string) => any }
    const CASES: LimiterCase[] = [
        { name: 'apiLimiter (global, /api/v1)', budget: 80, message: 'Too many requests, please try again later.',
            probe: (from) => request(app).get(`${P}/rate-probe-api`).set('X-Forwarded-For', from) },
        { name: 'collabLimiter (/collab)', budget: 60, message: 'Too many collaboration requests, please try again later.',
            probe: (from) => request(app).get(`${P}/collab/rate-probe`).set('X-Forwarded-For', from) },
        { name: 'analyticsLimiter (POST /analytics/track)', budget: 60, message: 'Too many tracking events, please try again later.',
            probe: (from) => request(app).post(`${P}/analytics/track`).set('X-Forwarded-For', from).send({}) },
        { name: 'authLimiter (/auth/register)', budget: 10, message: 'Too many attempts, please try again later.',
            probe: (from) => request(app).get(`${P}/auth/register/rate-probe`).set('X-Forwarded-For', from) },
        // Failed attempts only: an unknown path below /auth/login answers 404, which counts as a failure.
        { name: 'loginIpLimiter (/auth/login, failures)', budget: 8, message: 'Too many failed login attempts from your network, please try again later.',
            probe: (from) => request(app).get(`${P}/auth/login/rate-probe`).set('X-Forwarded-For', from) },
        { name: 'uploadLimiter (/backups, /media, /themes/upload, /plugins/upload)', budget: 50, message: 'Too many file uploads, please try again later.',
            probe: (from) => request(app).get(`${P}/backups/rate-probe`).set('X-Forwarded-For', from) },
        { name: 'formsSubmitLimiter (POST /forms/submit)', budget: 10, message: 'Too many form submissions, please try again later.',
            probe: (from) => request(app).post(`${P}/forms/submit`).set('X-Forwarded-For', from).send({}) },
        { name: 'setupLimiter (/setup)', budget: 20, message: 'Too many setup attempts, please try again later.',
            probe: (from) => request(app).get(`${P}/setup/rate-probe`).set('X-Forwarded-For', from) },
    ];

    before(() => {
        delete process.env.WORDJS_EMBEDDED;
        collab.CONFIG.MAX_CONNS_PER_USER_POST = COLLAB_CONNS;
        app = require('../index');
        configManager.isInstalled = () => true;
        configManager.getConfig = () => ({ installedAt: '2020-01-01T00:00:00.000Z', dbDriver: config.dbDriver });
        // The probes reach handlers that log (a 404, a refused CSRF); written asynchronously between the
        // runner's own frames, those lines can corrupt them, so they are held for this suite.
        console.log = console.warn = console.error = () => {};
    });
    after(() => {
        Object.assign(console, savedConsole);
        collab.CONFIG.MAX_CONNS_PER_USER_POST = savedConns;
        configManager.isInstalled = real.isInstalled;
        configManager.getConfig = real.getConfig;
        if (savedEmbedded === undefined) delete process.env.WORDJS_EMBEDDED; else process.env.WORDJS_EMBEDDED = savedEmbedded;
    });

    CASES.forEach((c, i) => {
        // A /56 of its own per limiter, so no case spends another's budget (the global bucket included):
        // the client's /64 is <block>:aa00::/64, its neighbour <block>:aa01::/64 shares the /56.
        const block = `2001:db8:${(0x700 + i).toString(16)}`;
        it(`${c.name}: ${c.budget} addresses of one /64 spend one budget; the next is refused, the neighbouring /64 is not`, async () => {
            for (let n = 1; n <= c.budget; n++) {
                const r = await c.probe(`${block}:aa00::${n.toString(16)}`);
                assert.notStrictEqual(r.status, 429, `${c.name}: request ${n} of ${c.budget} was already limited (${JSON.stringify(r.body)})`);
            }
            const over = await c.probe(`${block}:aa00:ffff:ffff:ffff:fffe`);
            assert.strictEqual(over.status, 429, `${c.name}: the /64 got a fresh budget (${over.status})`);
            assert.strictEqual(over.body && over.body.error, c.message, `${c.name}: refused by another limiter: ${JSON.stringify(over.body)}`);
            // Controls: the next /64 inside the same /56 (express-rate-limit's own IPv6 default would group
            // them), and an IPv4 client, each still have a budget of their own.
            assert.notStrictEqual((await c.probe(`${block}:aa01::1`)).status, 429, `${c.name}: the neighbouring /64 shares the bucket`);
            assert.notStrictEqual((await c.probe(`198.51.${100 + i}.9`)).status, 429, `${c.name}: an IPv4 client shares the bucket`);
        });
    });
});

// The twin consumer outside index.ts: routes/comments.ts builds its own limiter (5 anonymous comments per
// 10 minutes) with its own key — `ip:<identity>` for a guest. Driven through the real router.
describe('the comment limiter counts a /64 as one guest', () => {
    let host: any, postId = 0;

    before(async () => {
        const database = require('../config/database');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        await require('../core/post-types').initPostTypes();
        await require('../core/roles').loadRoles();
        const db = database.getDbAsync();
        const r = await db.run(
            `INSERT INTO posts (author_id, post_date, post_date_gmt, post_content, post_title, post_status, post_name, post_type, post_modified, post_modified_gmt, comment_status)
             VALUES (1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '<p>x</p>', 'Open post', 'publish', 'open-post', 'post', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'open')`);
        postId = Number(r.lastID);
        host = express();
        host.set('trust proxy', 1);
        host.use(express.json());
        host.use('/api/v1/comments', require('../routes/comments'));
    });
    after(async () => {
        try { await require('../config/database').closeDatabase(); } catch { /* */ }
        for (const f of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
    });

    const comment = (from: string, n: number) => request(host).post('/api/v1/comments').set('X-Forwarded-For', from)
        .send({ post: postId, content: `comment number ${n} from ${from}`, author_name: 'Guest', author_email: 'guest@example.com' });

    it('five guests of one /64 spend one budget: the sixth address of it is refused', async () => {
        for (let i = 1; i <= 5; i++) {
            const r = await comment(`2001:db8:c0:1::${i}`, i);
            assert.strictEqual(r.status, 201, `comment ${i}: ${r.status} ${JSON.stringify(r.body)}`);
        }
        const sixth = await comment('2001:db8:c0:1:abcd::6', 6);
        assert.strictEqual(sixth.status, 429, `the /64 got a fresh budget: ${sixth.status} ${JSON.stringify(sixth.body)}`);
        assert.strictEqual(sixth.body.code, 'rest_comment_rate_limited');
    });

    it('a guest of another /64 still comments (control)', async () => {
        const r = await comment('2001:db8:c0:2::1', 7);
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    });
});

describe('a plugin route\'s req.clientKey is one key per /64', () => {
    const SLUG = `wjs-clientkey-${process.pid}`;
    let dir = '';
    let host: any;
    let isolate: any;

    before(async () => {
        isolate = require('../core/plugin-isolate');
        host = express();
        host.set('trust proxy', 1); // a fronting proxy the host trusts, as behind the gateway
        host.use(express.json());
        require('../core/appRegistry').setApp(host);
        dir = path.join(path.resolve(__dirname, '../../plugins'), SLUG);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SLUG, isolated: true, permissions: [{ scope: 'express', access: 'register_route' }] }));
        require('../core/plugin-permissions')._setGrantsInMemory(SLUG, ['express:register_route']);
        fs.writeFileSync(path.join(dir, 'index.js'),
            "exports.init = function (wordjs) {\n" +
            "  wordjs.http.route('get', '/whoami', (req, res) => res.status(200).json({ key: req.clientKey || null }));\n" +
            "};\n");
        await isolate.loadIsolatedPlugin(SLUG, path.join(dir, 'index.js'));
    });
    after(() => {
        try { isolate.unloadIsolatedPlugin(SLUG); } catch { /* */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    });

    const keyFrom = async (from: string): Promise<string> => {
        const r = await request(host).get(`/api/v1/plugin/${SLUG}/whoami`).set('X-Forwarded-For', from);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.match(String(r.body.key), /^[0-9a-f]{24}$/, `no clientKey: ${JSON.stringify(r.body)}`);
        return r.body.key;
    };

    it('two addresses of one /64 are the same caller to the plugin', async () => {
        const a = await keyFrom('2001:db8:aa:bb::1');
        assert.strictEqual(await keyFrom('2001:db8:aa:bb:dead:beef:0:2'), a);
    });

    it('another /64 and two IPv4 clients are different callers (control)', async () => {
        const a = await keyFrom('2001:db8:aa:bb::1');
        assert.notStrictEqual(await keyFrom('2001:db8:aa:bc::1'), a);
        assert.notStrictEqual(await keyFrom('203.0.113.5'), await keyFrom('203.0.113.6'));
    });
});
