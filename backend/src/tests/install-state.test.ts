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

/**
 * SEPARATE MODE (3-machine cluster) — regressions found by the first Proxmox run of that mode.
 *
 * 3. The installer derived the site host from `Host` alone. Behind the gateway (`changeOrigin: true`)
 *    that header has already been rewritten to the upstream target, so the backend recorded ITSELF as
 *    the site origin. On one host that is loopback and the migration guard exempts it — invisible. In
 *    separate mode it was the backend node's LAN IP, and every subsequent API call 409'd
 *    `migration_required` against the gateway's host: the whole site was unreachable after install.
 *
 * 4. The installer then re-minted a cluster CA over the node's enrolled identity. Enrollment had
 *    already given it a CN=backend leaf signed by the CA whose private key lives ONLY on the gateway;
 *    overwriting it left the backend holding certificates the gateway does not trust (and dropped a
 *    CA private key onto a machine that must never hold one). It survived until the next restart.
 */
describe('separate mode — the installer must not undo cluster enrollment', () => {
    const { pickInstallHost, isEnrolledConfig: isEnrolled } = require('../routes/setup');

    describe('pickInstallHost — X-Forwarded-Host wins over the proxied Host', () => {
        test('behind the gateway, the operator-facing host is used, not the upstream target', () => {
            // What the backend actually sees for an install POSTed to the gateway.
            assert.strictEqual(
                pickInstallHost('192.168.182.145:3000', '192.168.182.146:4000'),
                '192.168.182.145:3000'
            );
        });

        test('direct (unproxied) install still uses Host', () => {
            assert.strictEqual(pickInstallHost(undefined, 'example.com'), 'example.com');
            assert.strictEqual(pickInstallHost('', 'example.com:3000'), 'example.com:3000');
        });

        test('only the FIRST hop of a comma-joined chain is taken', () => {
            assert.strictEqual(pickInstallHost('edge.example.com, inner.example.com', 'be:4000'), 'edge.example.com');
        });

        test('no headers at all yields empty, so the caller rejects it', () => {
            assert.strictEqual(pickInstallHost(undefined, undefined), '');
        });
    });

    describe('isEnrolledConfig — enrollment is authoritative on a cluster node', () => {
        const enrolledCfg = {
            gatewayHost: '10.0.0.5',
            gatewaySecret: 'shared-with-the-gateway',
            advertiseHost: '10.0.0.6',
            host: '0.0.0.0',
            mtls: { ca: './certs/cluster-ca.crt', key: './certs/backend.key', cert: './certs/backend.crt' }
        };

        test('an enrolled node with its issued cert on disk is recognised', () => {
            assert.strictEqual(isEnrolled(enrolledCfg, true), true);
        });

        test('config says enrolled but the cert is gone → treat as a plain install', () => {
            assert.strictEqual(isEnrolled(enrolledCfg, false), false);
        });

        test('a single-host install is never mistaken for an enrolled node', () => {
            // No advertiseHost: nothing pinned this box into a cluster.
            assert.strictEqual(isEnrolled({ siteUrl: 'https://example.com', mtls: enrolledCfg.mtls }, true), false);
            assert.strictEqual(isEnrolled({ advertiseHost: '10.0.0.6' }, true), false);
            assert.strictEqual(isEnrolled({}, true), false);
            assert.strictEqual(isEnrolled(null, true), false);
        });
    });
});
