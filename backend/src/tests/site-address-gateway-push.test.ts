/**
 * WordJS — THE GATEWAY LEARNS WHICH ADDRESSES THE SITE ANSWERS (phase 2 of the site-address work).
 *
 * In split and separate mode the gateway's edge — the 421 page for pages, static trees, uploads and
 * WebSockets on an address the site does not answer, the 308 of a redirect alias, and REDTEAM R4, which
 * the backend cannot apply behind the gateway because every request it sees comes from a trusted hop —
 * enforces ONLY a policy the backend pushed to POST /host-policy. Nothing pushed one: the edge answered
 * every name. These tests pin who pushes, when, and what:
 *
 *   · every committed change (aliases, IP policy, main address, repair — and the gateway's own R1 report,
 *     whose address is not echoed back), a change the CLI wrote, the end of the boot reconcile, and the
 *     re-arm after this backend registers with the gateway (index.ts);
 *   · the body is the backend's OWN inputs of buildPolicy, and the gateway's real validator and edge
 *     (gateway/src/host-edge.js) accept it and enforce exactly the new set;
 *   · never in the monolith or on a node without cluster identity; a refused push is a warning, the
 *     change stands; an unreadable file pushes nothing (the gateway keeps its last good policy, R10).
 *
 * cert-manager's dialler is stubbed here (its wire is covered by cert-manager-gateway.test.ts against a
 * real mTLS listener); everything between a change and that call is real.
 *
 * MUTATION PROOF (each applied to the source, watched to fail, restored): drop the push from afterChange;
 * drop the arm from reconcileAtBoot; drop the re-arm from index.ts.
 */

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');

const ORIGINAL_CWD = process.cwd();
const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-site-push-${process.pid}-`));
const CONFIG_FILE = path.join(TMP_INSTALL, 'wordjs-config.json');
const MTLS = { ca: './certs/cluster-ca.crt', key: './certs/backend.key', cert: './certs/backend.crt' };
const BASE = {
    installedAt: '2026-01-01T00:00:00.000Z',
    dbDriver: 'sqlite-native',
    siteUrl: 'https://example.com',
    siteAliases: [] as unknown[],
    hostPolicy: { ipLiterals: 'any' },
    siteAddress: { rev: 3 },
    mtls: MTLS,
    revalidateSecret: 'gateway-push-test-secret',
};
fs.writeFileSync(CONFIG_FILE, JSON.stringify(BASE, null, 2));
process.chdir(TMP_INSTALL);

const ENV_KEYS = ['WORDJS_ALLOWED_HOSTS', 'WORDJS_IP_HOSTS', 'WORDJS_DEV_ORIGINS', 'WORDJS_TRUST_PROXY', 'WORDJS_MODE', 'WORDJS_EMBEDDED'];
const SAVED_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) { SAVED_ENV[key] = process.env[key]; delete process.env[key]; }

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-site-push-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
config.nodeEnv = 'production';

const configManager = require('../core/configManager');
const hostPolicy = require('../core/host-policy');
const siteAddress = require('../core/site-address');
const options = require('../core/options');
const database = require('../config/database');
const certManager = require('../core/cert-manager');
const hostEdge = require('../../../gateway/src/host-edge.js');

assert.strictEqual(configManager.CONFIG_FILE, CONFIG_FILE, 'the staged config must be the file configManager reads');

require('../core/frontend-purge').purgeFrontend = () => { /* recorded nowhere: not this file's subject */ };

// ─── the gateway's control plane, recorded ─────────────────────────────────────────────────────────

type Push = ['host-policy', any] | ['config-update', string];
const pushes: Push[] = [];
let refuseNextPolicyPush = false;
certManager.pushHostPolicyToGateway = async (body: any) => {
    if (refuseNextPolicyPush) {
        refuseNextPolicyPush = false;
        throw new Error('connect ECONNREFUSED 127.0.0.1:3100');
    }
    pushes.push(['host-policy', JSON.parse(JSON.stringify(body))]);
    return { success: true };
};
certManager.pushSiteUrlToGateway = async (siteUrl: string) => {
    pushes.push(['config-update', siteUrl]);
    return { success: true };
};
const policyPushes = () => pushes.filter((p) => p[0] === 'host-policy').map((p) => p[1]);
const addressPushes = () => pushes.filter((p) => p[0] === 'config-update').map((p) => p[1]);

// ─── the gateway's side of the wire: its validator, its stored file, its edge ─────────────────────

const silent = { info() { /* */ }, warn() { /* */ }, error() { /* */ } };
let edgeFiles = 0;
function gatewayEdgeFrom(body: any) {
    const checked = hostEdge.sanitizePolicyPush(JSON.parse(JSON.stringify(body)));
    assert.ok(checked.ok, `the gateway refuses the pushed body: ${checked.error}`);
    const file = path.join(TMP_INSTALL, `gateway-host-policy-${edgeFiles++}.json`);
    hostEdge.writePolicyFile(file, checked.value);
    const source = hostEdge.createPushedPolicySource({ file, logger: silent });
    return hostEdge.createHostEdge({ getPolicy: () => source.get(), logger: silent, refused: hostPolicy.createRefusedHosts(), forwardedHostIsMarker: false });
}
const browser = (host: string, url = '/about') => ({ method: 'GET', url, headers: { host }, rawHeaders: ['Host', host], socket: { remoteAddress: '203.0.113.9' } });

// ─── the world ─────────────────────────────────────────────────────────────────────────────────────

let db: any;

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    db = database.getDbAsync();
    await require('../core/roles').loadRoles();
    const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('root', ?, 'root@example.com', 'root')`, [bcrypt.hashSync('x-password-123', 4)]);
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [r.lastID]);
});

