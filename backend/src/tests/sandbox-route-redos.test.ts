/**
 * A SANDBOXED PLUGIN CANNOT DoS THE HOST VIA A ReDoS ROUTE PATTERN.
 *
 * `wordjs.http.route(method, path, …)` sends `path` from the child to the host, which concatenates it
 * into an Express 4 route pattern. Express 4 compiles patterns with path-to-regexp 0.1.x, which passes a
 * `:param(<regex>)` custom regex straight into the router's matcher. So an unvalidated `path` let a
 * plugin inject a catastrophic-backtracking pattern (`/:p((a+)+b)`): ONE unauthenticated request to
 * `/api/v1/plugin/<slug>/aaaa…!` then pinned the SHARED host event loop for tens of seconds (measured:
 * 32 chars → ~22 s) — a full-site denial of service from an unprivileged sandboxed plugin.
 *
 * The host now allows only static segments, `:params` and a `*` wildcard in a plugin route path, and
 * rejects anything carrying regex structure. This test boots a REAL isolate that tries to register an
 * evil route and a benign one, and proves: the benign route works, the evil route is NOT mounted, and a
 * request that would have triggered the ReDoS returns immediately.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-redos-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const express = require('express');
const request = require('supertest');
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('../core/plugin-isolate');
const { setApp } = require('../core/appRegistry');

const PLUGINS_ROOT = path.resolve(__dirname, '../../plugins');
const SLUG = 'wjs-redos-probe';
const app = express();
app.use(express.json());

// The fixture registers a benign route and then tries every evil pattern it can. If the host validation
// works, only the benign one is mounted.
const INIT = String.raw`
  wordjs.http.route('get', '/ok', (req, res) => res.json({ ok: true }));
  for (const evil of ['/:p((a+)+b)', '/re(([a-z]+)+#)', '/x(y){1,40}', '/a[b]c', '/two/**/*/*']) {
    try { wordjs.http.route('get', evil, (req, res) => res.json({ reached: evil })); } catch (e) {}
  }
`;

let dir = '';
before(async () => {
    setApp(app);
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dir = path.join(PLUGINS_ROOT, SLUG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SLUG, isolated: true, permissions: [{ scope: 'express', access: 'register_route' }] }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'exports.init = function (wordjs) {\n' + INIT + '\n};\n');
    // Route registration now requires the express:register_route grant; grant it so the path-validation
    // (ReDoS) rules below are what decides which routes mount, not the grant gate.
    require('../core/plugin-permissions')._setGrantsInMemory(SLUG, ['express:register_route']);
    await loadIsolatedPlugin(SLUG, path.join(dir, 'index.js'));
    // Give the async register-route messages a moment to be processed host-side.
    await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
    try { await unloadIsolatedPlugin(SLUG); } catch { /* */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(TMP_DB, { force: true }); } catch { /* */ }
});

describe('plugin route path — no host ReDoS', () => {
    test('a benign route still mounts and responds (the validator did not over-restrict)', async () => {
        const res = await request(app).get(`/api/v1/plugin/${SLUG}/ok`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.ok, true);
    });

    test('the evil ReDoS route is NOT mounted, and a triggering request returns immediately', async () => {
        // If the evil pattern had been mounted, this input would pin the event loop for tens of seconds.
        const trigger = `/api/v1/plugin/${SLUG}/${'a'.repeat(40)}!`;
        const t0 = Date.now();
        const res = await request(app).get(trigger).timeout({ deadline: 4000 });
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 2000, `request took ${elapsed}ms — the ReDoS route appears to be mounted`);
        assert.strictEqual(res.status, 404, 'the evil route must not be mounted');
    });

    test('none of the evil patterns leaked through (only /ok exists under the namespace)', async () => {
        for (const p of [`/re/${'z'.repeat(20)}`, `/x/y`, `/a/b/c`]) {
            const res = await request(app).get(`/api/v1/plugin/${SLUG}${p}`).timeout({ deadline: 4000 });
            assert.strictEqual(res.status, 404, `an evil route unexpectedly matched ${p}`);
        }
    });
});
