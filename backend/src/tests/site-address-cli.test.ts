/**
 * WordJS — `npm run site`: managing the site's addresses from the server (backend/scripts/site-address.js).
 *
 * The CLI is the way back in when the admin screen is unreachable, so it must work with no server and no
 * database, write ONLY the config file, and use the very planners and the very writer the admin API uses
 * (core/site-address, core/configManager) — so it can never accept what the API refuses, and never
 * replace an unreadable file (REDTEAM R10). Most cases call its exported run() in-process (fast, and the
 * test runner already has ts-node); one spawns it the way an operator does.
 */

const { describe, test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ORIGINAL_CWD = process.cwd();
const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-site-cli-${process.pid}-`));
const CONFIG_FILE = path.join(TMP_INSTALL, 'wordjs-config.json');
const BASE = {
    installedAt: '2026-01-01T00:00:00.000Z',
    dbDriver: 'sqlite-native',
    siteUrl: 'https://example.com',
    frontendUrl: 'https://example.com',
    gatewayUrl: 'https://gw.example.com:3000',
    siteAliases: [{ url: 'https://gw.example.com', source: 'admin' }],
    siteAddress: { rev: 3 },
};
fs.writeFileSync(CONFIG_FILE, JSON.stringify(BASE, null, 2));
process.chdir(TMP_INSTALL);

const configManager = require('../core/configManager');
const hostPolicy = require('../core/host-policy');
const siteAddress = require('../core/site-address');
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'site-address.js');
const cli = require(SCRIPT);
const MODULES = { siteAddress, configManager, hostPolicy };
const NOW = Date.parse('2026-10-06T12:00:00.000Z');

after(() => {
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP_INSTALL, { recursive: true, force: true }); } catch { /* */ }
});

function stage(cfg: Record<string, unknown> | string = BASE) {
    fs.writeFileSync(CONFIG_FILE, typeof cfg === 'string' ? cfg : JSON.stringify(cfg, null, 2));
    configManager.invalidateConfigCache();
}
const fileText = () => fs.readFileSync(CONFIG_FILE, 'utf8');
const fileConfig = () => JSON.parse(fileText());

/** run() with captured output and the given environment; `--dir` always points at the staged installation. */
async function siteEnv(env: Record<string, string>, ...args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await cli.run([...args, '--dir', TMP_INSTALL], {
        stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s),
        env, now: () => NOW, modules: MODULES,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
}
const site = (...args: string[]) => siteEnv({}, ...args);

describe('npm run site — reading', () => {
    beforeEach(() => stage());

    test('list shows the main address, the other addresses, the revision and the IP policy', async () => {
        const r = await site('list');
        assert.strictEqual(r.code, 0, r.err);
        assert.match(r.out, /^Main address: https:\/\/example\.com$/m);
        assert.match(r.out, /^Revision: 3$/m);
        assert.match(r.out, /https:\/\/gw\.example\.com {2}serve {2}sign-in yes \(default\) {2}source admin/);
        assert.match(r.out, /IP addresses: any \(default\)/);
    });

    test('check says what the gate would do, and why', async () => {
        const cases: Array<[string, number, RegExp]> = [
            ['example.com', 0, /answered as canonical/],
            ['GW.example.com.', 0, /gw\.example\.com: answered as alias/],
            ['192.168.1.5:3000', 0, /answered as ip .*\n.*behind a proxy/],
            ['evil.example', 1, /evil\.example: refused \(421\) — undeclared; add it with/],
            ['wordjs_upstream', 1, /refused \(421\).*proxy_set_header Host \$host/],
            ['a b', 1, /malformed — the server answers 400/],
        ];
        for (const [host, code, re] of cases) {
            const r = await site('check', host);
            assert.strictEqual(r.code, code, `${host}: ${r.out}${r.err}`);
            assert.match(r.out, re, host);
        }
    });

    test('usage errors exit 2 and change nothing', async () => {
        const before = fileText();
        for (const args of [['frobnicate'], ['add'], ['list', '--bogus'], ['add', 'https://x.example', '--expires']]) {
            const r = await site(...args);
            assert.strictEqual(r.code, 2, `${args.join(' ')}: ${r.out}${r.err}`);
            assert.match(r.err, /Usage: npm run site/);
        }
        assert.strictEqual(fileText(), before);
    });
});

describe('npm run site — writing the file only', () => {
    beforeEach(() => stage());

    test('add: a new address, recorded as a CLI change with the next revision', async () => {
        const r = await site('add', 'https://WWW.example.com/', '--label', 'www twin');
        assert.strictEqual(r.code, 0, r.err);
        assert.match(r.out, /^Saved \(revision 4\): Other addresses changed\. Added: www\.example\.com\. Removed: none\. Edited: none\.$/m);
        const cfg = fileConfig();
        assert.deepStrictEqual(cfg.siteAliases.map((a: any) => [a.url, a.source, a.label]),
            [['https://gw.example.com', 'admin', undefined], ['https://www.example.com', 'cli', 'www twin']]);
        assert.strictEqual(cfg.siteAddress.rev, 4);
        assert.deepStrictEqual({ kind: cfg.siteAddress.lastChange.kind, via: cfg.siteAddress.lastChange.via, by: cfg.siteAddress.lastChange.by },
            { kind: 'aliases', via: 'cli', by: null });
        assert.strictEqual(cfg.installedAt, BASE.installedAt, 'the rest of the install is untouched');
    });

    test('add: tunnel names expire in a week unless told otherwise', async () => {
        await site('add', 'https://ab12.ngrok-free.app');
        assert.strictEqual(fileConfig().siteAliases[1].expiresAt, new Date(NOW + 7 * 864e5).toISOString());
        stage();
        await site('add', 'https://ab12.ngrok-free.app', '--expires', '24h');
        assert.strictEqual(fileConfig().siteAliases[1].expiresAt, new Date(NOW + 864e5).toISOString());
        stage();
        await site('add', 'https://ab12.ngrok-free.app', '--expires', 'never');
        assert.strictEqual(fileConfig().siteAliases[1].expiresAt, undefined);
    });

    test('add: sign-in over plain http is an explicit opt-in; .local needs --confirm-local; garbage is refused', async () => {
        assert.strictEqual((await site('add', 'http://intranet.example.com:8080', '--http-signin')).code, 0);
        assert.strictEqual(fileConfig().siteAliases[1].signIn, true);
        const before = fileText();
        const local = await site('add', 'http://printer.local');
        assert.strictEqual(local.code, 1);
        assert.match(local.err, /\.local name/);
        assert.strictEqual(fileText(), before);
        assert.strictEqual((await site('add', 'http://printer.local', '--confirm-local')).code, 0);
        for (const bad of ['https://*.example.com', 'https://a@b.example', 'https,https://x.example', 'ftp://x.example']) {
            const r = await site('add', bad);
            assert.strictEqual(r.code, 1, bad);
        }
    });

    test('remove: refused while the gateway URL names it, unless forced', async () => {
        const before = fileText();
        const refused = await site('remove', 'gw.example.com');
        assert.strictEqual(refused.code, 1);
        assert.match(refused.err, /gatewayUrl → https:\/\/gw\.example\.com:3000/);
        assert.strictEqual(fileText(), before);
        const forced = await site('remove', 'https://gw.example.com', '--force');
        assert.strictEqual(forced.code, 0, forced.err);
        assert.match(forced.out, /Forced past: gatewayUrl/);
        assert.deepStrictEqual(fileConfig().siteAliases, []);
    });

    test('remove --force records the override and what it went past, with the revision (critic finding)', async () => {
        const forced = await site('remove', 'gw.example.com', '--force');
        assert.strictEqual(forced.code, 0, forced.err);
        const { lastChange, changes } = fileConfig().siteAddress;
        assert.deepStrictEqual({ rev: lastChange.rev, kind: lastChange.kind, via: lastChange.via, force: lastChange.force, forcedPast: lastChange.forcedPast, removed: lastChange.removed },
            { rev: 4, kind: 'aliases', via: 'cli', force: true, forcedPast: ['gatewayUrl https://gw.example.com:3000'], removed: ['gw.example.com'] });
        assert.deepStrictEqual(changes, [lastChange], 'the same record is in the log the running backend audits from');
        stage();
        assert.strictEqual((await site('add', 'https://www.example.com')).code, 0);
        assert.strictEqual(fileConfig().siteAddress.lastChange.force, false, 'no --force, no override on the record');
        assert.strictEqual(fileConfig().siteAddress.lastChange.forcedPast, undefined);
    });

    test('every revision is kept in a bounded log, oldest dropped first (lab M-16)', async () => {
        for (let i = 0; i < siteAddress.MAX_CHANGE_LOG + 3; i++) assert.strictEqual((await site('ip-literals', i % 2 ? 'any' : 'own')).code, 0);
        const { rev, changes } = fileConfig().siteAddress;
        assert.strictEqual(rev, 3 + siteAddress.MAX_CHANGE_LOG + 3);
        assert.strictEqual(changes.length, siteAddress.MAX_CHANGE_LOG);
        assert.deepStrictEqual(changes.map((c: any) => c.rev), Array.from({ length: siteAddress.MAX_CHANGE_LOG }, (_, i) => rev - siteAddress.MAX_CHANGE_LOG + 1 + i));
        assert.ok(changes.every((c: any) => c.kind === 'policy' && c.via === 'cli' && c.by === null), JSON.stringify(changes[0]));
    });

    test('canonical with the address the file already holds: nothing to change — unless the file has no revision yet (an upgrade conflict)', async () => {
        const { siteAddress: _rev, ...legacy } = BASE;
        stage(legacy);
        const r = await site('canonical', 'https://example.com');
        assert.strictEqual(r.code, 0, r.err);
        // Said as the administrators' notice says it: a choice, not a move "from X to X" (review UX-4).
        assert.match(r.out, /^Saved \(revision 1\): example\.com was confirmed as the main address\.$/m);
        const cfg = fileConfig();
        assert.strictEqual(cfg.siteUrl, 'https://example.com');
        assert.deepStrictEqual(cfg.siteAliases, BASE.siteAliases, 'nothing else moves');
        assert.deepStrictEqual({ kind: cfg.siteAddress.lastChange.kind, confirmed: cfg.siteAddress.lastChange.confirmed }, { kind: 'canonical', confirmed: true });
        assert.match((await site('canonical', 'https://example.com')).out, /Nothing to change/, 'once recorded, it is a no-op again');
    });

    test('list after a fresh install says so (lab M-03)', async () => {
        stage({ ...BASE, siteAddress: siteAddress.installRecord(NOW) });
        assert.match((await site('list')).out, /^Revision: 1 \(last change: install via install at 2026-10-06T12:00:00\.000Z\)$/m);
    });

    test('remove: the main address and unknown names are usage errors, with the right next step', async () => {
        const main = await site('remove', 'example.com');
        assert.strictEqual(main.code, 2);
        assert.match(main.err, /canonical <url> --drop-old/);
        assert.strictEqual((await site('remove', 'nope.example')).code, 2);
    });

    test('canonical: keeps the old address by default and moves frontendUrl with it (R3)', async () => {
        const r = await site('canonical', 'https://new.example');
        assert.strictEqual(r.code, 0, r.err);
        const cfg = fileConfig();
        assert.strictEqual(cfg.siteUrl, 'https://new.example');
        assert.strictEqual(cfg.frontendUrl, 'https://new.example');
        assert.strictEqual(cfg.gatewayUrl, 'https://gw.example.com:3000', 'another origin: untouched');
        // The untouched entry is kept exactly as stored (no mode written for it); the old main address is added.
        assert.deepStrictEqual(cfg.siteAliases.map((a: any) => [a.url, a.mode]), [['https://gw.example.com', undefined], ['https://example.com', 'serve']]);
        assert.match(r.out, /^Saved \(revision 4\): The main address changed from example\.com to new\.example\. The old address is kept as another address\. It also updated frontendUrl\.$/m);

        stage();
        assert.strictEqual((await site('canonical', 'https://new.example', '--drop-old')).code, 0);
        assert.deepStrictEqual(fileConfig().siteAliases.map((a: any) => a.url), ['https://gw.example.com']);
        stage();
        assert.strictEqual((await site('canonical', 'https://new.example', '--keep-old', '--drop-old')).code, 2);
    });

    test('ip-literals', async () => {
        assert.strictEqual((await site('ip-literals', 'own')).code, 0);
        assert.deepStrictEqual(fileConfig().hostPolicy, { ipLiterals: 'own' });
        assert.strictEqual((await site('ip-literals', 'some')).code, 1);
    });

    test('ip-signin on|off: the switch for sign-in on IP addresses, written without touching the IP mode', async () => {
        const on = await site('ip-signin', 'on');
        assert.strictEqual(on.code, 0, on.err);
        // No stored IP rule reads as `any`, as the server reads it: the switch is all that moved (review UX-4).
        assert.match(on.out, /^Saved \(revision 4\): Signing in on IP addresses was turned on\.$/m);
        // The main address is https: a plain-http sign-in on an IP is still refused, and the operator is told how to opt in.
        assert.match(on.out, /still refused[^]*add http:\/\/<ip>:<port> --http-signin/);
        assert.deepStrictEqual(fileConfig().hostPolicy, { ipLiterals: 'any', ipSignIn: true });
        assert.strictEqual(hostPolicy.buildPolicy({ config: fileConfig(), env: {}, nodeEnv: 'production' }).ipSignIn, true, 'the server reads it as on');
        assert.match((await site('list')).out, /sign-in on IP addresses: on/);

        const before = fileText();
        const again = await site('ip-signin', 'on');
        assert.strictEqual(again.code, 0);
        assert.match(again.out, /Nothing to change/);
        assert.strictEqual(fileText(), before);

        const off = await site('ip-signin', 'off');
        assert.strictEqual(off.code, 0);
        assert.match(off.out, /^Saved \(revision 5\): Signing in on IP addresses was turned off\.$/m);
        assert.deepStrictEqual(fileConfig().hostPolicy, { ipLiterals: 'any', ipSignIn: false });
        assert.strictEqual(fileConfig().siteAddress.rev, 5);

        // ip-literals keeps the sign-in choice, as ip-signin keeps the IP mode.
        stage({ ...BASE, hostPolicy: { ipLiterals: 'own', ipSignIn: true } });
        assert.strictEqual((await site('ip-literals', 'none')).code, 0);
        assert.deepStrictEqual(fileConfig().hostPolicy, { ipLiterals: 'none', ipSignIn: true });
    });

    test('ip-signin writes back the IP mode the FILE holds, never the WORDJS_IP_HOSTS override', async () => {
        stage({ ...BASE, hostPolicy: { ipLiterals: 'own' } });
        const r = await siteEnv({ WORDJS_IP_HOSTS: 'none' }, 'ip-signin', 'on');
        assert.strictEqual(r.code, 0, r.err);
        assert.deepStrictEqual(fileConfig().hostPolicy, { ipLiterals: 'own', ipSignIn: true });
    });

    test('ip-signin: a value already in force writes nothing, and anything but on|off is a usage error', async () => {
        const before = fileText();
        const off = await site('ip-signin', 'off');
        assert.strictEqual(off.code, 0, off.err);
        assert.match(off.out, /Nothing to change/);
        assert.strictEqual(fileText(), before, 'off is the default: no revision, no ipLiterals pinned into the file');
        for (const args of [['ip-signin'], ['ip-signin', 'yes'], ['ip-signin', 'ON']]) {
            const r = await site(...args);
            assert.strictEqual(r.code, 2, args.join(' '));
            assert.match(r.err, /ip-signin needs on or off/);
        }
        assert.strictEqual(fileText(), before);
        const dev = await siteEnv({ NODE_ENV: 'development' }, 'ip-signin', 'off');
        assert.match(dev.out, /runs in development, where signing in is allowed on every address/);
    });

    test('nothing to change writes nothing', async () => {
        const before = fileText();
        const r = await site('canonical', 'https://EXAMPLE.com');
        assert.strictEqual(r.code, 0);
        assert.match(r.out, /Nothing to change/);
        assert.strictEqual(fileText(), before);
    });
});

describe('npm run site — the sessions a change ends stay ended (lab finding S6.6)', () => {
    const NOW_S = Math.floor(NOW / 1000);
    const WITH_WWW = { ...BASE, siteAliases: [...BASE.siteAliases, { url: 'https://www.example.com', source: 'admin' }] };
    const retired = () => fileConfig().siteAddress.retired;
    beforeEach(() => stage(WITH_WWW));

    test('remove records when the address stopped being answered, and adding it back keeps the record', async () => {
        assert.strictEqual((await site('remove', 'www.example.com')).code, 0);
        assert.deepStrictEqual(retired(), { hosts: { 'www.example.com': NOW_S }, ipLiterals: [] });
        const readded = await site('add', 'https://www.example.com');
        assert.strictEqual(readded.code, 0, readded.err);
        assert.deepStrictEqual(retired(), { hosts: { 'www.example.com': NOW_S }, ipLiterals: [] }, 'the re-add does not erase the retirement');
        // What the gate reads, in this very process.
        assert.strictEqual(siteAddress.sessionRetired('www.example.com', NOW_S - 600), true, 'a session from before the removal stays ended');
        assert.strictEqual(siteAddress.sessionRetired('www.example.com', NOW_S + 600), false, 'a session started after the re-add is a new session');
        assert.strictEqual(siteAddress.sessionRetired('gw.example.com', NOW_S - 600), false, 'another alias is untouched');
        assert.strictEqual(siteAddress.sessionRetired('example.com', NOW_S - 600), false, 'the main address is untouched');
    });

    test('canonical --drop-old retires the old main address; --keep-old and --redirect-old do not', async () => {
        assert.strictEqual((await site('canonical', 'https://new.example', '--drop-old')).code, 0);
        assert.deepStrictEqual(retired(), { hosts: { 'example.com': NOW_S }, ipLiterals: [] });
        for (const flag of ['--keep-old', '--redirect-old']) {
            stage(WITH_WWW);
            assert.strictEqual((await site('canonical', 'https://new.example', flag)).code, 0, flag);
            assert.strictEqual(retired(), undefined, `${flag}: the old main address is still answered`);
        }
    });

    test('a name still answered by another rule retires nothing: WORDJS_ALLOWED_HOSTS, or an IP while every IP is accepted', async () => {
        const env = await siteEnv({ WORDJS_ALLOWED_HOSTS: 'www.example.com' }, 'remove', 'www.example.com');
        assert.strictEqual(env.code, 0, env.err);
        assert.strictEqual(retired(), undefined);
        stage({ ...BASE, siteAliases: [...BASE.siteAliases, { url: 'http://198.51.100.7:3000', source: 'admin' }] });
        assert.strictEqual((await site('remove', '198.51.100.7')).code, 0);
        assert.strictEqual(retired(), undefined, 'ipLiterals is any: the IP is still answered, and so are its sessions');
    });

    test('narrowing the IP rule records the IPs still answered; widening it again retires nothing and keeps the record', async () => {
        stage({ ...BASE, siteAliases: [...BASE.siteAliases, { url: 'http://198.51.100.7:3000', source: 'admin' }] });
        assert.strictEqual((await site('ip-literals', 'own')).code, 0);
        const own = [...hostPolicy.ownAddresses()];
        const [event] = retired().ipLiterals;
        assert.strictEqual(event.at, NOW_S);
        assert.deepStrictEqual(event.kept, [...new Set(['198.51.100.7', ...own])].sort(), 'own addresses and the declared IP stay answered');
        assert.strictEqual(siteAddress.sessionRetired('203.0.113.9', NOW_S - 600), true, 'a foreign IP\'s session ends');
        assert.strictEqual(siteAddress.sessionRetired('198.51.100.7', NOW_S - 600), false, 'the declared IP keeps its sessions');
        for (const ip of own) assert.strictEqual(siteAddress.sessionRetired(ip, NOW_S - 600), false, `own address ${ip} keeps its sessions`);

        assert.strictEqual((await site('ip-literals', 'any')).code, 0);
        assert.strictEqual(retired().ipLiterals.length, 1, 'widening ends nothing');
        assert.strictEqual(siteAddress.sessionRetired('203.0.113.9', NOW_S - 600), true, 'and does not bring the foreign IP\'s sessions back');

        assert.strictEqual((await site('ip-literals', 'none')).code, 0);
        assert.deepStrictEqual(retired().ipLiterals.map((e: any) => e.kept), [event.kept, ['198.51.100.7']], 'none keeps only the declared IP');
    });

    test('an override in WORDJS_IP_HOSTS means the file change narrows nothing, so nothing is retired', async () => {
        const r = await siteEnv({ WORDJS_IP_HOSTS: 'any' }, 'ip-literals', 'none');
        assert.strictEqual(r.code, 0, r.err);
        assert.strictEqual(retired(), undefined);
    });
});

describe('npm run site — behind a gateway, `own` is the gateway\'s addresses (lab finding R2-NEW-1)', () => {
    // Separate mode, run on the backend node (192.0.2.159): the gateway (192.0.2.157) is another machine,
    // and its edge answers `own` with ITS addresses. The lab's `ip-literals own` recorded the node's own
    // address as kept, so a session started on it came back once every IP was answered again.
    const GATEWAY_IP = '192.0.2.157';
    const NODE_IP = '192.0.2.159';
    const REPORT = path.join(TMP_INSTALL, 'data', 'gateway-own-addresses.json');
    const FRONTED = { ...BASE, mtls: { cert: './certs/backend.crt' } };
    const realOwn = hostPolicy.ownAddresses;
    const kept = () => fileConfig().siteAddress.retired.ipLiterals.map((e: any) => e.kept);
    const report = (addresses: unknown[]) => {
        fs.mkdirSync(path.dirname(REPORT), { recursive: true });
        fs.writeFileSync(REPORT, JSON.stringify({ format: 1, receivedAt: '2026-10-06T12:00:00.000Z', addresses }));
    };
    beforeEach(() => { hostPolicy.ownAddresses = () => new Set([NODE_IP]); });
    afterEach(() => {
        hostPolicy.ownAddresses = realOwn;
        fs.rmSync(path.dirname(REPORT), { recursive: true, force: true });
    });

    test('with the report the backend keeps beside the config, the narrowing and `check` judge the gateway\'s address, not this node\'s', async () => {
        stage(FRONTED);
        report([GATEWAY_IP, 'evil.example', '127.0.0.1']);
        const r = await site('ip-literals', 'own');
        assert.strictEqual(r.code, 0, r.err);
        assert.deepStrictEqual(kept(), [[GATEWAY_IP]]);
        assert.match((await site('check', GATEWAY_IP)).out, /answered as ip \(ip-own\)/);
        assert.match((await site('check', NODE_IP)).out, /refused \(421\) — ip-not-own/);
    });

    test('without a gateway, or before it ever reported, this machine\'s addresses: as before', async () => {
        stage(BASE); // the monolith: a report left over from another deployment shape is not read
        report([GATEWAY_IP]);
        assert.strictEqual((await site('ip-literals', 'own')).code, 0);
        assert.deepStrictEqual(kept(), [[NODE_IP]]);
        stage(FRONTED);
        fs.rmSync(REPORT);
        assert.strictEqual((await site('ip-literals', 'own')).code, 0);
        assert.deepStrictEqual(kept(), [[NODE_IP]]);
    });

    test('list and check say which addresses `own` was judged with, and where they come from (review R3S-3)', async () => {
        stage({ ...FRONTED, hostPolicy: { ipLiterals: 'own' } });
        report([GATEWAY_IP]);
        const fromGateway = `\`own\` means the gateway's addresses, as it reported them at 2026-10-06T12:00:00.000Z: ${GATEWAY_IP}`;
        assert.match((await site('list')).out, new RegExp(`^  ${literal(fromGateway)}$`, 'm'));
        const refused = await site('check', NODE_IP);
        assert.match(refused.out, new RegExp(`ip-not-own[^]*^  \\(${literal(fromGateway)}\\)$`, 'm'));
        assert.match((await site('check', GATEWAY_IP)).out, new RegExp(`^  \\(${literal(fromGateway)}\\)$`, 'm'));

        fs.rmSync(REPORT);
        const fromServer = `\`own\` means this machine's addresses: ${NODE_IP}`;
        assert.match((await site('list')).out, new RegExp(`^  ${literal(fromServer)}$`, 'm'));
        assert.match((await site('check', GATEWAY_IP)).out, new RegExp(`^  \\(${literal(fromServer)}\\)$`, 'm'));
        assert.doesNotMatch((await site('check', 'example.com')).out, /`own` means/, 'a name is not judged by the IP rule');
    });
});