after(async () => {
    siteAddress.stopWatching();
    try { await database.closeDatabase(); } catch { /* closed */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
    for (const key of ENV_KEYS) {
        if (SAVED_ENV[key] === undefined) delete process.env[key];
        else process.env[key] = SAVED_ENV[key];
    }
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP_INSTALL, { recursive: true, force: true }); } catch { /* */ }
});

/** Stage the file and the mirrors at the same revision, as a running site has them. */
async function world(file: Record<string, unknown>) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(file, null, 2));
    configManager.invalidateConfigCache();
    const site = hostPolicy.parseSiteUrl(file.siteUrl);
    await options.updateOption('siteurl', site ? site.origin : '');
    await options.updateOption('home', site ? site.origin : '');
    await options.updateOption('site_address_rev', configManager.siteAddressRev(file));
    pushes.length = 0;
}
const fileConfig = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const rev = () => configManager.siteAddressRev(fileConfig());

// ─── boot ──────────────────────────────────────────────────────────────────────────────────────────

describe('the gateway is armed outside a change', () => {
    test('the boot reconcile arms it with what the file says, without holding up the boot', async () => {
        await world({ ...BASE, siteAliases: [{ url: 'https://www.example.com', mode: 'redirect', source: 'admin' }] });
        const { state, gatewayArmed } = await siteAddress.reconcileAtBoot();
        assert.strictEqual(state, 'ok');
        assert.strictEqual(await gatewayArmed, null, 'no warning');
        const [body] = policyPushes();
        assert.ok(body, 'the reconcile pushed the policy');
        assert.strictEqual(body.enforce, true);
        assert.strictEqual(body.config.siteUrl, 'https://example.com');
        assert.deepStrictEqual(body.config.siteAliases, [{ url: 'https://www.example.com', mode: 'redirect', source: 'admin' }]);
        assert.strictEqual(body.nodeEnv, 'production');
        assert.deepStrictEqual(addressPushes(), [], 'nothing moved: the main address is not re-sent');

        const edge = gatewayEdgeFrom(body);
        assert.strictEqual(edge.decide(browser('evil.example')).action, 'refuse');
        assert.deepStrictEqual(edge.decide(browser('www.example.com', '/blog')), { action: 'redirect', location: 'https://example.com/blog' });
    });

    test('armGateway (index.ts calls it after registering) pushes the file as it is now; an unreadable file pushes nothing', async () => {
        await world({ ...BASE, hostPolicy: { ipLiterals: 'none' } });
        assert.strictEqual(await siteAddress.armGateway(), null);
        assert.deepStrictEqual(policyPushes().map((b) => b.config.hostPolicy), [{ ipLiterals: 'none' }]);

        pushes.length = 0;
        fs.writeFileSync(CONFIG_FILE, '{ "siteUrl": "https://exam');
        configManager.invalidateConfigCache();
        assert.strictEqual(await siteAddress.armGateway(), null);
        assert.deepStrictEqual(pushes, [], 'R10: a half-written file is never pushed — the gateway keeps its last good policy');
    });

    test('index.ts re-arms the gateway after every successful registration', () => {
        // The boot reconcile usually runs before a gateway that starts with it is listening; the push
        // after registration is what arms it then. Structural, like install-root-paths' check of the same
        // block: the registration loop cannot run in a unit test.
        const code = fs.readFileSync(path.resolve(__dirname, '..', 'index.ts'), 'utf8');
        const registerAll = code.slice(code.indexOf('const registerAll'), code.indexOf('let _regAttempt = 0;'));
        assert.ok(registerAll.length > 200, 'registerAll not found — update this gate');
        const success = registerAll.slice(registerAll.indexOf('All services successfully registered'));
        assert.match(success, /await syncFromGateway\(\);\s*(?:\/\/[^\n]*\n\s*)*await require\('\.\/core\/site-address'\)\.armGateway\(\)/,
            'after a successful registration the gateway must be armed with the policy');
    });
});

