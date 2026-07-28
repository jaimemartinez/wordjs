/**
 * INSTALL STATE + OPTION SERIALISATION — regressions found by the v1.12.12 3-mode Proxmox run.
 *
 * 1. `isInstalled()` was `fs.existsSync(wordjs-config.json)`. `scripts/node-join.js` writes that exact
 *    file to hand a BRAND-NEW cluster node its gateway wiring, so an enrolled backend reported itself
 *    installed, the wizard never ran, and the CMS bootstrap seeded a default administrator on a node
 *    already published through the gateway. The predicate must distinguish "enrolled" from "installed".
 *
 * 2. `updateOption`/`addOption` serialised with `String(value)`, so a field the caller omitted was
 *    stored as the literal text "undefined" — a headless install left blogdescription = "undefined",
 *    which rendered in <title>, og:title and twitter:title.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isInstalledConfig } = require('../core/configManager');

describe('isInstalledConfig — enrollment is not installation', () => {
    // The shape scripts/node-join.js writes: gateway wiring + mTLS paths, no database, no site.
    const enrolled = {
        gatewayHost: '10.0.0.5',
        gatewayInternalPort: 3100,
        gatewayPort: 3000,
        gatewaySecret: 'deadbeef',
        gatewaySsl: { enabled: true },
        siteUrl: 'https://10.0.0.5:3000',
        advertiseHost: '10.0.0.6',
        host: '0.0.0.0',
        port: 4000,
        jwtSecret: 'x'.repeat(128),
        mtls: { ca: './certs/cluster-ca.crt', key: './certs/backend.key', cert: './certs/backend.crt' },
        updatedAt: new Date().toISOString()
    };

    test('a freshly ENROLLED node still needs the wizard', () => {
        assert.strictEqual(isInstalledConfig(enrolled), false);
    });

    test('jwtSecret alone must NOT count — enrollment mints one too', () => {
        assert.strictEqual(isInstalledConfig({ jwtSecret: 'x'.repeat(128) }), false);
    });

    test('a site written by the installer counts (installedAt marker)', () => {
        assert.strictEqual(isInstalledConfig({ ...enrolled, installedAt: new Date().toISOString() }), true);
    });

    test('a site installed BEFORE the marker existed still counts (dbDriver)', () => {
        assert.strictEqual(isInstalledConfig({ siteUrl: 'http://localhost:3000', dbDriver: 'sqlite-native' }), true);
        assert.strictEqual(isInstalledConfig({ dbDriver: 'postgres', db: { host: 'db' } }), true);
    });

    test('nothing at all is not installed', () => {
        assert.strictEqual(isInstalledConfig(null), false);
        assert.strictEqual(isInstalledConfig(undefined), false);
        assert.strictEqual(isInstalledConfig({}), false);
        assert.strictEqual(isInstalledConfig('not an object'), false);
    });
});

describe('option serialisation — an absent value is empty, never the text "undefined"', () => {
    const TMP_DB = path.join(os.tmpdir(), `wjs-optser-${process.pid}-${Date.now()}.db`);
    let updateOption: any, getOption: any, addOption: any, database: any;

    before(async () => {
        const config = require('../config/app');
        config.dbPath = TMP_DB;
        config.dbDriver = 'sqlite-native';
        database = require('../config/database');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        ({ updateOption, getOption, addOption } = require('../core/options'));
    });

    after(async () => {
        try { await database.close?.(); } catch { /* already closed */ }
        try { fs.unlinkSync(TMP_DB); } catch { /* best effort */ }
    });

    test('updateOption(undefined) stores an empty string', async () => {
        await updateOption('wjs_test_absent', undefined);
        assert.strictEqual(await getOption('wjs_test_absent'), '');
    });

    test('updateOption(null) stores an empty string', async () => {
        await updateOption('wjs_test_null', null);
        assert.strictEqual(await getOption('wjs_test_null'), '');
    });

    test('addOption(undefined) stores an empty string', async () => {
        await addOption('wjs_test_add_absent', undefined);
        assert.strictEqual(await getOption('wjs_test_add_absent'), '');
    });

    // getOption JSON-parses what it reads back, so these are the round-tripped values, not the raw text.
    test('real values are untouched — including the STRING "undefined"', async () => {
        await updateOption('wjs_test_str', 'Just another WordJS site');
        assert.strictEqual(await getOption('wjs_test_str'), 'Just another WordJS site');
        await updateOption('wjs_test_zero', 0);
        assert.strictEqual(await getOption('wjs_test_zero'), 0);
        await updateOption('wjs_test_false', false);
        assert.strictEqual(await getOption('wjs_test_false'), false);
        await updateOption('wjs_test_obj', { a: 1 });
        assert.deepStrictEqual(await getOption('wjs_test_obj'), { a: 1 });
        // Someone deliberately storing the word stays able to.
        await updateOption('wjs_test_literal', 'undefined');
        assert.strictEqual(await getOption('wjs_test_literal'), 'undefined');
    });

    test('the tagline a headless install omits never reaches a page as "undefined"', async () => {
        const siteDescription = undefined; // exactly what POST /setup/install destructures when omitted
        await updateOption('blogdescription', String(siteDescription ?? ''));
        const stored = await getOption('blogdescription');
        assert.strictEqual(stored, '');
        assert.notStrictEqual(stored, 'undefined');
    });
});
