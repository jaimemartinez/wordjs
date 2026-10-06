/**
 * WordJS — `npm run site`: managing the site's addresses from the server (backend/scripts/site-address.js).
 *
 * The CLI is the way back in when the admin screen is unreachable, so it must work with no server and no
 * database, write ONLY the config file, and use the very planners and the very writer the admin API uses
 * (core/site-address, core/configManager) — so it can never accept what the API refuses, and never
 * replace an unreadable file (REDTEAM R10). Most cases call its exported run() in-process (fast, and the
 * test runner already has ts-node); one spawns it the way an operator does.
 */

const { describe, test, beforeEach, after } = require('node:test');
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
        assert.match(r.out, /Saved \(revision 4\): added www\.example\.com/);
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
        assert.match(r.out, /also updated frontendUrl/);

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
        assert.match(on.out, /Saved \(revision 4\): IP addresses default → any; sign-in on IP addresses on/);
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

        assert.strictEqual((await site('ip-signin', 'off')).code, 0);
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