/** A literal for a RegExp. */
function literal(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('the retirement record (core/site-address applyPlan / sessionRetired)', () => {
    const NOW_S = Math.floor(NOW / 1000);
    const DAY = 86400;
    const plan = (cfg: any, aliases: unknown[]) => siteAddress.planAliases(cfg, { aliases, actorId: null, via: 'cli', now: NOW });
    const apply = (cfg: any, p: any) => siteAddress.applyPlan(cfg, p, { via: 'cli', actorId: null, now: NOW, env: {}, nodeEnv: 'production', ownAddresses: () => new Set<string>() });

    test('entries older than the retention are pruned; younger ones are kept and merged', () => {
        const cfg = { ...BASE, siteAliases: [...BASE.siteAliases, { url: 'https://www.example.com' }],
            siteAddress: { rev: 3, retired: { hosts: { 'old.example.com': NOW_S - 8 * DAY, 'young.example.com': NOW_S - DAY }, ipLiterals: [{ at: NOW_S - 8 * DAY, kept: [] }] } } };
        const next = apply(cfg, plan(cfg, ['https://gw.example.com']));
        assert.deepStrictEqual(next.siteAddress.retired, { hosts: { 'young.example.com': NOW_S - DAY, 'www.example.com': NOW_S }, ipLiterals: [] });
    });

    test('an alias that had expired is recorded at its expiry when it is extended, so its old sessions stay ended', () => {
        const expired = new Date(NOW - 3600e3).toISOString();
        const cfg = { ...BASE, siteAliases: [...BASE.siteAliases, { url: 'https://t.example.com', expiresAt: expired }] };
        const next = apply(cfg, plan(cfg, ['https://gw.example.com', { url: 'https://t.example.com', expiresAt: null }]));
        assert.deepStrictEqual(next.siteAddress.retired.hosts, { 't.example.com': NOW_S - 3600 });
    });

    test('past the cap the oldest entries fold into `overflow`, which ends every bound session issued until then', () => {
        const hosts: Record<string, number> = {};
        for (let i = 0; i < 1000; i++) hosts[`h${i}.example.com`] = NOW_S - DAY + i;
        const cfg = { ...BASE, siteAliases: [...BASE.siteAliases, { url: 'https://www.example.com' }], siteAddress: { rev: 3, retired: { hosts, ipLiterals: [] } } };
        const record = apply(cfg, plan(cfg, ['https://gw.example.com'])).siteAddress.retired;
        assert.strictEqual(Object.keys(record.hosts).length, 1000);
        assert.strictEqual(record.hosts['h0.example.com'], undefined, 'the oldest was folded');
        assert.strictEqual(record.overflow, NOW_S - DAY);
        assert.strictEqual(record.hosts['www.example.com'], NOW_S);
    });

    test('the reader: grace after the instant, overflow, a missing iat, and a malformed record', () => {
        stage({ ...BASE, siteAddress: { rev: 3, retired: { hosts: { 'www.example.com': NOW_S }, ipLiterals: [], overflow: NOW_S - DAY } } });
        const grace = siteAddress.RETIREMENT_GRACE_S;
        assert.strictEqual(siteAddress.sessionRetired('www.example.com', NOW_S + grace), true, 'minted by a process that had not seen the change yet');
        assert.strictEqual(siteAddress.sessionRetired('www.example.com', NOW_S + grace + 1), false);
        assert.strictEqual(siteAddress.sessionRetired('www.example.com', undefined), true, 'no iat: issued before everything');
        assert.strictEqual(siteAddress.sessionRetired('example.com', NOW_S - DAY), true, 'overflow ends every bound session issued until then');
        assert.strictEqual(siteAddress.sessionRetired('example.com', NOW_S - DAY + grace + 1), false);
        // When it stops holding (sign-in answers rest_address_retiring until then, lab R2V-M-NF1): the
        // first second past the latest retirement that covers the session.
        assert.strictEqual(siteAddress.sessionRetiredUntil('www.example.com', NOW_S + 2), NOW_S + grace + 1);
        assert.strictEqual(siteAddress.sessionRetiredUntil('www.example.com', NOW_S + grace + 1), null);
        assert.strictEqual(siteAddress.sessionRetiredUntil('example.com', NOW_S - DAY), NOW_S - DAY + grace + 1);
        assert.strictEqual(siteAddress.sessionRetiredUntil('www.example.com', NOW_S - DAY), NOW_S + grace + 1, 'the latest of the two that cover it');
        stage({ ...BASE, siteAddress: { rev: 3, retired: { hosts: {}, ipLiterals: [{ at: NOW_S, kept: ['198.51.100.7'] }] } } });
        assert.strictEqual(siteAddress.sessionRetiredUntil('203.0.113.9', NOW_S), NOW_S + grace + 1, 'an IP the narrowing did not keep');
        assert.strictEqual(siteAddress.sessionRetiredUntil('198.51.100.7', NOW_S), null, 'an IP it kept');
        stage({ ...BASE, siteAddress: { rev: 3, retired: { hosts: ['x'], ipLiterals: 'y', overflow: -1 } } });
        assert.strictEqual(siteAddress.sessionRetired('www.example.com', NOW_S), false, 'a malformed record is ignored, never thrown');
    });
});

describe('npm run site — the file is never damaged (R10)', () => {
    test('an unreadable config is refused for reads and writes, and left exactly as it is', async () => {
        const garbage = '{"dbDriver": "sqlite-native", "jwtSecret": "keep", "siteUrl": ';
        stage(garbage);
        for (const args of [['list'], ['add', 'https://www.example.com'], ['canonical', 'https://new.example']]) {
            const r = await site(...args);
            assert.strictEqual(r.code, 1, args.join(' '));
            assert.match(r.err, /cannot be read as JSON/);
        }
        assert.strictEqual(fileText(), garbage);
    });

    test('a change that raced another writer is refused, not merged', async () => {
        stage();
        // Another writer (the admin screen) commits between this command's read and its write.
        const racing = {
            ...MODULES,
            siteAddress: {
                ...siteAddress,
                applyPlan: (...args: any[]) => {
                    if (configManager.siteAddressRev(fileConfig()) === 3) {
                        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...fileConfig(), siteAddress: { rev: 4 } }, null, 2));
                    }
                    return siteAddress.applyPlan(...args);
                },
            },
        };
        const err: string[] = [];
        const code = await cli.run(['add', 'https://www.example.com', '--dir', TMP_INSTALL], { stdout: () => {}, stderr: (s: string) => err.push(s), env: {}, now: () => NOW, modules: racing });
        assert.strictEqual(code, 1);
        assert.match(err.join('\n'), /changed while this command ran/);
        assert.strictEqual(fileConfig().siteAddress.rev, 4, 'the other writer\'s change stands');
        assert.ok(!fileConfig().siteAliases.some((a: any) => a.url === 'https://www.example.com'));
    });

    test('a missing config is reported, never created', async () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-site-cli-empty-${process.pid}-`));
        try {
            const r = spawnSync(process.execPath, [SCRIPT, 'list', '--dir', empty], { encoding: 'utf8', timeout: 120000 });
            assert.strictEqual(r.status, 1, r.stderr);
            assert.match(r.stderr, /no wordjs-config\.json/);
            assert.ok(!fs.existsSync(path.join(empty, 'wordjs-config.json')));
        } finally {
            fs.rmSync(empty, { recursive: true, force: true });
        }
    });
});

describe('npm run site — as an operator runs it', () => {
    test('the script runs on its own (ts-node on src/) and edits the installation it is pointed at', () => {
        stage();
        const r = spawnSync(process.execPath, [SCRIPT, 'add', 'https://shell.example.com', '--dir', TMP_INSTALL], { encoding: 'utf8', timeout: 120000 });
        assert.strictEqual(r.status, 0, r.stderr);
        assert.match(r.stdout, /Saved \(revision 4\)/);
        assert.ok(fileConfig().siteAliases.some((a: any) => a.url === 'https://shell.example.com'));
        const usage = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 120000 });
        assert.strictEqual(usage.status, 2);
        assert.match(usage.stdout, /Usage: npm run site/);
    });
});
