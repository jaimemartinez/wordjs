/**
 * Plugin-sandbox hardening: admin-visible state + default-ON posture (audit FRENTE A, item 6).
 *
 * Two properties are pinned:
 *   1. Kernel hardening is ON BY DEFAULT — the config resolves useKernelHardening to true unless an
 *      operator explicitly opts out. (The "probe OK => active / probe fail => degraded" split is
 *      exercised by the platform probes, sandbox-parity workflow and sandbox-fail-closed.test.)
 *   2. The hardening state is VISIBLE to the admin on the settings payload they read (GET /settings/all),
 *      as a derived boolean `sandbox_hardening_degraded` plus the raw `sandbox_hardening_state` — the
 *      "looks secure but isn't" degraded state can no longer hide. It is DELIBERATELY NOT on the public
 *      /settings payload nor the public single-key route (leaking "OS backstop off" only helps an
 *      attacker). Mirrors the active_theme_missing derived-boolean pattern.
 *
 * node --test isolates this file in its own process, so the lazy hardening probe starts pristine and the
 * temp DB / CWD leak nowhere.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-sandbox-vis-'));
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

const VALID_STATES = ['unknown', 'unsupported', 'disabled', 'active', 'degraded'];

describe('sandbox hardening: default-ON + admin visibility', () => {
    let request: any;
    let app: any;
    let adminToken: string;

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        const dbAsync = database.getDbAsync();
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@example.com', 'Administrator']
        );
        const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);
        await dbAsync.run(
            `INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`,
            [admin.id]
        );
        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json({ limit: '2mb' }));
        app.use('/api/v1/settings', require('../routes/settings'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ---------------------------------------------------------- 1. default-ON

    it('resolves kernel hardening ON by default (opt-out, not opt-in)', () => {
        // The whole OS-isolation layer is dead code if this silently defaults off. `!== false` is the
        // opt-out contract: only an explicit `false` in wordjs-config.json turns it off.
        assert.strictEqual(config.sandbox.useKernelHardening, true,
            'sandbox.useKernelHardening must default to true (hardening attempted where the host supports it)');
        assert.strictEqual(config.sandbox.requireHardening, true,
            'sandbox.requireHardening must default to true so a failed native sandbox cannot launch bare');
    });

    it('the probe never crashes and resolves to a valid, host-appropriate state', async () => {
        const iso = require('../core/plugin-isolate');
        await iso.probeKernelHardening(); // fire the (normally lazy) probe; it must not throw on any platform
        const state = iso.getSandboxHardeningState();
        assert.ok(VALID_STATES.includes(state), `state must be a known enum, got '${state}'`);
        assert.strictEqual(state, iso.getSandboxPlatformState(),
            'the legacy hardening field now reports the native mechanism selected for this OS');
        assert.strictEqual(iso.isSandboxHardeningDegraded(), state === 'degraded');
    });

    // ---------------------------------------------------------- 2. admin visibility

    it('surfaces the hardening state on the admin GET /settings/all payload', async () => {
        const res = await request(app).get('/api/v1/settings/all').set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(res.status, 200);

        // Raw state enum present.
        assert.ok(VALID_STATES.includes(res.body.sandbox_hardening_state),
            `sandbox_hardening_state must be a known enum, got '${res.body.sandbox_hardening_state}'`);

        // Derived boolean present and a REAL boolean (Boolean("false") === true would defeat a string flag).
        assert.strictEqual(typeof res.body.sandbox_hardening_degraded, 'boolean',
            'sandbox_hardening_degraded must be a real boolean');

        // The boolean is exactly "state is degraded" — the mapping cannot silently invert. If someone
        // breaks isSandboxHardeningDegraded to `!== 'degraded'`, on this (non-degraded) host the flag
        // flips true while the state is not 'degraded', and this equality fails.
        assert.strictEqual(res.body.sandbox_hardening_degraded, res.body.sandbox_hardening_state === 'degraded',
            'the degraded flag must equal (state === degraded)');
    });

    it('does NOT leak the sandbox state on the public payload or single-key route', async () => {
        const pub = await request(app).get('/api/v1/settings'); // no auth
        assert.strictEqual(pub.status, 200);
        assert.strictEqual(pub.body.sandbox_hardening_state, undefined, 'must not appear on the public payload');
        assert.strictEqual(pub.body.sandbox_hardening_degraded, undefined, 'must not appear on the public payload');

        // The public single-key route resolves DERIVED_PUBLIC_SETTINGS only; the admin flag is not public.
        const single = await request(app).get('/api/v1/settings/sandbox_hardening_degraded');
        assert.strictEqual(single.status, 403, 'the admin sandbox flag must not be readable anonymously');
    });
});
