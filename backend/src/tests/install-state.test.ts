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

/**
 * THE INSTALL BANNER MUST NAME A URL THAT CONNECTS — found by the first local Docker run of the image.
 *
 * 5. `core/install-token.ts` hardcoded `https://localhost:3000` and deliberately distrusted a config
 *    `siteUrl` equal to `http://localhost:3000` (the untouched default). The Docker image bakes
 *    `WORDJS_HTTP=1`, under which `monolith.js resolveSSL()` returns null and the process serves PLAIN
 *    HTTP — so a fresh container printed `→ https://localhost:3000/install#token=…`, a URL that cannot
 *    connect, while `deploy/compose/README.md` promised a ready-to-click `http://…` one. The scheme is
 *    now READ from the listener (`WORDJS_HTTP`) and the port from `PORT`, exactly as `monolith.js` and
 *    `core/cert-manager.getMonolithConfig()` read them.
 *
 * The resolver takes the configured siteUrl as an ARGUMENT so these assertions never require
 * `config/app` (whose require regenerates and persists secrets) — the caller does that lookup.
 */
describe('install banner URL — the printed scheme follows the listener, not a hardcoded default', () => {
    const { resolveInstallBaseUrl } = require('../core/install-token');

    describe('no configured siteUrl — derive it from the process environment', () => {
        test('WORDJS_HTTP=1 (what the Docker image bakes) prints http', () => {
            assert.strictEqual(resolveInstallBaseUrl(null, { WORDJS_HTTP: '1' }), 'http://localhost:3000');
        });

        test('unset WORDJS_HTTP keeps the previous https default (dev sslAuto / self-signed)', () => {
            assert.strictEqual(resolveInstallBaseUrl(null, {}), 'https://localhost:3000');
        });

        test('only the literal "1" means plain HTTP — monolith.js compares it that way', () => {
            assert.strictEqual(resolveInstallBaseUrl(null, { WORDJS_HTTP: 'true' }), 'https://localhost:3000');
            assert.strictEqual(resolveInstallBaseUrl(null, { WORDJS_HTTP: '0' }), 'https://localhost:3000');
        });

        test('PORT is honoured — the container may publish the app anywhere', () => {
            assert.strictEqual(resolveInstallBaseUrl(null, { WORDJS_HTTP: '1', PORT: '8080' }), 'http://localhost:8080');
            assert.strictEqual(resolveInstallBaseUrl(null, { PORT: '8443' }), 'https://localhost:8443');
        });

        test('an unusable PORT falls back to 3000, like Number(process.env.PORT) || 3000', () => {
            assert.strictEqual(resolveInstallBaseUrl(null, { WORDJS_HTTP: '1', PORT: '' }), 'http://localhost:3000');
            assert.strictEqual(resolveInstallBaseUrl(null, { WORDJS_HTTP: '1', PORT: 'nope' }), 'http://localhost:3000');
        });

        test('the default port for the scheme is dropped, as monolith.js does in its redirect', () => {
            assert.strictEqual(resolveInstallBaseUrl(null, { PORT: '443' }), 'https://localhost');
            assert.strictEqual(resolveInstallBaseUrl(null, { WORDJS_HTTP: '1', PORT: '80' }), 'http://localhost');
            // ...and NOT the other way round: :80 under https is a real, non-default port.
            assert.strictEqual(resolveInstallBaseUrl(null, { PORT: '80' }), 'https://localhost:80');
        });
    });

    describe('a configured siteUrl still wins — unless it is the untouched placeholder', () => {
        test('an operator-set origin is printed verbatim, whatever the environment says', () => {
            assert.strictEqual(
                resolveInstallBaseUrl('https://cms.example.com', { WORDJS_HTTP: '1', PORT: '8080' }),
                'https://cms.example.com'
            );
        });

        test('a trailing slash never doubles up in front of /install', () => {
            assert.strictEqual(resolveInstallBaseUrl('https://cms.example.com/', {}), 'https://cms.example.com');
        });

        test('the shipped placeholder counts as unset, so the environment decides', () => {
            // THE REGRESSION: trusting this value would print http:// on an HTTPS dev box.
            assert.strictEqual(resolveInstallBaseUrl('http://localhost:3000', {}), 'https://localhost:3000');
            assert.strictEqual(
                resolveInstallBaseUrl('http://localhost:3000', { WORDJS_HTTP: '1' }),
                'http://localhost:3000'
            );
        });

        test('an empty / absent config value is not mistaken for a configured origin', () => {
            assert.strictEqual(resolveInstallBaseUrl('', { WORDJS_HTTP: '1' }), 'http://localhost:3000');
            assert.strictEqual(resolveInstallBaseUrl('   ', { WORDJS_HTTP: '1' }), 'http://localhost:3000');
            assert.strictEqual(resolveInstallBaseUrl(undefined, { WORDJS_HTTP: '1' }), 'http://localhost:3000');
        });
    });
});

