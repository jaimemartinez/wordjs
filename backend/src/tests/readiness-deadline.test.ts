/**
 * /readyz DEADLINE — a database check that never answers must not leave the probe pending forever.
 *
 * createReadinessProbe shares one in-flight evaluation between callers. When checkDatabase() hung, that
 * evaluation never settled, `inflight` was never cleared, and every later /readyz waited on it: the
 * instance stayed "not ready" (no answer at all) until restart. The probe now races the check against a
 * deadline (3 s by default, WORDJS_READINESS_TIMEOUT_MS), answers 503 `db: 'timeout'`, and does not stack
 * a second query on the pool while the stalled one is still pending. The check carries the deadline to
 * the database as a server-side statement timeout on Postgres and MySQL (getWithTimeout).
 *
 * The SystemHealth and driver tests run the REAL modules (core/system-health.ts with a stand-in
 * database layer; the real Postgres/MySQL drivers over a recording pool).
 *
 * MUTATION PROOF: remove the withDeadline race in createReadinessProbe — the hang test never settles and
 * fails on its own timer; drop the `stalled` guard — the "no second query" test counts two; make
 * checkDatabase ignore `timeoutMs` — the SystemHealth test sees no timed query; drop SET LOCAL /
 * MAX_EXECUTION_TIME from a driver — its driver test fails.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createReadinessProbe, readinessTimeoutMs, DEFAULT_READINESS_TIMEOUT_MS } = require('../core/readiness');

const never = () => new Promise<never>(() => { /* a database that accepted the query and went silent */ });

