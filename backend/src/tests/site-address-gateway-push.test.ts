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
 *     whose address is not echoed back), a change the CLI wrote, the end of the boot reconcile, the
 *     re-arm after this backend registers with the gateway (index.ts), and from then on a periodic
 *     re-send, which is what arms a gateway that came back without its stored policy (lab N1 / N4);
 *   · the body is the backend's OWN inputs of buildPolicy, and the gateway's real validator and edge
 *     (gateway/src/host-edge.js) accept it and enforce exactly the new set;
 *   · the gateway's answer carries what its edge refused, and Recently refused lists it (lab X2 / S9.2),
 *     each entry saying whether the edge, this backend's gate or both refused it (lab R2-X2-tag);
 *   · the answer also carries the gateway's own addresses, and `own` means those here: in the gate, the
 *     session check and the IPs a narrowing keeps (lab R2-NEW-1);
 *   · never in the monolith or on a node without cluster identity; a refused push is a warning, the
 *     change stands; an unreadable file pushes nothing (the gateway keeps its last good policy, R10).
 *
 * cert-manager's dialler is stubbed here (its wire is covered by cert-manager-gateway.test.ts against a
 * real mTLS listener); everything between a change and that call is real.
 *
 * MUTATION PROOF (each applied to the source, watched to fail, restored): drop the push from afterChange;
 * drop the arm from reconcileAtBoot; drop the re-arm from index.ts; drop the periodic start from index.ts;
 * stop the timer re-scheduling itself; warn on every failed re-send; ignore the answer's refusals; list
 * only this backend's own refusals; ignore the answer's own addresses; build the policy provider
 * (middleware/auth.ts) or the commit's retirement inputs without them; stop refusing loopback in the
 * report; merge the gateway's refusals without tagging them as the edge's; accept an unspecified,
 * broadcast, multicast or IPv4-mapped address in the report (review R3S-4); keep an older gateway's
 * predecessor's report (review R3S-5); keep the report file at a monolith's boot (review R3S-3); ignore
 * the report held in this process when the file could not be written (review TEST-1).
 */

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
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
/** The gateway is down (every push refused) while true. */
let gatewayDown = false;
/** What the gateway answers a push with (gateway/src/host-edge.js mountHostPolicyPush). */
let gatewayAnswer: Record<string, unknown> = { success: true };
certManager.pushHostPolicyToGateway = async (body: any) => {
    if (refuseNextPolicyPush || gatewayDown) {
        refuseNextPolicyPush = false;
        throw new Error('connect ECONNREFUSED 127.0.0.1:3100');
    }
    pushes.push(['host-policy', JSON.parse(JSON.stringify(body))]);
    return gatewayAnswer;
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
    siteAddress.stopGatewaySync();
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

// ─── lab findings N1 / N4: a gateway that lost its policy is armed again without a backend restart ─

describe('the addresses are re-sent periodically, so a restarted or new gateway is armed again (lab N1 / N4)', () => {
    const until = async (what: string, probe: () => boolean, ms = 3000) => {
        const deadline = Date.now() + ms;
        while (!probe()) {
            if (Date.now() > deadline) assert.fail(`timed out waiting for: ${what}`);
            await new Promise((r) => setTimeout(r, 10));
        }
    };
    afterEach(() => {
        siteAddress.stopGatewaySync();
        gatewayDown = false;
        gatewayAnswer = { success: true };
    });

    test('every interval the file as it is NOW is pushed again — what arms a gateway that came back with nothing stored', async () => {
        await world(BASE);
        siteAddress.startGatewaySync(30);
        siteAddress.startGatewaySync(30); // idempotent: one timer
        await until('two re-sends', () => policyPushes().length >= 2);
        assert.strictEqual(policyPushes()[0].config.siteUrl, 'https://example.com');
        // The gateway lost its file meanwhile (a new container): the next re-send is all it takes, and it
        // carries the current set, read afresh, not one remembered from the boot.
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...BASE, siteAliases: [{ url: 'https://later.example.net' }] }, null, 2));
        configManager.invalidateConfigCache();
        const seen = policyPushes().length;
        await until('a re-send of the new file', () => policyPushes().length > seen && policyPushes().at(-1).config.siteAliases.length === 1);
        const edge = gatewayEdgeFrom(policyPushes().at(-1));
        assert.strictEqual(edge.decide(browser('later.example.net')).action, 'pass');
        assert.strictEqual(edge.decide(browser('evil.example')).action, 'refuse');

        siteAddress.stopGatewaySync();
        await new Promise((r) => setTimeout(r, 30)); // a tick already in flight lands
        const stopped = policyPushes().length;
        await new Promise((r) => setTimeout(r, 150));
        assert.strictEqual(policyPushes().length, stopped, 'stopGatewaySync stops it');
    });

    test('a stop and a new start while a re-send is in flight leave exactly one timer running', async () => {
        await world(BASE);
        const stubbed = certManager.pushHostPolicyToGateway;
        let calls = 0;
        let release: () => void = () => { /* replaced below */ };
        certManager.pushHostPolicyToGateway = async (body: any) => {
            calls += 1;
            if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
            return stubbed(body);
        };
        try {
            siteAddress.startGatewaySync(10);
            await until('a re-send in flight', () => calls === 1);
            siteAddress.stopGatewaySync();
            siteAddress.startGatewaySync(60000);
            release();
            await new Promise((r) => setTimeout(r, 150));
            assert.strictEqual(calls, 1, 'the stopped run scheduled nothing more; the new one waits its own interval');
        } finally {
            certManager.pushHostPolicyToGateway = stubbed;
        }
    });

    test('the interval is jittered within +20%, and the default is half a minute', () => {
        assert.strictEqual(siteAddress.GATEWAY_SYNC_MS, 30000);
        const delays: number[] = [];
        const realSetTimeout = global.setTimeout;
        (global as any).setTimeout = (fn: () => void, ms: number) => { delays.push(ms); return realSetTimeout(() => { /* not run */ }, 1e9); };
        try {
            siteAddress.startGatewaySync(1000);
        } finally {
            (global as any).setTimeout = realSetTimeout;
            siteAddress.stopGatewaySync();
        }
        assert.strictEqual(delays.length, 1);
        assert.ok(delays[0] >= 1000 && delays[0] < 1200, String(delays[0]));
    });

    test('a gateway that is down is reported once, not on every re-send; its return is reported too', async () => {
        await world(BASE);
        const warned: string[] = [];
        const logged: string[] = [];
        const realWarn = console.warn;
        const realLog = console.log;
        console.warn = (m: string) => { warned.push(String(m)); };
        console.log = (m: string) => { logged.push(String(m)); };
        try {
            gatewayDown = true;
            const attempts = () => warned.length + logged.length;
            siteAddress.startGatewaySync(20);
            await new Promise((r) => setTimeout(r, 200));
            assert.strictEqual(warned.filter((w) => /could not tell the gateway/.test(w)).length, 1, warned.join('\n'));
            gatewayDown = false;
            await until('the gateway is reached again', () => logged.some((l) => /reachable again/.test(l)));
            assert.ok(attempts() >= 2);
        } finally {
            console.warn = realWarn;
            console.log = realLog;
        }
    });

    test('a re-send only arms a gateway with nothing stored; a change, a boot and the retry after a failure replace its set (review PL-3)', async () => {
        // Several backends whose files differ each re-sent their own set every half minute, and the gateway
        // stored each in turn: an address was answered for half a minute and refused for the next.
        await world(BASE);
        const warned: string[] = [];
        const realWarn = console.warn;
        console.warn = (m: string) => { warned.push(String(m)); };
        const flags = () => policyPushes().map((b) => b.onlyIfMissing);
        try {
            assert.strictEqual(await siteAddress.armGateway(), null, 'the push after registration');
            await siteAddress.armGateway({ periodic: true });
            assert.deepStrictEqual(flags(), [undefined, true], 'the re-send asks to arm only');
            const edge = gatewayEdgeFrom(policyPushes()[1]);
            assert.strictEqual(edge.decide(browser('evil.example')).action, 'refuse', 'and the gateway still accepts the body as a policy');

            // The gateway keeps another backend's set: said once, not every half minute, and again after it took ours.
            gatewayAnswer = { success: true, stored: 'kept' };
            for (let i = 0; i < 3; i += 1) await siteAddress.armGateway({ periodic: true });
            const keeps = () => warned.filter((w) => /keeps a set of site addresses that differs/.test(w)).length;
            assert.strictEqual(keeps(), 1, warned.join('\n'));
            gatewayAnswer = { success: true, stored: 'unchanged' };
            await siteAddress.armGateway({ periodic: true });
            gatewayAnswer = { success: true, stored: 'kept' };
            await siteAddress.armGateway({ periodic: true });
            assert.strictEqual(keeps(), 2);

            // A push that failed (a change the gateway never got) is retried by the next re-send, which must
            // replace the set rather than ask to keep whatever is there.
            pushes.length = 0;
            gatewayDown = true;
            await siteAddress.armGateway({ periodic: true });
            gatewayDown = false;
            await siteAddress.armGateway({ periodic: true });
            await siteAddress.armGateway({ periodic: true });
            assert.deepStrictEqual(flags(), [undefined, true]);
        } finally {
            console.warn = realWarn;
        }
    });

    test('index.ts starts the re-sends once this backend has registered with a gateway', () => {
        const code = fs.readFileSync(path.resolve(__dirname, '..', 'index.ts'), 'utf8');
        const registerAll = code.slice(code.indexOf('const registerAll'), code.indexOf('let _regAttempt = 0;'));
        const success = registerAll.slice(registerAll.indexOf('All services successfully registered'));
        assert.match(success, /armGateway\(\)[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*require\('\.\/core\/site-address'\)\.startGatewaySync\(\);/,
            'after a successful registration the periodic re-send must start');
        assert.doesNotMatch(code.slice(0, code.indexOf('const registerAll')), /startGatewaySync\(/, 'only there: the monolith never registers, so it never starts it');
    });
});