/**
 * THE BANNER MUST NOT PUT THE BOOTSTRAP SECRET IN A LOG AGGREGATOR.
 *
 * 6. The banner printed the install token twice — once inside a clickable `#token=` URL and once bare
 *    — on every boot of an uninstalled instance. "Printed to the console" was written when a console
 *    was a terminal an operator was watching. It is not: `core/logger`'s console bridge turns this
 *    banner into structured JSON on stdout, and `documentation/observability.md` tells operators to
 *    ship stdout to Loki/ELK/Datadog. So the one-time secret that gates a pre-install takeover became
 *    a durable, indexed, searchable record readable by everyone who can read logs — as did the
 *    generated administrator password `index.ts` prints in the same shape.
 *
 *    The value is now printed only when stdout is a TTY, or when `WORDJS_PRINT_INSTALL_TOKEN=1` says
 *    the operator has decided their sink is trustworthy. Otherwise the banner names the 0600 file. No
 *    headless flow loses anything: the file and `WORDJS_INSTALL_TOKEN` are how Docker, Compose, Helm
 *    and the Verso E2E suite already obtain it.
 */
describe('install banner — the token is printed only to a terminal', () => {
    const MODULE = require.resolve('../core/install-token');
    const CONFIG = require.resolve('../config/app');
    const PROBE_TOKEN = 'banner-probe-token-0123456789';

    let savedTokenFile: Buffer | null = null;
    let tokenFilePath = '';
    let hadTokenFile = false;
    let installedConfigStub = false;

    before(() => {
        // Keep the promise the previous block makes: these assertions must never require `config/app`,
        // whose load regenerates and persists secrets. generateInstallToken() looks it up internally,
        // so a stub is seeded ONLY when nothing has loaded it already.
        if (!require.cache[CONFIG]) {
            require.cache[CONFIG] = { id: CONFIG, filename: CONFIG, loaded: true, exports: { siteUrl: null } } as any;
            installedConfigStub = true;
        }
        tokenFilePath = require('../core/install-token').INSTALL_TOKEN_FILE;
        hadTokenFile = fs.existsSync(tokenFilePath);
        if (hadTokenFile) savedTokenFile = fs.readFileSync(tokenFilePath);
    });

    after(() => {
        // The banner writes the 0600 mirror as a side effect; put back exactly what was there.
        try {
            if (hadTokenFile && savedTokenFile) fs.writeFileSync(tokenFilePath, savedTokenFile, { mode: 0o600 });
            else fs.unlinkSync(tokenFilePath);
        } catch { /* nothing to restore */ }
        if (installedConfigStub) delete require.cache[CONFIG];
        delete require.cache[MODULE];
    });

    /** Print one banner from a FRESH module (the token is memoised for the life of a module instance). */
    function banner(env: Record<string, string | undefined>, isTTY: boolean): string {
        const savedEnv: Record<string, string | undefined> = {};
        for (const key of ['WORDJS_INSTALL_TOKEN', 'WORDJS_PRINT_INSTALL_TOKEN']) {
            savedEnv[key] = process.env[key];
            if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key] as string;
        }
        const savedIsTTY = (process.stdout as any).isTTY;
        const savedLog = console.log;
        const out: string[] = [];
        (process.stdout as any).isTTY = isTTY;
        console.log = (...args: any[]): void => { out.push(args.map(String).join(' ')); };
        try {
            delete require.cache[MODULE];
            require('../core/install-token').generateInstallToken();
        } finally {
            console.log = savedLog;
            (process.stdout as any).isTTY = savedIsTTY;
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined) delete process.env[key]; else process.env[key] = value;
            }
        }
        return out.join('\n');
    }

    test('on a TTY the banner is unchanged: the clickable URL and the bare token', () => {
        const text = banner({ WORDJS_INSTALL_TOKEN: PROBE_TOKEN }, true);
        assert.match(text, /WordJS is not installed yet/);
        assert.ok(text.includes(`/install#token=${PROBE_TOKEN}`), `the clickable URL lost its token:\n${text}`);
        assert.ok(text.includes(`Install token (if you prefer to paste it): ${PROBE_TOKEN}`), `the bare token line disappeared:\n${text}`);
    });

    test('OFF a TTY the token appears NOWHERE — not bare, and not in the URL fragment', () => {
        const text = banner({ WORDJS_INSTALL_TOKEN: PROBE_TOKEN }, false);
        assert.ok(!text.includes(PROBE_TOKEN), `the bootstrap secret reached stdout on a headless boot:\n${text}`);
        assert.ok(!text.includes('#token='), 'the fragment form still carries the value — it is the same secret');
        // …and the operator is not left guessing: the banner still opens the wizard and names the file.
        assert.match(text, /WordJS is not installed yet/);
        assert.match(text, /\/install$/m);
        assert.ok(text.includes(tokenFilePath), `the banner must name the 0600 file it wrote:\n${text}`);
        assert.match(text, /WORDJS_PRINT_INSTALL_TOKEN=1/);
    });

    test('WORDJS_PRINT_INSTALL_TOKEN=1 is the escape hatch for an operator who trusts their log sink', () => {
        const text = banner({ WORDJS_INSTALL_TOKEN: PROBE_TOKEN, WORDJS_PRINT_INSTALL_TOKEN: '1' }, false);
        assert.ok(text.includes(`/install#token=${PROBE_TOKEN}`), `the opt-in did not restore the printed token:\n${text}`);
    });

    test('the file mirror is written either way — it is the channel the headless banner points at', () => {
        banner({ WORDJS_INSTALL_TOKEN: PROBE_TOKEN }, false);
        assert.strictEqual(fs.readFileSync(tokenFilePath, 'utf8'), PROBE_TOKEN);
    });

    describe('shouldPrintBootstrapSecret — the decision itself, used by the admin-password banner too', () => {
        const { shouldPrintBootstrapSecret } = require('../core/install-token');

        test('a terminal prints, a pipe does not', () => {
            assert.strictEqual(shouldPrintBootstrapSecret({}, { isTTY: true }), true);
            assert.strictEqual(shouldPrintBootstrapSecret({}, { isTTY: false }), false);
            assert.strictEqual(shouldPrintBootstrapSecret({}, {}), false);
            assert.strictEqual(shouldPrintBootstrapSecret({}, null), false);
        });

        test('only the literal "1" opts in — a truthy-looking value must not silently print a secret', () => {
            assert.strictEqual(shouldPrintBootstrapSecret({ WORDJS_PRINT_INSTALL_TOKEN: '1' }, { isTTY: false }), true);
            assert.strictEqual(shouldPrintBootstrapSecret({ WORDJS_PRINT_INSTALL_TOKEN: ' 1 ' }, { isTTY: false }), true);
            assert.strictEqual(shouldPrintBootstrapSecret({ WORDJS_PRINT_INSTALL_TOKEN: 'true' }, { isTTY: false }), false);
            assert.strictEqual(shouldPrintBootstrapSecret({ WORDJS_PRINT_INSTALL_TOKEN: 'yes' }, { isTTY: false }), false);
            assert.strictEqual(shouldPrintBootstrapSecret({ WORDJS_PRINT_INSTALL_TOKEN: '0' }, { isTTY: false }), false);
        });
    });
});