function within(p: Promise<any>, ms: number, what: string): Promise<any> {
    let t: any;
    return Promise.race([p, new Promise<any>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} did not settle in ${ms} ms`)), ms); })])
        .finally(() => clearTimeout(t));
}

describe('readiness deadline', () => {
    const base = (over: any = {}) => ({ isInstalled: () => true, isBooted: () => true, ttlMs: 0, timeoutMs: 50, ...over });

    test('a hung database check answers 503 timeout, and the next probe evaluates afresh', async () => {
        const logged: unknown[] = [];
        let hang = true;
        let calls = 0;
        const probe = createReadinessProbe(base({
            checkDatabase: async () => { calls++; return hang ? never() : { status: 'OK' }; },
            onError: (e: unknown) => logged.push(e),
        }));
        const r = await within(probe(), 2000, 'the probe');
        assert.equal(r.statusCode, 503);
        assert.equal(r.body.status, 'not_ready');
        assert.equal((r.body.checks as any).db, 'timeout');
        assert.equal(r.body.error, 'Readiness check timed out.');
        assert.equal(logged.length, 1, 'the timeout is logged');
        // Concurrent callers during a hang all get the answer, not an endless wait.
        const many = await within(Promise.all([probe(), probe(), probe()]), 2000, 'concurrent probes');
        assert.ok(many.every((x: any) => x.statusCode === 503));
        assert.equal(calls, 1, 'no second query is stacked on the pool while the first is still stuck');
        hang = false;
    });

    test('once the stalled check settles, the probe recovers', async () => {
        let release: (v: any) => void = () => {};
        let first = true;
        const probe = createReadinessProbe(base({
            checkDatabase: async () => {
                if (first) { first = false; return new Promise((r) => { release = r; }); }
                return { status: 'OK' };
            },
        }));
        assert.equal((await within(probe(), 2000, 'probe')).statusCode, 503);
        release({ status: 'OK' });
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        const ok = await within(probe(), 2000, 'probe');
        assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
    });

    test('the deadline is handed to the check and is configurable', async () => {
        const seen: number[] = [];
        const probe = createReadinessProbe(base({ timeoutMs: 1234, checkDatabase: async (o: any) => { seen.push(o.timeoutMs); return { status: 'OK' }; } }));
        assert.equal((await probe()).statusCode, 200);
        assert.deepEqual(seen, [1234]);
        assert.equal(readinessTimeoutMs({}), DEFAULT_READINESS_TIMEOUT_MS);
        assert.equal(DEFAULT_READINESS_TIMEOUT_MS, 3000);
        assert.equal(readinessTimeoutMs({ WORDJS_READINESS_TIMEOUT_MS: '5000' }), 5000);
        assert.equal(readinessTimeoutMs({ WORDJS_READINESS_TIMEOUT_MS: 'nope' }), 3000);
        assert.equal(readinessTimeoutMs({ WORDJS_READINESS_TIMEOUT_MS: '5' }), 100);
    });

    test('index.ts wires the deadline into /readyz', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
        const block = src.slice(src.indexOf("require('./core/readiness')"), src.indexOf("app.get('/readyz'"));
        assert.match(block, /timeoutMs: readinessModule\.readinessTimeoutMs\(process\.env\)/);
        assert.match(block, /checkDatabase\(opts\)/);
    });
});

describe('SystemHealth.checkDatabase with a deadline (real module)', () => {
    test('runs the timed query when the driver supports one, the plain one otherwise', () => {
        const calls: any[] = [];
        const fakeDb: any = {
            getWithTimeout: async (sql: string, params: any[], ms: number) => { calls.push(['timed', sql, ms]); return { count: 1 }; },
            get: async (sql: string) => { calls.push(['plain', sql]); return { count: 1 }; },
        };
        const dbPath = require.resolve('../config/database');
        const saved = require.cache[dbPath];
        require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { db: {}, dbAsync: fakeDb } } as any;
        const shPath = require.resolve('../core/system-health');
        delete require.cache[shPath];
        try {
            const SystemHealth = require('../core/system-health');
            return (async () => {
                const ok = await SystemHealth.checkDatabase({ timeoutMs: 777 });
                assert.equal(ok.status, 'OK');
                assert.deepEqual(calls, [['timed', 'SELECT COUNT(*) AS count FROM users', 777]]);
                fakeDb.getWithTimeout = async () => { throw new Error('canceling statement due to statement timeout'); };
                const bad = await SystemHealth.checkDatabase({ timeoutMs: 777 });
                assert.equal(bad.status, 'ERROR');
            })();
        } finally {
            if (saved) require.cache[dbPath] = saved; else delete require.cache[dbPath];
        }
    });
});

describe('driver statement timeouts (real drivers, recording pool)', () => {
    test('Postgres: SET LOCAL statement_timeout inside one transaction; a failed connection is discarded', async () => {
        const pg = require('../drivers/postgres');
        const queries: string[] = [];
        let released: any = 'not released';
        let fail = false;
        const client = {
            query: async (sql: string) => {
                queries.push(sql);
                if (fail && /COUNT/.test(sql)) throw new Error('canceling statement due to statement timeout');
                return { rows: [{ count: 3 }] };
            },
            release: (destroy?: boolean) => { released = destroy; },
        };
        const savedPool = pg.pool;
        pg.pool = { connect: async () => client };
        try {
            const row = await pg.getWithTimeout('SELECT COUNT(*) AS count FROM users WHERE id > ?', [0], 2500);
            assert.deepEqual(row, { count: 3 });
            assert.equal(queries[0], 'BEGIN; SET LOCAL statement_timeout = 2500');
            assert.equal(queries[1], 'SELECT COUNT(*) AS count FROM users WHERE id > $1');
            assert.equal(queries[2], 'COMMIT');
            assert.equal(released, undefined, 'a healthy connection goes back to the pool');
            fail = true;
            await assert.rejects(pg.getWithTimeout('SELECT COUNT(*) AS count FROM users', [], 2500));
            assert.equal(released, true, 'a connection left mid-transaction is destroyed, not reused');
        } finally {
            pg.pool = savedPool;
        }
    });

    test('MySQL: MAX_EXECUTION_TIME hint plus the client-side timeout', async () => {
        const my = require('../drivers/mysql');
        const seen: any[] = [];
        const savedPool = my.pool;
        my.pool = { query: async (opts: any, params: any[]) => { seen.push([opts, params]); return [[{ count: 2 }]]; } };
        try {
            const row = await my.getWithTimeout('SELECT COUNT(*) AS count FROM users', [], 1500);
            assert.deepEqual(row, { count: 2 });
            assert.equal(seen[0][0].timeout, 1500);
            assert.match(seen[0][0].sql, /^SELECT \/\*\+ MAX_EXECUTION_TIME\(1500\) \*\/ COUNT\(\*\)/);
        } finally {
            my.pool = savedPool;
        }
    });
});
