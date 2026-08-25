/**
 * THE ERROR-DISCLOSURE CLASS — what an UNEXPECTED failure is allowed to tell the caller.
 *
 * middleware/errorHandler rendered `err.code` and `err.message` for every error it was handed. For
 * the errors this codebase raises on purpose that is the API contract. For an error that merely
 * ESCAPED, the `code` and `message` belong to whatever threw it — which, in a CMS, is nearly always
 * the database driver. Against a real PostgreSQL an anonymous GET whose `:id` parsed to NaN answered
 *
 *     500 {"code":"22P02","message":"invalid input syntax for type integer: \"NaN\"","data":{"status":500}}
 *
 * publishing a raw SQLSTATE as this API's error code. MySQL answers the same shape with
 * ER_BAD_FIELD_ERROR and a fragment of the SQL.
 *
 * The global handler is not the only surface: routes/ is full of fallback catch-alls that answer a
 * 5xx with `e.message` directly (notifications, health, certs, marketplace, plugins, setup). Fixing
 * one and leaving the rest is how this class stayed open. This file therefore tests the RULE, at
 * more than one surface:
 *
 *   A. the global handler, with errors produced by REAL engines (never fabricated here — a probe a
 *      test invents proves only that the test and the code agree);
 *   B. the route-local catch-alls, driven with those SAME real driver errors, by invoking the real
 *      route handlers out of their routers (no auth, no DB needed — the disclosure is in the catch);
 *   C. deliberate API errors — the ones carrying the HTTP status their thrower chose — still render
 *      their own message, code, `data.params` and `details`, byte for byte;
 *   D. a derivation over routes/ + middleware/ so a NEW fallback catch-all cannot reopen the class.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
// Route modules pull in config/database; keep them off any real database file.
config.dbPath = path.join(os.tmpdir(), `wjs-disclosure-${STAMP}.db`);

const express = require('express');
const request = require('supertest');
const { errorHandler, asyncHandler } = require('../middleware/errorHandler');
const { InvalidQueryParamError } = require('../core/query-params');

const PROBE_TABLE = 'wjs_disclosure_probe';

// clearTimeout on the loser, or the ref'd timer keeps this subprocess alive past the suite and
// --test-force-exit kills it mid-IPC (see tests/driver-conformance.test.ts for the full story).
const withTimeout = (p: Promise<any>, ms: number) => {
    let timer: any;
    return Promise.race([
        p,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms); }),
    ]).finally(() => clearTimeout(timer));
};

function skipOrFail(t: any, reason: string): void {
    if (process.env.WORDJS_CI_DB === '1') assert.fail(reason);
    return t.skip(reason);
}

/** A real driver error, captured from a real engine — plus the driver that produced it. */
interface EngineProbe { name: string; driver: any; error: any; }
const engines: EngineProbe[] = [];

/**
 * Bind NaN into an integer comparison on a real engine and keep the error the engine raised.
 * This is the exact shape the previous round documented in routes/revisions.ts.
 */
async function captureEngineError(name: string, driver: any): Promise<void> {
    await withTimeout(driver.connect(), 6000);
    await driver.exec(`CREATE TABLE IF NOT EXISTS ${PROBE_TABLE} (id INTEGER PRIMARY KEY, label TEXT)`);
    try {
        await driver.get(`SELECT * FROM ${PROBE_TABLE} WHERE id = ?`, [NaN]);
    } catch (e: any) {
        engines.push({ name, driver, error: e });
        return;
    }
    // SQLite answers "no row" here; a server engine must reject the bind. If one silently accepts it
    // there is nothing to disclose and nothing to test, so say so loudly rather than pass by default.
    throw new Error(`${name} accepted a NaN bind — no driver error to test disclosure with`);
}

before(async () => {
    try {
        const pg = require('../drivers/postgres');
        pg.config = {
            host: process.env.PGHOST || '127.0.0.1',
            port: Number(process.env.PGPORT) || 5432,
            user: process.env.PGUSER || 'postgres',
            password: process.env.PGPASSWORD ?? 'password',
            name: process.env.PGDATABASE || 'postgres',
            ssl: false,
        };
        await captureEngineError('postgres', pg);
    } catch (e: any) { console.log(`[disclosure] postgres unavailable: ${e && e.message}`); }

    try {
        const my = require('../drivers/mysql');
        my.config = {
            host: process.env.MYSQL_HOST || '127.0.0.1',
            port: Number(process.env.MYSQL_PORT) || 3306,
            user: process.env.MYSQL_USER || 'root',
            password: process.env.MYSQL_PASSWORD ?? 'password',
            name: process.env.MYSQL_DB || 'wordjs',
        };
        await captureEngineError('mysql', my);
    } catch (e: any) { console.log(`[disclosure] mysql unavailable: ${e && e.message}`); }
});

