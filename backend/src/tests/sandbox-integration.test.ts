/**
 * Request-time sandbox integration test.
 *
 * Proves the ALS-anchoring end-to-end: a route handler a plugin registers is sandboxed at
 * REQUEST time (not just during init). A plugin can touch its own dir, but is blocked from
 * fs outside its dir (no filesystem permission) and from child_process — even though the
 * handler runs detached on an HTTP request with empty AsyncLocalStorage.
 */

import type { Request, Response } from 'express';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const express = require('express');
const fs = require('fs');
const path = require('path');

const { installSecureRequire } = require('../core/secure-require');
const { anchorPluginRoutes } = require('../core/appRegistry');
const { runWithContext } = require('../core/plugin-context');

installSecureRequire();

const PLUGINS_DIR = path.resolve(__dirname, '../../plugins');
const SLUG = 'integ-sandbox-plugin';
const dir = path.join(PLUGINS_DIR, SLUG);
const outsideFile = path.resolve(__dirname, '../../package.json'); // exists, OUTSIDE the plugin dir

const app = express();
anchorPluginRoutes(app);

before(() => {
    fs.mkdirSync(dir, { recursive: true });
    // Manifest with NO permissions → plugin may only touch its own dir.
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SLUG, permissions: [] }));
    fs.writeFileSync(path.join(dir, 'data.txt'), 'owntext');

    // Register routes AS the plugin (registration happens inside its context, like init()).
    runWithContext(SLUG, () => {
        app.get('/own', (_req: Request, res: Response) => {
            try {
                const c = require('fs').readFileSync(path.join(dir, 'data.txt'), 'utf8');
                res.json({ ok: true, c });
            } catch (e) { res.status(500).json({ err: e.message }); }
        });
        app.get('/escape', (_req: Request, res: Response) => {
            try {
                require('fs').readFileSync(outsideFile, 'utf8');
                res.json({ ok: true }); // should NOT happen
            } catch (e) { res.status(403).json({ blocked: true, err: e.message }); }
        });
        app.get('/shell', (_req: Request, res: Response) => {
            try {
                require('child_process').execSync('echo x');
                res.json({ ok: true }); // should NOT happen
            } catch (e) { res.status(403).json({ blocked: true, err: e.message }); }
        });
    });
});

after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('plugin route can read its OWN dir at request time (no regression)', async () => {
    const r = await request(app).get('/own');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.c, 'owntext');
});

test('plugin route is BLOCKED reading OUTSIDE its dir at request time', async () => {
    const r = await request(app).get('/escape');
    assert.strictEqual(r.status, 403);
    assert.ok(r.body.blocked);
    assert.ok(/SECURITY BLOCK/i.test(r.body.err), 'must be a security block, not ENOENT: ' + r.body.err);
});

test('plugin route is BLOCKED from child_process at request time', async () => {
    const r = await request(app).get('/shell');
    assert.strictEqual(r.status, 403);
    assert.ok(r.body.blocked);
});
