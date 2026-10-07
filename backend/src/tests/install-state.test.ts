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
 *    The fix then over-corrected into "X-Forwarded-Host from ANYONE wins". The derivation is now the
 *    host gate's own (core/host-policy requestAuthority): the gateway's forwarded host wins because the
 *    gateway is a TRUSTED hop, and a direct client's forwarded headers are ignored.
 *
 * 4. The installer then re-minted a cluster CA over the node's enrolled identity. Enrollment had
 *    already given it a CN=backend leaf signed by the CA whose private key lives ONLY on the gateway;
 *    overwriting it left the backend holding certificates the gateway does not trust (and dropped a
 *    CA private key onto a machine that must never hold one). It survived until the next restart.
 */
describe('separate mode — the installer must not undo cluster enrollment', () => {
    const setup = require('../routes/setup');
    const { isEnrolledConfig: isEnrolled } = setup;
    const hostPolicy = require('../core/host-policy');
    const { siteHostPolicy } = require('../middleware/auth');

    // The policy the installer consults is the process provider's; pin it so these assertions do not
    // depend on whatever wordjs-config.json (or WORDJS_TRUST_PROXY) the machine running them has.
    const realGet = siteHostPolicy.get;
    const pinPolicy = (config: Record<string, unknown> | null) => {
        const pinned = hostPolicy.buildPolicy({ config, env: {}, nodeEnv: 'production', ownAddresses: () => new Set() });
        siteHostPolicy.get = () => pinned;
    };
    after(() => { siteHostPolicy.get = realGet; });

    // The request shapes the backend really receives.
    const GATEWAY_MTLS = () => ({ remoteAddress: '10.0.0.5', authorized: true, encrypted: true, getPeerCertificate: () => ({ subject: { CN: 'gateway-internal' } }) });
    const LOOPBACK_PEER = () => ({ remoteAddress: '127.0.0.1' });
    const REMOTE_PEER = (encrypted = false) => ({ remoteAddress: '203.0.113.5', encrypted });
    const installReq = (headers: Record<string, string>, socket: any, body: Record<string, unknown> = {}) => ({ headers, socket, body });
    const originOf = (r: any) => (r && r.site ? r.site.origin : r);

    describe('installSiteAddress — the forwarded host counts only from a trusted hop', () => {
        before(() => pinPolicy(null));

        test('behind the gateway (mTLS), the operator-facing host is used, not the upstream target', () => {
            const r = setup.installSiteAddress(installReq(
                { host: '192.168.182.146:4000', 'x-forwarded-host': '192.168.182.145:3000', 'x-forwarded-proto': 'http' }, GATEWAY_MTLS()));
            assert.strictEqual(originOf(r), 'http://192.168.182.145:3000');
        });

        test('the pre-certs gateway on the same machine (loopback peer, loopback Host) is trusted too, with its scheme', () => {
            const r = setup.installSiteAddress(installReq(
                { host: '127.0.0.1:4000', 'x-forwarded-host': 'blog.example.com:3000', 'x-forwarded-proto': 'https' }, LOOPBACK_PEER()));
            assert.strictEqual(originOf(r), 'https://blog.example.com:3000');
        });

        test('a direct client\'s X-Forwarded-Host and X-Forwarded-Proto are ignored: its Host and its transport decide', () => {
            const r = setup.installSiteAddress(installReq(
                { host: 'example.com:3000', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }, REMOTE_PEER()));
            assert.strictEqual(originOf(r), 'http://example.com:3000');
            const tls = setup.installSiteAddress(installReq({ host: 'example.com' }, REMOTE_PEER(true)));
            assert.strictEqual(originOf(tls), 'https://example.com', 'a TLS listener is https');
        });

        test('only the FIRST hop of a comma-joined chain is taken', () => {
            const r = setup.installSiteAddress(installReq(
                { host: 'be:4000', 'x-forwarded-host': 'edge.example.com, inner.example.com', 'x-forwarded-proto': 'https' }, GATEWAY_MTLS()));
            assert.strictEqual(originOf(r), 'https://edge.example.com');
        });

        test('an IPv6 install address is accepted, bracketed', () => {
            const r = setup.installSiteAddress(installReq({ host: '[2001:DB8::1]:3000' }, REMOTE_PEER()));
            assert.strictEqual(originOf(r), 'http://[2001:db8::1]:3000');
        });

        test('no host at all — or a malformed one — is refused, never turned into "http://undefined"', () => {
            const cases: Array<Record<string, string>> = [{}, { host: '' }, { host: 'a@b' }, { host: 'example.com:99999' }];
            for (const headers of cases) {
                const r = setup.installSiteAddress(installReq(headers, REMOTE_PEER()));
                assert.ok(r && typeof r.error === 'string', `${JSON.stringify(headers)} must be refused, got ${JSON.stringify(r)}`);
            }
        });

        test('an explicit siteUrl wins, and only a plain http(s) origin is accepted', () => {
            const r = setup.installSiteAddress(installReq({ host: 'lan-box:3000' }, REMOTE_PEER(), { siteUrl: 'https://Example.com/' }));
            assert.strictEqual(originOf(r), 'https://example.com');
            for (const bad of ['https://example.com/blog', 'javascript:alert(1)', 'https://a@b.example', 'https,https://x.example', 'https://*.example.com', 'http://[::1']) {
                const refused = setup.installSiteAddress(installReq({ host: 'lan-box:3000' }, REMOTE_PEER(), { siteUrl: bad }));
                assert.ok(refused && typeof refused.error === 'string', `${bad} must be refused`);
            }
        });
    });

    describe('installTimeAlias — "also accept the address I am installing from"', () => {
        before(() => pinPolicy(null));
        const site = hostPolicy.parseSiteUrl('https://blog.example.com');
        const from = (host: string, body: Record<string, unknown> = { acceptCurrentAddress: true }) =>
            setup.installTimeAlias(installReq({ host }, REMOTE_PEER(), body), site);

        test('only when asked', () => {
            assert.strictEqual(setup.installTimeAlias(installReq({ host: 'blog.lan:3000' }, REMOTE_PEER()), site), null);
        });

        test('a different NAMED address is stored as an install alias', () => {
            const r = from('blog.lan:3000');
            assert.ok(r && r.alias, JSON.stringify(r));
            assert.strictEqual(r.alias.url, 'http://blog.lan:3000');
            assert.strictEqual(r.alias.source, 'install');
            assert.strictEqual(r.alias.expiresAt, undefined);
            const policy = hostPolicy.buildPolicy({ config: { siteUrl: site.origin, siteAliases: [r.alias] }, env: {}, nodeEnv: 'production' });
            assert.strictEqual(hostPolicy.classify(hostPolicy.parseHost('blog.lan:3000'), policy).cls, 'alias', 'the stored entry is one the policy reads');
        });

        test('nothing to store for the chosen address itself, loopback or an IP literal (accepted by rule)', () => {
            for (const host of ['blog.example.com', 'localhost:3000', '127.0.0.1:3000', '192.168.1.50:3000', '[2001:db8::1]:3000']) {
                assert.strictEqual(from(host), null, host);
            }
        });

        test('a tunnel name expires after a week', () => {
            const r = from('ab12.ngrok-free.app');
            assert.ok(r && r.alias && r.alias.expiresAt, JSON.stringify(r));
            const days = (Date.parse(r.alias.expiresAt) - Date.now()) / 86400000;
            assert.ok(days > 6.9 && days <= 7, `expected ~7 days, got ${days}`);
        });

        test('a .local name needs confirmLocal, as in the site-address API', () => {
            assert.deepStrictEqual(from('blog.local:3000'), { skipped: 'local-name-needs-confirmation' });
            const confirmed = setup.installTimeAlias(installReq({ host: 'blog.local:3000' }, REMOTE_PEER(), { acceptCurrentAddress: true, confirmLocal: true }), site);
            assert.strictEqual(confirmed.alias.url, 'http://blog.local:3000');
        });
    });

    describe('classifyInstallRequest — the install request judged as the gate will judge the next one', () => {
        test('the chosen address, an accepted rule address, and an address about to be refused', () => {
            pinPolicy({ siteUrl: 'https://example.com', siteAliases: ['https://www.example.com'] });
            const canonical = setup.classifyInstallRequest(installReq({ host: 'example.com' }, REMOTE_PEER()));
            assert.strictEqual(canonical.cls, 'canonical');
            assert.strictEqual(canonical.scheme, 'http', 'the scheme is the real transport');
            assert.strictEqual(setup.classifyInstallRequest(installReq({ host: 'www.example.com' }, REMOTE_PEER())).cls, 'alias');
            assert.strictEqual(setup.classifyInstallRequest(installReq({ host: '192.168.1.50:3000' }, REMOTE_PEER())).cls, 'ip');
            assert.strictEqual(setup.classifyInstallRequest(installReq({ host: 'lan-box:3000' }, REMOTE_PEER())), 'unknown');
            assert.strictEqual(setup.classifyInstallRequest(installReq({}, REMOTE_PEER())), null, 'no Host: nothing to classify');
            pinPolicy(null);
            assert.strictEqual(setup.classifyInstallRequest(installReq({ host: 'example.com' }, REMOTE_PEER())), null, 'no canonical: nothing to classify');
        });
    });

    describe('suggestedSiteUrl — WORDJS_SITE_URL is only a non-loopback suggestion (REDTEAM R6)', () => {
        const saved = process.env.WORDJS_SITE_URL;
        after(() => { if (saved === undefined) delete process.env.WORDJS_SITE_URL; else process.env.WORDJS_SITE_URL = saved; });
        const suggest = (value: string | undefined) => {
            if (value === undefined) delete process.env.WORDJS_SITE_URL; else process.env.WORDJS_SITE_URL = value;
            return setup.suggestedSiteUrl();
        };

        test('compose\'s default localhost is never offered', () => {
            assert.strictEqual(suggest('http://localhost:3000'), null);
            assert.strictEqual(suggest('http://127.0.0.1:3000'), null);
        });

        test('a real address is offered, normalised', () => {
            assert.strictEqual(suggest('https://Blog.Example.com/'), 'https://blog.example.com');
        });

        test('nothing, or garbage, offers nothing', () => {
            assert.strictEqual(suggest(undefined), null);
            assert.strictEqual(suggest('blog.example.com'), null);
            assert.strictEqual(suggest('https://blog.example.com/path'), null);
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