after(async () => {
    for (const e of engines) {
        try { await e.driver.exec(`DROP TABLE IF EXISTS ${PROBE_TABLE}`); } catch { /* best effort */ }
        try { await e.driver.close(); } catch { /* best effort */ }
    }
    for (const f of [config.dbPath, config.dbPath + '-wal', config.dbPath + '-shm']) {
        try { fs.rmSync(f, { force: true }); } catch { /* */ }
    }
});

/**
 * Everything an engine puts in an error that must never reach a caller: its own words, its own
 * error code, the SQL it choked on, and the host it was talking to.
 */
function disclosureNeedles(err: any): string[] {
    const needles: string[] = [];
    for (const v of [err && err.message, err && err.code, err && err.sqlState, err && err.sqlMessage, err && err.routine, err && err.file]) {
        if (typeof v === 'string' && v.length >= 4) needles.push(v);
    }
    return needles;
}

/** Every string the body would put in front of a caller, at any depth. */
function payloadStrings(value: any, into: string[] = []): string[] {
    if (typeof value === 'string') into.push(value);
    else if (Array.isArray(value)) for (const v of value) payloadStrings(v, into);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) payloadStrings(v, into);
    return into;
}

function assertNoDisclosure(where: string, payload: any, err: any): void {
    // Match on the DECODED strings, not on JSON.stringify(payload): a driver message containing a
    // quote (`invalid input syntax for type integer: "NaN"`) comes back escaped in the encoded form,
    // so an `includes()` over it silently misses the very disclosure being tested. That hole made
    // this test pass against the unfixed route-local catch-alls on its first run.
    const rendered = payloadStrings(payload);
    const shown = JSON.stringify(payload);
    for (const needle of disclosureNeedles(err)) {
        assert.ok(
            !rendered.some((s) => s.includes(needle)),
            `${where}: the response disclosed the driver's own text ${JSON.stringify(needle)} — body was ${shown}`,
        );
    }
    // The engine's SQLSTATE / errno must not be published as this API's error code either.
    if (payload && typeof payload === 'object' && typeof (payload as any).code === 'string') {
        assert.ok(
            /^rest_[a-z0-9_]+$/.test((payload as any).code),
            `${where}: 'code' must be one of this API's own codes, got ${JSON.stringify((payload as any).code)}`,
        );
    }
}

// ── A. the global handler, anonymous caller, real engines ────────────────────────────────────────

