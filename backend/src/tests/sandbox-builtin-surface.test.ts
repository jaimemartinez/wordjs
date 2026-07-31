/**
 * EVERY NODE BUILTIN IS CLASSIFIED, OR THIS FAILS.
 *
 * The sandbox decides what a plugin may load with a denylist keyed by NAME. That is safe only for
 * modules someone has already thought about: anything Node adds later is, by construction, allowed.
 * This is not hypothetical — it is the single recurring root cause in this codebase's security history:
 *
 *   node:sqlite  (unflagged ~22.13)  DatabaseSync is C++-backed, so it opened arbitrary host files past
 *                                    the fs proxy, and loadExtension() mapped native addons = host RCE.
 *   node:wasi                        preopens map a host directory into a WASM instance whose native
 *                                    path_open/fd_read/fd_write never reach io-guard.
 *   node:diagnostics_channel         subscribing to the host's internal channels yields its outbound
 *                                    requests, Authorization headers included.
 *
 * Each was found by hand, after shipping. This test removes the hand: it enumerates the builtins of the
 * Node actually running and fails on any that no one has classified, so the next one is caught by a
 * version bump instead of an incident.
 *
 * It probes the REAL policy rather than re-declaring the lists — `process.getBuiltinModule` is patched
 * to route through the same `secureModuleFor` as require(), so asking it what comes back for an id is
 * asking the policy itself. A copy of the denylist here could drift from the one that enforces.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { installSecureRequire } = require('../core/secure-require');
const { runWithContext } = require('../core/plugin-context');

installSecureRequire();

const SLUG = 'sandbox-builtin-probe';

type Verdict = 'blocked' | 'guarded' | 'raw';

// The untouched handles, captured OUTSIDE plugin context — inside it, require() is proxied too, so a
// "raw" reference fetched there would be the proxy and every module would compare equal to itself.
const RAW = new Map<string, any>();
function rawHandle(id: string) {
    if (!RAW.has(id)) {
        try { RAW.set(id, require(id.startsWith('node:') ? id : 'node:' + id)); } catch { RAW.set(id, undefined); }
    }
    return RAW.get(id);
}

/** Ask the live policy what a plugin gets for `id`. */
function verdictFor(id: string): Verdict {
    const raw = rawHandle(id);
    return runWithContext(SLUG, () => {
        let mod: any;
        try { mod = (process as any).getBuiltinModule(id); } catch { return 'blocked'; }
        if (mod === undefined || mod === null) return 'blocked';

        // The blocked proxy answers EVERY property with a thrower function, so a name no real module
        // has must come back callable — and calling it must raise the sandbox error.
        const probe = (() => { try { return mod.__wordjs_probe__; } catch { return 'threw'; } })();
        if (probe === 'threw') return 'blocked';
        if (typeof probe === 'function') {
            try { probe(); } catch (e: any) {
                if (/not permitted|blocked|sandbox|Security/i.test(String(e && e.message))) return 'blocked';
            }
        }
        return mod === raw ? 'raw' : 'guarded';
    });
}

/**
 * Builtins a plugin may load untouched. Every entry is a deliberate decision: it exposes no host
 * filesystem, no sockets, no process control, no native loading and no cross-boundary observation.
 * Adding a name here is a security decision — say why.
 */
const ALLOWED_RAW = new Set([
    // pure computation / data
    'assert', 'assert/strict', 'buffer', 'constants', 'crypto', 'events', 'punycode', 'querystring',
    'string_decoder', 'url', 'util', 'util/types', 'zlib', 'sys',
    // path is string manipulation; it grants no access on its own (io-guard policies the access)
    'path', 'path/posix', 'path/win32',
    // streams are plumbing over handles the plugin already legitimately holds
    'stream', 'stream/consumers', 'stream/promises', 'stream/web',
    // scheduling
    'timers', 'timers/promises',
    // console writes to the captured plugin log
    'console',
    // host INFO disclosure only (hostname, cpus, homedir). Not a capability; the isolate's env is
    // already a scrubbed allowlist. Kept raw because plugins legitimately branch on platform/tmpdir.
    'os',
    // deprecated error-domain plumbing; confers no host access
    'domain',
    // process-local measurement
    'perf_hooks',
    // terminal/stdin plumbing. The isolate's stdio is piped to the host logger, not a tty.
    'readline', 'readline/promises', 'tty',
    // single-executable asset reads. WordJS does not ship as a SEA, so this is inert; it exposes no
    // path of its own (getAsset reads assets baked into the binary, not the filesystem).
    'sea',
    // process is a GLOBAL, not loadable surface — its methods are policed method-by-method in
    // secure-require and enumerated by sandbox-process-surface.test.ts.
    'process',
]);

describe('builtin module surface — nothing unclassified reaches a plugin', () => {
    const builtins = require('module').builtinModules
        .filter((m: string) => !m.startsWith('_'))
        .map((m: string) => m.replace(/^node:/, ''))
        .filter((m: string, i: number, a: string[]) => a.indexOf(m) === i)
        .sort();

    test('every builtin is blocked, guarded, or explicitly allowed', () => {
        const unclassified: string[] = [];
        for (const id of builtins) {
            const v = verdictFor(id);
            if (v === 'raw' && !ALLOWED_RAW.has(id)) unclassified.push(id);
        }
        assert.deepStrictEqual(unclassified, [],
            `Builtins reaching plugins UNGUARDED and unreviewed on ${process.version}: ${unclassified.join(', ')}\n` +
            'Node added loadable surface the sandbox has never been asked about. For each one:\n' +
            '  • can it touch the host filesystem, sockets, other processes, native code, or observe the\n' +
            '    host across the plugin boundary?  -> add to BLOCKED_PLUGIN_MODULES in core/secure-require.ts\n' +
            '    AND to esmBlocked in core/plugin-worker.js (the two must stay in step)\n' +
            '  • is it a network module?           -> add to NETWORK_MODULES so the Network grant gates it\n' +
            '  • otherwise                          -> add to ALLOWED_RAW above, with the reason.');
    });

    test('the escapes that motivated this stay blocked', () => {
        for (const id of ['sqlite', 'wasi', 'diagnostics_channel', 'worker_threads', 'vm', 'module',
                          'inspector', 'inspector/promises', 'cluster', 'v8', 'repl', 'trace_events']) {
            if (!builtins.includes(id)) continue;
            assert.strictEqual(verdictFor(id), 'blocked', `${id} must be blocked for plugins`);
        }
    });

    test('raw sockets stay behind the Network grant', () => {
        // No grant in this context, so every socket module must come back inert.
        for (const id of ['net', 'tls', 'dgram', 'http', 'https', 'http2', 'dns', 'dns/promises']) {
            if (!builtins.includes(id)) continue;
            assert.strictEqual(verdictFor(id), 'blocked', `${id} must require the Network grant`);
        }
    });

    test('fs and child_process are proxied, never raw', () => {
        for (const id of ['fs', 'fs/promises', 'child_process']) {
            assert.notStrictEqual(verdictFor(id), 'raw', `${id} must not reach a plugin unproxied`);
        }
    });

    test('core is unaffected — outside plugin context the real builtins are returned', () => {
        const cp = (process as any).getBuiltinModule('child_process');
        assert.strictEqual(typeof cp.execSync, 'function');
    });
});