// ─── every committed change ───────────────────────────────────────────────────────────────────────

describe('every committed change tells the gateway the new set', () => {
    beforeEach(async () => { await world(BASE); });

    test('an alias added: the push carries it, and the gateway\'s own validator and edge answer it', async () => {
        const result = await siteAddress.commit((cfg: any) => siteAddress.planAliases(cfg, { aliases: ['https://blog.example.net'], actorId: null, via: 'cli', now: Date.now() }),
            { expectRev: rev(), via: 'cli', actorId: null });
        assert.deepStrictEqual(result.warnings, []);
        const bodies = policyPushes();
        assert.strictEqual(bodies.length, 1);
        assert.deepStrictEqual(bodies[0].config.siteAliases.map((a: any) => a.url), ['https://blog.example.net']);
        assert.deepStrictEqual(addressPushes(), [], 'the main address did not move');

        const edge = gatewayEdgeFrom(bodies[0]);
        assert.strictEqual(edge.decide(browser('blog.example.net')).action, 'pass');
        assert.strictEqual(edge.decide(browser('example.com')).action, 'pass');
        assert.strictEqual(edge.decide(browser('rebind.attacker')).action, 'refuse');
    });

    test('an IP policy change is pushed too, and the edge applies it', async () => {
        await siteAddress.commit((cfg: any) => siteAddress.planPolicy(cfg, { ipLiterals: 'none' }), { expectRev: rev(), via: 'cli', actorId: null });
        const [body] = policyPushes();
        assert.deepStrictEqual(body.config.hostPolicy, { ipLiterals: 'none' });
        assert.strictEqual(gatewayEdgeFrom(body).decide(browser('198.51.100.7:3000')).action, 'refuse');
    });

    test('a new main address: the policy first (so the edge already answers it), then the address', async () => {
        await siteAddress.commit((cfg: any) => siteAddress.planCanonical(cfg, { url: 'https://www.example.org', oldAddress: 'redirect', actorId: null, via: 'cli', now: Date.now() }),
            { expectRev: rev(), via: 'cli', actorId: null });
        assert.deepStrictEqual(pushes.map((p) => p[0]), ['host-policy', 'config-update']);
        const body = policyPushes()[0];
        assert.strictEqual(body.config.siteUrl, 'https://www.example.org');
        assert.deepStrictEqual(addressPushes(), ['https://www.example.org']);
        const edge = gatewayEdgeFrom(body);
        assert.deepStrictEqual(edge.decide(browser('example.com', '/x')), { action: 'redirect', location: 'https://www.example.org/x' });
    });

    test('the gateway\'s own R1 report: the policy follows, the address is not echoed back', async () => {
        await world({ ...BASE, siteUrl: 'http://example.com' });
        const outcome = await siteAddress.noteGatewaySiteUrl('https://example.com');
        assert.strictEqual(outcome.outcome, 'upgraded');
        assert.deepStrictEqual(policyPushes().map((b) => b.config.siteUrl), ['https://example.com']);
        assert.deepStrictEqual(addressPushes(), []);
    });

    test('a change the CLI wrote is pushed when the running server applies it', async () => {
        // A revision this process has never applied (the commits above moved it through 4).
        await world({ ...BASE, siteAddress: { rev: 20 } });
        const written = configManager.updateConfig((c: any) => siteAddress.applyPlan(c,
            siteAddress.planAliases(c, { aliases: ['https://shop.example.net'], actorId: null, via: 'cli', now: Date.now() }),
            { via: 'cli', actorId: null, now: Date.now() }), { expectRev: rev(), reload: false });
        assert.ok(written.ok);
        assert.strictEqual(await siteAddress.checkExternalChange(), 'applied');
        assert.deepStrictEqual(policyPushes().map((b) => b.config.siteAliases.map((a: any) => a.url)), [['https://shop.example.net']]);
    });

    test('a push the gateway refuses is a warning; the change stands', async () => {
        refuseNextPolicyPush = true;
        const result = await siteAddress.commit((cfg: any) => siteAddress.planAliases(cfg, { aliases: ['https://late.example.net'], actorId: null, via: 'cli', now: Date.now() }),
            { expectRev: rev(), via: 'cli', actorId: null });
        assert.ok(result.warnings.some((w: string) => /gateway could not be told which addresses/.test(w)), JSON.stringify(result.warnings));
        assert.deepStrictEqual(fileConfig().siteAliases.map((a: any) => a.url), ['https://late.example.net']);
    });
});

