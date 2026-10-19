/**
 * EVERY PER-ROUTE LIMITER SEES EVERY SPELLING OF ITS PATH — end to end, on the REAL app.
 *
 * index.ts mounts each per-route limiter as an Express PREFIX mount ('/api/v1/auth/login', '/api/v1/media',
 * …). A prefix mount matches path segments literally, so a doubled slash ('/api/v1//auth/login',
 * '/api/v1/auth//login') matched none of them — while the router that finally serves the request trimmed
 * the empty segment and reached the same handler. index.ts now collapses runs of '/' in the path before
 * any limiter is mounted.
 *
 * How each case proves it: the limiter's WHOLE budget is spent using only the odd spellings, then one
 * canonical request must be refused with that limiter's own message. A spelling that walks past the
 * limiter spends nothing, and the canonical request gets through.
 *
 * MUTATION PROOF: remove the slash-collapsing middleware from index.ts and every case below fails.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

const config = require('../config/app');
config.dbPath = path.join(os.tmpdir(), `wjs-limiter-spelling-${process.pid}-${Date.now()}.db`);
config.dbDriver = 'sqlite-native';
// Read once, when index.ts builds its limiters: the global bucket must stay above every per-route budget
// (so it never answers first), and the failed-login backstop is small.
config.api.rateLimit.max = 2000;
config.auth.loginIpFailPerHour = 6;

const request = require('supertest');

describe('per-route limiters cannot be stepped around with a doubled slash', () => {
    let app: any;
    const configManager = require('../core/configManager');
    const real = { isInstalled: configManager.isInstalled, getConfig: configManager.getConfig };
    const savedEmbedded = process.env.WORDJS_EMBEDDED;
    const savedConsole = { log: console.log, warn: console.warn, error: console.error };
    const P = config.api.prefix; // '/api/v1'

    type Method = 'get' | 'post';
    interface Case { name: string; method: Method; sub: string; budget: number; message: string }
    // `sub` is the path below the prefix. GET probes go one unknown segment deeper (answered 404 after the
    // limiter counted it — a failure, so the failed-only login backstop counts it too); the MFA subtree only
    // throttles state-changing methods and forms/submit is an exact POST mount, so those are POSTs.
    const CASES: Case[] = [
        { name: 'loginIpLimiter /auth/login', method: 'get', sub: '/auth/login/rate-probe', budget: 6,
            message: 'Too many failed login attempts from your network, please try again later.' },
        { name: 'loginIpLimiter /auth/mfa (POST subtree)', method: 'post', sub: '/auth/mfa/rate-probe', budget: 6,
            message: 'Too many failed login attempts from your network, please try again later.' },
        { name: 'authLimiter /auth/register', method: 'get', sub: '/auth/register/rate-probe', budget: 10,
            message: 'Too many attempts, please try again later.' },
        { name: 'authLimiter /auth/forgot-password', method: 'get', sub: '/auth/forgot-password/rate-probe', budget: 10,
            message: 'Too many attempts, please try again later.' },
        { name: 'authLimiter /auth/reset-password', method: 'get', sub: '/auth/reset-password/rate-probe', budget: 10,
            message: 'Too many attempts, please try again later.' },
        { name: 'authLimiter /auth/verify-email', method: 'get', sub: '/auth/verify-email/rate-probe', budget: 10,
            message: 'Too many attempts, please try again later.' },
        { name: 'uploadLimiter /media', method: 'get', sub: '/media/rate-probe', budget: 50,
            message: 'Too many file uploads, please try again later.' },
        { name: 'uploadLimiter /plugins/upload', method: 'get', sub: '/plugins/upload/rate-probe', budget: 50,
            message: 'Too many file uploads, please try again later.' },
        { name: 'formsSubmitLimiter POST /forms/submit', method: 'post', sub: '/forms/submit', budget: 10,
            message: 'Too many form submissions, please try again later.' },
        { name: 'setupLimiter /setup', method: 'get', sub: '/setup/rate-probe', budget: 20,
            message: 'Too many setup attempts, please try again later.' },
        { name: 'mcpLimiter /mcp', method: 'get', sub: '/mcp/rate-probe', budget: 240,
            message: 'Too many requests from this agent, please slow down.' },
    ];

    /** The odd spellings of one path: a doubled slash after the prefix, inside the path, and both. */
    const spellings = (sub: string): string[] => {
        const segs = sub.split('/').filter(Boolean);
        return [
            `${P}//${segs.join('/')}`,
            `${P}/${segs[0]}//${segs.slice(1).join('/')}`,
            `${P}///${segs[0]}///${segs.slice(1).join('//')}`,
        ];
    };

    const send = (method: Method, url: string, from: string) => {
        const r = request(app)[method](url).set('X-Forwarded-For', from);
        return method === 'post' ? r.send({}) : r;
    };

    before(() => {
        delete process.env.WORDJS_EMBEDDED;
        app = require('../index');
        configManager.isInstalled = () => true;
        configManager.getConfig = () => ({ installedAt: '2020-01-01T00:00:00.000Z', dbDriver: config.dbDriver });
        console.log = console.warn = console.error = () => {};
    });
    after(() => {
        Object.assign(console, savedConsole);
        configManager.isInstalled = real.isInstalled;
        configManager.getConfig = real.getConfig;
        if (savedEmbedded === undefined) delete process.env.WORDJS_EMBEDDED; else process.env.WORDJS_EMBEDDED = savedEmbedded;
    });

    CASES.forEach((c, i) => {
        // An address of its own per case: authLimiter and uploadLimiter are one bucket shared by several mounts.
        const from = `198.51.100.${10 + i}`;
        it(`${c.name}: the budget spent through doubled slashes is the canonical path's budget`, async () => {
            const odd = spellings(c.sub);
            for (let n = 0; n < c.budget; n++) {
                const url = odd[n % odd.length];
                const r = await send(c.method, url, from);
                assert.notStrictEqual(r.status, 429, `${c.name}: ${url} limited after only ${n} requests`);
            }
            const canonical = await send(c.method, `${P}${c.sub}`, from);
            assert.strictEqual(canonical.status, 429,
                `${c.name}: ${c.budget} requests spelled with doubled slashes never reached the limiter (${canonical.status})`);
            const body = canonical.body || {};
            const text = typeof body.error === 'string' ? body.error : (body.error && body.error.message);
            assert.strictEqual(text, c.message, `${c.name}: refused by another limiter: ${JSON.stringify(body)}`);
        });
    });
});
