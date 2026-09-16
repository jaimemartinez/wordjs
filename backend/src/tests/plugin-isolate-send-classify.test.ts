/**
 * WordJS — the SEND-SIDE twin of the IPC-frame containment guard.
 *
 * THE BUG THIS PINS. The host forwards every request to an isolated plugin's route with `child.send()`
 * over a `serialization:'advanced'` channel. Structured clone is recursive, so a JSON body nested a few
 * thousand levels deep (a 12 KB request anyone can craft) makes `child.send()` throw
 *     RangeError: Maximum call stack size exceeded
 * SYNCHRONOUSLY — while `child.connected` stays true and the child is perfectly healthy. The adapter used
 * to swallow every throw as "the child is gone", so rpcSend rejected with "Isolated plugin '<slug>' is not
 * running" and the route answered 502 with that false detail. The message, not the channel, was the
 * problem: the right answer is a 400 and NOTHING happening to the isolate.
 *
 * Three layers are pinned: the pure classifier (channel-gone vs message-unsendable), the premise itself
 * (a real advanced-serialization fork: the deep send throws AND the child stays connected — if a Node
 * upgrade ever changes that, this fails loudly instead of the classifier silently becoming dead code),
 * and the end-to-end shape through a REAL isolate + host Express: 400 on the deep body, and the same
 * plugin still answers the next request (no terminate, no restart, health still 'running').
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

require('../config/app'); // preload (trusted context)
const express = require('express');
const request = require('supertest');
const isolate = require('../core/plugin-isolate');
const { loadIsolatedPlugin, unloadIsolatedPlugin, getIsolateStatus } = isolate;
const {
    __classifySendFailure: classifySendFailure,
    __PluginRequestUnserializableError: PluginRequestUnserializableError,
} = isolate;
const { setApp } = require('../core/appRegistry');

/** An object nested `depth` levels deep: `{ a: { a: { a: ... } } }`. */
function deepObject(depth: number): any {
    const root: any = {};
    let cur = root;
    for (let i = 0; i < depth; i++) { cur.a = {}; cur = cur.a; }
    return root;
}

// ---------------------------------------------------------------------------------------------------
// 1. The pure classifier.
// ---------------------------------------------------------------------------------------------------

test('classifier: a RangeError on a CONNECTED channel is the message, not the channel', () => {
    assert.strictEqual(classifySendFailure(new RangeError('Maximum call stack size exceeded'), true), 'unserializable');
    // Other "cannot clone this" shapes: DataCloneError-like and Node's arg-type error.
    assert.strictEqual(classifySendFailure(Object.assign(new Error('could not be cloned'), { name: 'DataCloneError' }), true), 'unserializable');
    assert.strictEqual(classifySendFailure(Object.assign(new TypeError(), { code: 'ERR_INVALID_ARG_TYPE' }), true), 'unserializable');
});

test('classifier: a closed-channel code means not-running even when `connected` still reads true', () => {
    assert.strictEqual(classifySendFailure(Object.assign(new Error(), { code: 'ERR_IPC_CHANNEL_CLOSED' }), true), 'not-running');
    assert.strictEqual(classifySendFailure(Object.assign(new Error(), { code: 'EPIPE' }), true), 'not-running');
    assert.strictEqual(classifySendFailure(Object.assign(new Error(), { code: 'ERR_STREAM_DESTROYED' }), true), 'not-running');
    assert.strictEqual(classifySendFailure(Object.assign(new Error(), { code: 'ERR_IPC_CHANNEL_CLOSED' }), false), 'not-running');
});

test('classifier: a disconnected channel is not-running whatever the error looks like', () => {
    assert.strictEqual(classifySendFailure(new RangeError('Maximum call stack size exceeded'), false), 'not-running');
    assert.strictEqual(classifySendFailure(null, false), 'not-running');
    assert.strictEqual(classifySendFailure(undefined, false), 'not-running');
});

test('the unserializable error carries the 400 status finalHandler keys on', () => {
    const e = new PluginRequestUnserializableError();
    assert.ok(e instanceof Error);
    assert.strictEqual(e.statusCode, 400);
    assert.strictEqual(e.code, 'ERR_PLUGIN_REQUEST_UNSERIALIZABLE');
    assert.match(e.message, /not serializable|too deep/);
});

// ---------------------------------------------------------------------------------------------------
// 2. The premise, on a REAL advanced-serialization fork (mutation-proof of the classifier's reason to exist).
// ---------------------------------------------------------------------------------------------------

const PROBE_CHILD = path.resolve(__dirname, 'fixtures', 'deep-send-probe-child.js');

