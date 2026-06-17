/**
 * Health/metrics endpoint tests against the REAL backend app (supertest), in an isolated process.
 *
 * No external service needed — runs in the integration suite simply to keep the full-app boot out of
 * the SQLite unit suite's shared process. Verifies the orchestrator contract: /healthz is always 200
 * (liveness, no DB), /readyz returns 503 until the app is installed+booted, and /metrics is 404 unless
 * a scrape token is configured.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.WORDJS_EMBEDDED = '1'; // build the app without self-listening / gateway registration

const config = require('../config/app');
config.dbPath = path.join(os.tmpdir(), `wordjs-health-${process.pid}.db`); // never touch the real DB
config.metrics = { token: '' }; // ensure /metrics is in its default (disabled) state for this test

describe('health & metrics endpoints', () => {
    let request: any;
    let app: any;
    before(() => {
        request = require('supertest');
        app = require('../index'); // module.exports = the configured Express app (does not listen in EMBEDDED)
    });

    it('/healthz returns 200 ok and never touches the DB', async () => {
        const res = await request(app).get('/healthz');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'ok');
        assert.ok(typeof res.body.uptime === 'number');
    });

    it('/readyz returns 503 before initialize() (not booted / not installed)', async () => {
        const res = await request(app).get('/readyz');
        assert.strictEqual(res.status, 503);
        assert.ok(['starting', 'setup_required', 'not_ready'].includes(res.body.status), `unexpected status ${res.body.status}`);
    });

    it('/metrics returns 404 when no scrape token is configured', async () => {
        const res = await request(app).get('/metrics');
        assert.strictEqual(res.status, 404);
    });
});