// ─── where there is no gateway to tell ─────────────────────────────────────────────────────────────

describe('no push where there is no gateway control plane', () => {
    for (const [name, env] of [['the monolith', { WORDJS_MODE: 'mono' }], ['an embedded backend', { WORDJS_EMBEDDED: '1' }]] as const) {
        test(`${name}: nothing is pushed`, async () => {
            await world(BASE);
            Object.assign(process.env, env);
            try {
                await siteAddress.commit((cfg: any) => siteAddress.planPolicy(cfg, { ipLiterals: 'own' }), { expectRev: rev(), via: 'cli', actorId: null });
                assert.strictEqual(await siteAddress.armGateway(), null);
            } finally {
                for (const key of Object.keys(env)) delete process.env[key];
            }
            assert.deepStrictEqual(pushes, []);
        });
    }

    test('a node without cluster identity: nothing is pushed', async () => {
        const { mtls: _omit, ...standalone } = BASE;
        await world(standalone);
        await siteAddress.commit((cfg: any) => siteAddress.planPolicy(cfg, { ipLiterals: 'own' }), { expectRev: rev(), via: 'cli', actorId: null });
        assert.deepStrictEqual(pushes, []);
    });
});

// ─── the body ──────────────────────────────────────────────────────────────────────────────────────

describe('gatewayPolicyPush — the backend\'s own inputs, in the shape the gateway accepts', () => {
    test('enforce follows the install; the environment is this backend\'s; junk is not forwarded', () => {
        process.env.WORDJS_ALLOWED_HOSTS = 'https://edge.example.net';
        process.env.WORDJS_TRUST_PROXY = '10.0.0.0/8';
        try {
            const installed = siteAddress.gatewayPolicyPush({ ...BASE, trustProxy: 'loopback', hostPolicy: { ipLiterals: 'own', ipSignIn: true, extra: 1 } });
            assert.deepStrictEqual(installed, {
                enforce: true,
                config: { siteUrl: 'https://example.com', siteAliases: [], hostPolicy: { ipLiterals: 'own', ipSignIn: true }, trustProxy: 'loopback' },
                env: { WORDJS_ALLOWED_HOSTS: 'https://edge.example.net', WORDJS_TRUST_PROXY: '10.0.0.0/8' },
                nodeEnv: 'production',
            });
            const env = gatewayEdgeFrom(installed);
            assert.strictEqual(env.decide(browser('edge.example.net')).action, 'pass', 'WORDJS_ALLOWED_HOSTS of the BACKEND reaches the edge');

            // Hand-edited values buildPolicy would ignore must not make the gateway refuse the whole push.
            const odd = siteAddress.gatewayPolicyPush({ ...BASE, siteUrl: 42, hostPolicy: { ipLiterals: 5, ipSignIn: 'yes' } });
            assert.deepStrictEqual(odd.config.hostPolicy, {});
            assert.strictEqual(odd.config.siteUrl, null);
            assert.ok(hostEdge.sanitizePolicyPush(odd).ok);

            // Before the install: not enforced, so the wizard is reachable on any address.
            const setup = siteAddress.gatewayPolicyPush({ mtls: MTLS, gatewayHost: 'localhost' });
            assert.strictEqual(setup.enforce, false);
            assert.ok(hostEdge.sanitizePolicyPush(setup).ok);
            assert.strictEqual(gatewayEdgeFrom(setup).decide(browser('anything.example')).action, 'pass');
        } finally {
            delete process.env.WORDJS_ALLOWED_HOSTS;
            delete process.env.WORDJS_TRUST_PROXY;
        }
    });
});
