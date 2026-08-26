/**
 * THE REVIEWED-SAFE LIST, ATTACKED RATHER THAN ASSERTED.
 *
 * `secure-require.ts` now classifies every Node builtin, and 31 of them sit in `REVIEWED_SAFE_BUILTINS`
 * with the claim that they "cannot reach outside the process on their own". Writing that down is a
 * declaration. A declaration is not an authorisation, and this repository has been caught believing one
 * before — so the claim is exercised here, inside a REAL forked isolate, by a plugin that tries to use
 * those modules to escape.
 *
 * The three that make the list interesting, and the reason the note in secure-require singles them out:
 *   · `tty.ReadStream(fd)` wraps an ARBITRARY descriptor. fd 3 is NODE_CHANNEL_FD, the plugin's IPC
 *     channel to the host. If a plugin can read it directly it sees every RPC reply the host sends —
 *     including the results of other calls — and if it can write it directly it speaks to the bridge
 *     outside the bridge's own framing.
 *   · `process` — the module form of the global. The child's env is an allow-list built at spawn
 *     (SAFE_ENV_KEYS), so this asks whether that allow-list actually held.
 *   · `console.Console(stream)` writes to any stream it is handed.
 *
 * TRUE in every probe below means CONTAINED. A probe that cannot even acquire the capability reports
 * contained for the right reason, and each one records WHY so a future reader can tell "blocked" from
 * "never worked here anyway".
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-builtin-escape-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
require('../config/database');
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('../core/plugin-isolate');

const PLUGINS_ROOT = path.resolve(__dirname, '../../plugins');
const SLUG = 'wjs-builtin-escape';

// A marker only the HOST knows. If it ever appears in the child's view of the world, the allow-list that
// was supposed to keep it out did not hold.
const HOST_SECRET = `wjs-host-only-${process.pid}-${Date.now()}`;

function writeFixture(slug: string, initBody: string) {
    const dir = path.join(PLUGINS_ROOT, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'),
        JSON.stringify({ name: slug, isolated: true, permissions: [] }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'exports.init = function (wordjs) {\n' + initBody + '\n};\n');
    return dir;
}

const PROBE_BODY = `
    const out = {};
    const grab = (id) => { try { return { mod: require(id) }; } catch (e) { return { err: String(e && e.message || e) }; } };

    // ── tty: wrap the IPC descriptor directly ────────────────────────────────────────────────────
    const tty = grab('tty');
    out.ttyRequirable = !tty.err;
    out.ttyReadFd3 = (() => {
        if (tty.err) return { contained: true, why: 'require(tty) itself threw: ' + tty.err };
        try {
            const s = new tty.mod.ReadStream(3);
            try { s.destroy(); } catch (e) {}
            return { contained: false, why: 'ReadStream(3) constructed — the IPC channel is directly readable' };
        } catch (e) { return { contained: true, why: String(e && e.message || e) }; }
    })();
    out.ttyWriteFd3 = (() => {
        if (tty.err) return { contained: true, why: 'require(tty) threw' };
        try {
            const s = new tty.mod.WriteStream(3);
            try { s.destroy(); } catch (e) {}
            return { contained: false, why: 'WriteStream(3) constructed — the IPC channel is directly writable' };
        } catch (e) { return { contained: true, why: String(e && e.message || e) }; }
    })();

    // ── process: does the host environment leak in? ──────────────────────────────────────────────
    const proc = grab('process');
    out.processRequirable = !proc.err;
    out.envKeys = proc.err ? [] : Object.keys(proc.mod.env || {}).sort();
    out.hostSecretVisible = proc.err ? false
        : JSON.stringify(proc.mod.env || {}).indexOf(${JSON.stringify(HOST_SECRET)}) !== -1;
    // The module form and the global must be the SAME object, or one of them is unguarded.
    out.processSameAsGlobal = proc.err ? null : (proc.mod === process);

    // ── console: write to an arbitrary descriptor via a Console over a raw stream ─────────────────
    out.consoleToFd = (() => {
        const c = grab('console');
        if (c.err) return { contained: true, why: 'require(console) threw' };
        try {
            const fsMod = require('fs');
            const stream = fsMod.createWriteStream('', { fd: 3 });
            new c.mod.Console(stream).log('probe');
            return { contained: false, why: 'a Console was pointed at fd 3 and wrote to it' };
        } catch (e) { return { contained: true, why: String(e && e.message || e) }; }
    })();

    // ── every other reviewed-safe module: does requiring it even work, and does it hand back
    //    anything that spawns, opens or connects? ────────────────────────────────────────────────
    out.suspicious = [];
    for (const id of ['zlib','crypto','url','util','stream','perf_hooks','domain','sea','readline','timers','punycode','querystring','string_decoder','buffer','events','path','assert','constants','sys','util/types','stream/web','timers/promises']) {
        const g = grab(id);
        if (g.err) continue;
        const m = g.mod || {};
        for (const key of ['spawn','spawnSync','exec','execSync','fork','open','openSync','connect','createConnection','createServer','request','Socket','Server']) {
            if (typeof m[key] === 'function') out.suspicious.push(id + '.' + key);
        }
    }

    wordjs.hooks.addFilter('wjs_builtin_escape_report', () => out);
`;

describe('reviewed-safe builtins, attacked inside a real isolate', () => {
    let report: any = null;
    let bootError: string | null = null;

    before(async () => {
        process.env.WJS_HOST_ONLY_MARKER = HOST_SECRET;   // a host env var the child must never see
        writeFixture(SLUG, PROBE_BODY);
        try {
            await loadIsolatedPlugin(SLUG, path.join(PLUGINS_ROOT, SLUG, 'index.js'));
            const { applyFilters } = require('../core/hooks');
            report = await applyFilters('wjs_builtin_escape_report', null);
        } catch (e: any) {
            bootError = String(e && e.message || e);
        }
    });

    after(async () => {
        delete process.env.WJS_HOST_ONLY_MARKER;
        try { await unloadIsolatedPlugin(SLUG); } catch { /* */ }
        try { fs.rmSync(path.join(PLUGINS_ROOT, SLUG), { recursive: true, force: true }); } catch { /* */ }
        try { fs.rmSync(TMP_DB, { force: true }); } catch { /* */ }
    });

    test('the probe plugin actually booted and reported', (t: any) => {
        if (bootError) {
            // macOS is the known case: isolated plugins do not start there and the cause is undetermined.
            // Skip EXPLICITLY — a returned test counts as a pass, and this file exists to prove containment.
            t.skip(`the isolated probe did not boot on ${process.platform}: ${bootError}`);
            return;
        }
        assert.ok(report && typeof report === 'object', 'the isolated plugin produced no report');
    });

    test('the host environment does not reach the child', (t: any) => {
        if (!report) { t.skip('probe did not boot'); return; }
        assert.strictEqual(report.hostSecretVisible, false,
            `a host-only environment variable was readable inside the isolate. env keys seen: ${JSON.stringify(report.envKeys)}`);
    });

    test('the child sees ONLY the granted environment, not what the platform injected', (t: any) => {
        if (!report) { t.skip('probe did not boot'); return; }
        // THE MEASURED DEFECT. Passing an explicit env to spawn does not settle this on Windows: libuv
        // merges "required" variables into every environment block it builds, and an isolated plugin was
        // receiving LOGONSERVER / SYSTEMDRIVE / USERDOMAIN / USERNAME / USERPROFILE — the host account,
        // its home path, the AD domain and the domain controller that authenticated it. No secret, but
        // reconnaissance, handed to untrusted code, while the host's own comment said the environment was
        // exactly the allow-list.
        //
        // Asserted against the REAL list rather than a copy: this reads SAFE_ENV_KEYS out of
        // plugin-isolate.ts, so growing the list in one place cannot silently disagree here.
        const source = require('fs').readFileSync(require.resolve('../core/plugin-isolate'), 'utf8');
        const m = source.match(/const SAFE_ENV_KEYS = \[([^\]]*)\]/);
        assert.ok(m, 'could not read SAFE_ENV_KEYS from plugin-isolate.ts — this assertion would otherwise pass vacuously');
        const allowed = new Set(m![1].split(',').map((s: string) => s.trim().replace(/^'|'$/g, '').toLowerCase()).filter(Boolean));
        assert.ok(allowed.size >= 10, `parsed only ${allowed.size} allow-list entries`);

        const ungranted = report.envKeys.filter((k: string) => !allowed.has(k.toLowerCase()));
        assert.deepStrictEqual(ungranted, [],
            `the isolate received environment variables the allow-list does not grant: ${ungranted.join(', ')}`);
    });

    test('tty cannot be used to open the IPC channel', (t: any) => {
        if (!report) { t.skip('probe did not boot'); return; }
        assert.strictEqual(report.ttyReadFd3.contained, true,
            `a plugin read the host IPC channel through tty: ${report.ttyReadFd3.why}`);
        assert.strictEqual(report.ttyWriteFd3.contained, true,
            `a plugin wrote to the host IPC channel through tty: ${report.ttyWriteFd3.why}`);

        // READ THIS BEFORE TREATING THE PASS AS A GUARANTEE. Measured, the containment here is
        // `uv_tty_init returned EBADF` — libuv refusing because fd 3 is not a terminal. That is the
        // PLATFORM declining, not a guard denying. `tty` sits in REVIEWED_SAFE_BUILTINS because a plugin
        // cannot obtain a usable descriptor (fs is intercepted, net is grant-gated), not because tty is
        // inert; the day something hands out an fd, this module becomes a way to use it. The reason is
        // asserted, so a change from "the platform refused" to "nothing refused" is visible here rather
        // than silently still green.
        for (const probe of [report.ttyReadFd3, report.ttyWriteFd3]) {
            assert.match(String(probe.why), /EBADF|ENOTTY|EPERM|EACCES|not permitted|SECURITY BLOCK/i,
                `tty was contained for an unrecognised reason — check whether anything is actually refusing: ${probe.why}`);
        }
    });

    test('console cannot be pointed at a raw descriptor', (t: any) => {
        if (!report) { t.skip('probe did not boot'); return; }
        assert.strictEqual(report.consoleToFd.contained, true,
            `a plugin wrote to fd 3 through console: ${report.consoleToFd.why}`);
    });

    test('no reviewed-safe module hands back a spawn/open/connect surface', (t: any) => {
        if (!report) { t.skip('probe did not boot'); return; }
        assert.deepStrictEqual(report.suspicious, [],
            'a module listed as reviewed-safe exposes a process/file/socket entry point:\n  ' + report.suspicious.join('\n  '));
    });
});