test('premise: child.send() of a too-deep object throws synchronously and the child stays connected', async () => {
    const child = fork(PROBE_CHILD, [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
        // Wait for the child to be up so `connected` reflects a live channel, not a still-spawning one.
        await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('probe child did not report ready')), 15000);
            child.once('message', (m: any) => { if (m && m.ready) { clearTimeout(t); resolve(); } });
            child.once('exit', () => { clearTimeout(t); reject(new Error('probe child exited early')); });
        });
        assert.strictEqual(child.connected, true, 'precondition: channel is live');
        // A shallow message goes through — the channel works.
        assert.strictEqual(child.send({ shallow: true }), true);
        // The deep one throws SYNCHRONOUSLY...
        let thrown: any = null;
        try { child.send({ body: deepObject(5000) }); } catch (e) { thrown = e; }
        assert.ok(thrown, 'child.send() must throw for a too-deep object');
        assert.ok(thrown instanceof RangeError, `expected a RangeError, got ${thrown && thrown.constructor && thrown.constructor.name}`);
        assert.strictEqual(thrown.code, undefined, 'the depth overflow carries no channel error code');
        // ...and the channel is STILL connected: the message was the problem, not the child.
        assert.strictEqual(child.connected, true, 'the child must still be connected after the throw');
        assert.strictEqual(classifySendFailure(thrown, child.connected), 'unserializable');
    } finally {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
});

// ---------------------------------------------------------------------------------------------------
// 3. End to end: a deep body through a REAL isolate answers 400 and the plugin keeps running.
// ---------------------------------------------------------------------------------------------------

const SLUG = 'test-isolate-deep-body';
const dir = path.join(path.resolve(__dirname, '../../plugins'), SLUG);
const entry = path.join(dir, 'index.js');
const app = express();
// Default express.json() is 100 kb; a 5000-deep `{"a":` body is ~30 KB, well inside.
app.use(express.json());

before(async () => {
    setApp(app);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SLUG, isolated: true, permissions: [{ scope: 'express', access: 'register_route' }] }));
    require('../core/plugin-permissions')._setGrantsInMemory(SLUG, ['express:register_route']);
    fs.writeFileSync(entry,
        "exports.init = function (wordjs) {\n" +
        "  wordjs.http.route('get', '/ping', (req, res) => res.status(200).json({ ok: true }));\n" +
        "  wordjs.http.route('post', '/echo', (req, res) => res.status(200).json({ keys: Object.keys(req.body || {}) }));\n" +
        "};\n");
    await loadIsolatedPlugin(SLUG, entry);
});
after(() => {
    try { unloadIsolatedPlugin(SLUG); } catch { /* */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

test('e2e: a too-deep JSON body is a 400 (not a 502 blaming the plugin) and the isolate is untouched', async () => {
    const base = `/api/v1/plugin/${SLUG}`;
    // Precondition: the plugin is up and its POST route round-trips a normal body.
    const ok = await request(app).post(`${base}/echo`).send({ hello: 'world' });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.body, { keys: ['hello'] });
    const pidBefore = (isolate.getLivePids(SLUG) || [])[0];

    // The attack: a ~30 KB body nested 5000 levels deep.
    const deep = await request(app).post(`${base}/echo`).set('content-type', 'application/json').send(JSON.stringify(deepObject(5000)));
    assert.strictEqual(deep.status, 400, `expected 400, got ${deep.status} ${JSON.stringify(deep.body)}`);
    assert.strictEqual(deep.body.error, 'Bad request');
    assert.match(String(deep.body.detail), /not serializable|too deep/);
    assert.doesNotMatch(String(deep.body.detail), /not running/, 'the false "not running" detail must be gone');

    // The isolate did NOT die, was NOT terminated and was NOT restarted: same pid, health 'running',
    // and the very next request is served by it.
    const status = getIsolateStatus(SLUG);
    assert.strictEqual(status && status.state, 'running', `health must still be running, got ${JSON.stringify(status)}`);
    assert.strictEqual(status.restarts || 0, 0, 'no restart may have been counted');
    const pidAfter = (isolate.getLivePids(SLUG) || [])[0];
    assert.strictEqual(pidAfter, pidBefore, 'the same child must still be serving (no terminate/restart)');
    const again = await request(app).get(`${base}/ping`);
    assert.strictEqual(again.status, 200);
    assert.deepStrictEqual(again.body, { ok: true });

    // And a second deep body behaves the same — no strike accumulates toward a crash-loop cap.
    const deep2 = await request(app).post(`${base}/echo`).set('content-type', 'application/json').send(JSON.stringify(deepObject(5000)));
    assert.strictEqual(deep2.status, 400);
    assert.strictEqual((getIsolateStatus(SLUG) || {}).state, 'running');
});