// ─── lab findings X2 / S9.2: what the gateway's edge refused reaches Settings → Site address ───────

describe('Recently refused lists what the gateway\'s edge refused (lab X2 / S9.2)', () => {
    afterEach(() => {
        gatewayAnswer = { success: true };
        hostPolicy.refusedHosts.clear();
    });

    test('the gateway\'s answer is merged with this backend\'s own refusals, validated, and replaced by the next answer', async () => {
        await world(BASE);
        hostPolicy.refusedHosts.clear();
        hostPolicy.refusedHosts.record('both.example', null);
        gatewayAnswer = {
            success: true,
            stored: 'unchanged',
            refused: [
                { host: 'edge-only.example', count: 7, firstSeen: 1, lastSeen: Date.now() + 1000, hint: 'www-apex' },
                { host: 'both.example', count: 2, firstSeen: 1, lastSeen: 2, hint: null },
                { host: '<script>', count: 1, firstSeen: 1, lastSeen: 1, hint: null },
                { host: 'neg.example', count: -4, firstSeen: 1, lastSeen: 1, hint: null },
                'garbage',
            ],
        };
        assert.strictEqual(await siteAddress.armGateway(), null);
        const listed = (await siteAddress.describeState(null)).recentlyRefused as any[];
        assert.deepStrictEqual(listed.map((e) => [e.host, e.count, e.hint]), [['edge-only.example', 7, 'www-apex'], ['both.example', 3, null]]);

        gatewayAnswer = { success: true, stored: 'unchanged', refused: [] };
        await siteAddress.armGateway();
        assert.deepStrictEqual(((await siteAddress.describeState(null)).recentlyRefused as any[]).map((e) => [e.host, e.count]), [['both.example', 1]],
            'the gateway\'s list is its current one, never added up push after push');
    });

    test('each entry says who refused it: the gateway\'s edge, this backend\'s gate, or both (lab R2-X2-tag)', async () => {
        await world(BASE);
        hostPolicy.refusedHosts.clear();
        hostPolicy.refusedHosts.record('both.example', null, 'gate');
        hostPolicy.refusedHosts.record('gate-only.example', null, 'gate');
        const t = Date.now();
        gatewayAnswer = {
            success: true,
            refused: [
                { host: 'edge-only.example', count: 2, firstSeen: 1, lastSeen: t + 2000, hint: null, source: 'edge' },
                // Whatever an entry claims, everything the gateway lists was refused at its edge (an older
                // gateway says nothing at all).
                { host: 'both.example', count: 1, firstSeen: 1, lastSeen: t + 1000, hint: null, source: 'gate' },
                { host: 'untagged.example', count: 1, firstSeen: 1, lastSeen: t + 500, hint: null },
            ],
        };
        await siteAddress.armGateway();
        const listed = (await siteAddress.describeState(null)).recentlyRefused as any[];
        assert.deepStrictEqual(Object.fromEntries(listed.map((e) => [e.host, e.source])),
            { 'edge-only.example': 'edge', 'both.example': 'both', 'untagged.example': 'edge', 'gate-only.example': 'gate' });
    });

    test('an answer without a list (an older gateway) keeps the last one', async () => {
        await world(BASE);
        gatewayAnswer = { success: true, refused: [{ host: 'kept.example', count: 1, firstSeen: 1, lastSeen: 1, hint: null }] };
        await siteAddress.armGateway();
        gatewayAnswer = { success: true };
        await siteAddress.armGateway();
        assert.deepStrictEqual(((await siteAddress.describeState(null)).recentlyRefused as any[]).map((e) => e.host), ['kept.example']);
        gatewayAnswer = { success: true, refused: [] };
        await siteAddress.armGateway();
    });
});