test('A. an unexpected driver failure reaching the global handler tells an anonymous caller nothing about the engine', async (t: any) => {
    if (engines.length === 0) return skipOrFail(t, 'no reachable Postgres or MySQL to produce a real driver error');

    for (const { name, driver } of engines) {
        const app = express();
        // No authenticate, no isAdmin: the public-route shape, which is how the skeptic reached it.
        app.get('/anon/:id', asyncHandler(async (req: any, res: any) => {
            const id = parseInt(req.params.id, 10); // 'abc' -> NaN
            const row = await driver.get(`SELECT * FROM ${PROBE_TABLE} WHERE id = ?`, [id]);
            res.json({ row: row || null });
        }));
        app.use(errorHandler);

        const res = await request(app).get('/anon/abc');
        assert.strictEqual(res.status, 500, `${name}: an unexpected failure is still a 500`);
        const real = engines.find((e) => e.name === name)!.error;
        assertNoDisclosure(`global handler / ${name}`, res.body, real);
        assert.strictEqual(res.body.code, 'rest_internal_error', `${name}: body was ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.data.status, 500);
    }
});

// ── B. the route-local catch-alls, driven with the SAME real driver errors ───────────────────────

/** The route's OWN handler, past its auth middleware — the catch-all under test is inside it. */
function routeHandler(router: any, method: string, routePath: string): any {
    for (const layer of router.stack || []) {
        const r = layer.route;
        if (!r || r.path !== routePath || !r.methods || !r.methods[method]) continue;
        const stack = r.stack || [];
        return stack[stack.length - 1].handle;
    }
    throw new Error(`no ${method.toUpperCase()} ${routePath} in this router`);
}

function fakeRes() {
    const out: any = { statusCode: 200, body: undefined };
    const res: any = {
        status(c: number) { out.statusCode = c; return res; },
        json(b: any) { out.body = b; return res; },
        send(b: any) { out.body = b; return res; },
        setHeader() { return res; },
        end() { return res; },
    };
    return { res, out };
}

/** Each twin: the module whose service throws, the method to poison, and the route that catches it. */
const TWINS = [
    {
        site: 'routes/notifications.ts GET /',
        service: '../core/notifications', method: 'getNotifications',
        router: '../routes/notifications', verb: 'get', path: '/',
        req: { user: { id: 1 }, params: {}, query: {}, body: {} },
    },
    {
        site: 'routes/health.ts GET /details',
        service: '../core/system-health', method: 'getFullStatus',
        router: '../routes/health', verb: 'get', path: '/details',
        req: { user: { id: 1 }, params: {}, query: {}, body: {} },
    },
    {
        site: 'routes/certs.ts GET /config',
        service: '../core/cert-manager', method: 'getConfig',
        router: '../routes/certs', verb: 'get', path: '/config',
        req: { user: { id: 1 }, params: {}, query: {}, body: {} },
    },
];

test('B. the route-local 5xx catch-alls do not disclose the driver error either', async (t: any) => {
    if (engines.length === 0) return skipOrFail(t, 'no reachable engine to produce a real driver error');
    const real = engines[0].error;

    for (const twin of TWINS) {
        const service = require(twin.service);
        const original = service[twin.method];
        service[twin.method] = async () => { throw real; };
        try {
            const handler = routeHandler(require(twin.router), twin.verb, twin.path);
            const { res, out } = fakeRes();
            await handler(twin.req, res, () => { /* these routes catch; next() is not the path */ });
            assert.ok(out.statusCode >= 500, `${twin.site}: expected a 5xx, got ${out.statusCode}`);
            assertNoDisclosure(twin.site, out.body, real);
        } finally {
            service[twin.method] = original;
        }
    }
});

// ── C. deliberate API errors keep their bodies ───────────────────────────────────────────────────

test('C. an error carrying the status its thrower chose still renders its own message', async () => {
    const app = express();
    // The rest_invalid_param shape from core/query-params — clients read data.params.
    app.get('/scalar', asyncHandler(async () => { throw new InvalidQueryParamError('force'); }));
    // The shape core/plugin-origins throws: an explicit status plus a designed message.
    app.get('/origin', asyncHandler(async () => {
        throw Object.assign(new Error("Refused: 'demo' was installed from a different source."), {
            status: 409, code: 'originMismatch',
        });
    }));
    // An explicit 5xx is still deliberate: someone chose it, so its words are part of the contract.
    app.get('/unavailable', asyncHandler(async () => {
        throw Object.assign(new Error('The search index is rebuilding.'), { status: 503, code: 'rest_unavailable' });
    }));
    // A structured payload (plugin validation split) must survive too.
    app.get('/details', asyncHandler(async () => {
        throw Object.assign(new Error('Plugin rejected.'), {
            status: 400, code: 'rest_plugin_invalid', details: { missingPermissions: ['db'], dangerousCalls: [] },
        });
    }));
    app.use(errorHandler);

    const scalar = await request(app).get('/scalar');
    assert.strictEqual(scalar.status, 400);
    assert.strictEqual(scalar.body.code, 'rest_invalid_param');
    assert.strictEqual(scalar.body.message, "Invalid parameter 'force': expected a string.");
    assert.deepStrictEqual(scalar.body.data.params, { force: 'Expected a string.' });

    const origin = await request(app).get('/origin');
    assert.strictEqual(origin.status, 409);
    assert.strictEqual(origin.body.code, 'originMismatch');
    assert.match(origin.body.message, /installed from a different source/);

    const unavailable = await request(app).get('/unavailable');
    assert.strictEqual(unavailable.status, 503);
    assert.strictEqual(unavailable.body.message, 'The search index is rebuilding.');

    const details = await request(app).get('/details');
    assert.strictEqual(details.status, 400);
    assert.deepStrictEqual(details.body.details, { missingPermissions: ['db'], dangerousCalls: [] });
});

// ── D. no fallback catch-all in routes/ or middleware/ may reopen the class ──────────────────────

test('D. every 5xx response built from a caught error goes through the one disclosure rule', () => {
    const root = path.resolve(__dirname, '..');
    const dirs = ['routes', 'middleware'];
    // A read of a caught error's own text: `e.message`, `err && err.message`, `error?.stack`, ...
    const ERR_TEXT = /\b((?:e|err|error|ex|valErr|cause)[A-Za-z0-9_$]*)\s*(?:&&\s*\1\s*)?[?]?\.(?:message|stack)\b/;
    const offenders: string[] = [];

    for (const dir of dirs) {
        const abs = path.join(root, dir);
        for (const file of fs.readdirSync(abs)) {
            if (!file.endsWith('.ts')) continue;
            const rel = `src/${dir}/${file}`;
            const lines = fs.readFileSync(path.join(abs, file), 'utf8').replace(/\r\n/g, '\n').split('\n');
            lines.forEach((line: string, i: number) => {
                if (!ERR_TEXT.test(line)) return;
                if (/console\.(error|warn|log|info|debug)/.test(line)) return; // logging is server-side, and stays
                // Does this line put that text in a 5xx response?
                const explicit = /\.status\(\s*5\d\d\s*\)|status\s*:\s*5\d\d\b/.test(line);
                const fallback = /\.status\(\s*[A-Za-z_$][\w$.]*\s*\|\|\s*5\d\d\s*\)|status\s*:\s*[A-Za-z_$][\w$.]*\s*\|\|\s*5\d\d/.test(line);
                if (!explicit && !fallback) return;
                if (/publicErrorText\s*\(/.test(line)) return; // routed through the shared rule
                offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
            });
        }
    }

    assert.deepStrictEqual(
        offenders, [],
        'these 5xx responses hand a caught error\'s own text to the caller; route them through ' +
        'publicErrorText() from middleware/errorHandler:\n  ' + offenders.join('\n  '),
    );
});