// ─── lab finding R2-NEW-1: behind a gateway, `own` is the GATEWAY's addresses ────────────────────

describe('`own` means the addresses the gateway reports: the gate, the session check and the retirement record alike (lab R2-NEW-1)', () => {
    // Separate mode: the gateway (192.0.2.157) and this backend (192.0.2.159) are two machines. The edge
    // judged `own` with the gateway's interfaces and the backend with its own, so a session started on the
    // backend node's address — reachable through the gateway while every IP was answered — outlived a
    // narrowing to `own` that the public edge applied, and the narrowing's record kept it.
    const GATEWAY_IP = '192.0.2.157';
    const NODE_IP = '192.0.2.159';
    const realOwn = hostPolicy.ownAddresses;
    const auth = () => require('../middleware/auth');
    const minutesAgo = Math.floor(Date.now() / 1000) - 60;
    beforeEach(() => { hostPolicy.ownAddresses = () => new Set([NODE_IP]); });
    afterEach(() => {
        hostPolicy.ownAddresses = realOwn;
        gatewayAnswer = { success: true };
    });

    const REPORT = path.join(TMP_INSTALL, 'data', 'gateway-own-addresses.json');

    test('the report is validated like wire input, shown as the gateway\'s, and kept beside the config for npm run site', async () => {
        await world(BASE);
        gatewayAnswer = { success: true, ownAddresses: [GATEWAY_IP, '[2001:db8::5]', 'evil.example', '127.0.0.1', '[::1]', '169.254.1.1', '[fe80::1]', '192.0.2.1:80', 'Upper.Example', 42, '01.2.3.4',
            // No interface owns these as its unicast address, and `own` would answer every one (review R3S-4).
            '0.0.0.0', '0.1.2.3', '255.255.255.255', '240.0.0.1', '224.0.0.1', '239.255.255.250', '[::]', '[ff02::1]', '[ff05::1:3]', '[::ffff:c000:201]'] };
        const before = Date.now();
        assert.strictEqual(await siteAddress.armGateway(), null);
        const state = await siteAddress.describeState(null);
        assert.deepStrictEqual(state.ownAddresses, [GATEWAY_IP, '[2001:db8::5]']);
        assert.strictEqual(state.ownAddressesFrom, 'gateway');
        assert.ok(Date.parse(state.ownAddressesReportedAt) >= before - 1000, `reported at ${state.ownAddressesReportedAt}`);
        const kept = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
        assert.deepStrictEqual(kept.addresses, [GATEWAY_IP, '[2001:db8::5]']);
        assert.strictEqual(kept.receivedAt, state.ownAddressesReportedAt);
        assert.deepStrictEqual(siteAddress.ownAddressReport(), { addresses: [GATEWAY_IP, '[2001:db8::5]'], from: 'gateway', receivedAt: state.ownAddressesReportedAt });
    });

    test('a gateway that answers without a report (older than this backend) drops the last one, here and in the file (review R3S-5)', async () => {
        await world(BASE);
        gatewayAnswer = { success: true, ownAddresses: [GATEWAY_IP] };
        await siteAddress.armGateway();
        assert.strictEqual((await siteAddress.describeState(null)).ownAddressesFrom, 'gateway');
        gatewayAnswer = { success: true };
        await siteAddress.armGateway();
        const state = await siteAddress.describeState(null);
        assert.deepStrictEqual([state.ownAddresses, state.ownAddressesFrom, state.ownAddressesReportedAt], [[NODE_IP], 'server', null],
            'no list nothing confirms any more: this machine\'s, as before the report existed');
        assert.strictEqual(fs.existsSync(REPORT), false, 'npm run site does not read it either');
    });

    test('a monolith boot removes a report left by an earlier split or separate run on the same tree (review R3S-3)', async () => {
        await world(BASE);
        gatewayAnswer = { success: true, ownAddresses: [GATEWAY_IP] };
        await siteAddress.armGateway();
        assert.ok(fs.existsSync(REPORT));
        process.env.WORDJS_MODE = 'mono';
        try {
            await (await siteAddress.reconcileAtBoot()).gatewayArmed;
            assert.strictEqual(fs.existsSync(REPORT), false, 'the monolith never refreshes it, so it must not outlive the gateway');
            assert.deepStrictEqual(siteAddress.ownAddressReport(), { addresses: [NODE_IP], from: 'server', receivedAt: null });
        } finally {
            delete process.env.WORDJS_MODE;
        }
        // Behind a gateway the boot keeps it: it is what `npm run site` reads until the next answer.
        await siteAddress.armGateway();
        await (await siteAddress.reconcileAtBoot()).gatewayArmed;
        assert.ok(fs.existsSync(REPORT));
    });

    test('the report applies in this process even when the file cannot be written (review TEST-1)', async () => {
        await world({ ...BASE, hostPolicy: { ipLiterals: 'own' } });
        gatewayAnswer = { success: true };
        await siteAddress.armGateway(); // nothing held, nothing on disk
        const dataDir = path.dirname(REPORT);
        fs.rmSync(dataDir, { recursive: true, force: true });
        fs.writeFileSync(dataDir, 'not a directory'); // the report has nowhere to go
        try {
            gatewayAnswer = { success: true, ownAddresses: [GATEWAY_IP] };
            await siteAddress.armGateway();
            assert.strictEqual(fs.statSync(dataDir).isFile(), true);
            const state = await siteAddress.describeState(null);
            assert.deepStrictEqual([state.ownAddresses, state.ownAddressesFrom], [[GATEWAY_IP], 'gateway']);
            const policy = auth().siteHostPolicy.get();
            assert.strictEqual(hostPolicy.classify(hostPolicy.parseHost(GATEWAY_IP), policy).cls, 'ip');
            assert.strictEqual(hostPolicy.classify(hostPolicy.parseHost(NODE_IP), policy).cls, 'unknown');
            assert.strictEqual(auth().sessionAddressStillAccepted({ userId: 1, username: 'root', mh: NODE_IP, iat: minutesAgo }), false);
        } finally {
            fs.rmSync(dataDir, { force: true });
        }
    });

    test('narrowed to own: the gate and the session check refuse the backend node\'s address as the edge does, and the record keeps only the gateway\'s', async () => {
        await world({ ...BASE, hostPolicy: { ipLiterals: 'any', ipSignIn: true } });
        gatewayAnswer = { success: true, ownAddresses: [GATEWAY_IP] };
        await siteAddress.armGateway();
        const onNode = { userId: 1, username: 'root', mh: NODE_IP, iat: minutesAgo };
        const onGateway = { userId: 1, username: 'root', mh: GATEWAY_IP, iat: minutesAgo };
        assert.strictEqual(auth().sessionAddressStillAccepted(onNode), true, 'every IP answered: both sessions are live');

        await siteAddress.commit((cfg: any) => siteAddress.planPolicy(cfg, { ipLiterals: 'own' }), { expectRev: rev(), via: 'cli', actorId: null });
        const policy = auth().siteHostPolicy.get();
        assert.strictEqual(hostPolicy.classify(hostPolicy.parseHost(GATEWAY_IP), policy).cls, 'ip');
        assert.strictEqual(hostPolicy.classify(hostPolicy.parseHost(NODE_IP), policy).cls, 'unknown', 'the backend refuses what the public edge refuses');
        assert.strictEqual(auth().sessionAddressStillAccepted(onNode), false);
        assert.strictEqual(auth().sessionAddressStillAccepted(onGateway), true);
        assert.deepStrictEqual(fileConfig().siteAddress.retired.ipLiterals.at(-1).kept, [GATEWAY_IP]);

        // Widened again: the session on the node's address stays ended; the gateway's never was.
        await siteAddress.commit((cfg: any) => siteAddress.planPolicy(cfg, { ipLiterals: 'any' }), { expectRev: rev(), via: 'cli', actorId: null });
        assert.strictEqual(auth().sessionAddressStillAccepted(onNode), false);
        assert.strictEqual(auth().sessionAddressStillAccepted(onGateway), true);
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
