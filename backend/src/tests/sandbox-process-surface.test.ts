/**
 * THE `process` OBJECT AS A SANDBOX SURFACE.
 *
 * `process` is a GLOBAL. It never passes through `require`, `Module._load`, the ESM loader or
 * `process.getBuiltinModule`, so the module denylist cannot see it: every guard on it is an explicit,
 * hand-written patch in secure-require. That makes it the one surface where "we forgot one" is the
 * default outcome rather than the exception — and it is exactly how `getBuiltinModule` (Node 22.3) and
 * `execve` (Node 24) arrived: new host-reaching methods on an object nothing enumerates.
 *
 * Two tests, doing different jobs:
 *
 *  1. KNOWN SURFACE — every method a plugin must not reach throws under plugin context.
 *  2. CANARY — the set of callables on `process` is compared against a reviewed inventory. A Node
 *     upgrade that adds a method fails this test until someone classifies it. This is the only test
 *     here that can catch the NEXT `execve`, so it is the point of the file.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { installSecureRequire } = require('../core/secure-require');
const { runWithContext } = require('../core/plugin-context');

installSecureRequire();

const SLUG = 'sandbox-surface-probe';
const underPlugin = (fn: () => any) => runWithContext(SLUG, fn);

/** Calling `process[name]` under plugin context must throw. Arguments are deliberately harmless. */
function assertBlocked(name: string, args: any[] = []) {
    const fn = (process as any)[name];
    if (typeof fn !== 'function') return { skipped: true };   // not in this Node — nothing to guard
    let threw = false;
    underPlugin(() => {
        try { fn.apply(process, args); } catch (e: any) { threw = /not permitted|blocked|sandbox|Security/i.test(String(e && e.message)); }
    });
    assert.ok(threw, `process.${name} is REACHABLE from a plugin — it must be blocked`);
    return { skipped: false };
}

describe('process surface — host control is blocked for plugins', () => {
    test('process image replacement (execve) is blocked', () => {
        // Node >=24, POSIX only. It REPLACES the running process with another executable. In-process
        // plugins and themes run inside the host, so reaching it is a straight host takeover; in the
        // isolate it still discards every JS-level guard in one call while keeping the inherited IPC
        // channel to the host. Nothing a plugin does legitimately needs it.
        assertBlocked('execve', ['/bin/true', ['/bin/true']]);
    });

    test('inspector control via the private debug hooks is blocked', () => {
        // _debugProcess(pid) signals a process to START ITS INSPECTOR. The `inspector` module is on the
        // require denylist, but this is a separate native path that never touches it — an in-process
        // plugin can open a debugger on the host and then drive it.
        assertBlocked('_debugProcess', [process.pid]);
        assertBlocked('_debugEnd', [process.pid]);
    });

    test('loadEnvFile is blocked (unproxied read + env injection)', () => {
        // Reads a file from disk in C++ and merges it into process.env. Both halves are escapes: the
        // read never reaches io-guard, and the write mutates the host environment other code trusts.
        assertBlocked('loadEnvFile', ['/nonexistent-wordjs-probe.env']);
    });

    test('the previously-closed surface stays closed', () => {
        for (const m of ['binding', '_linkedBinding', 'dlopen', 'kill', '_kill', 'abort', 'exit',
                         'chdir', 'umask', 'setuid', 'setgid', 'seteuid', 'setegid', 'setgroups', 'initgroups']) {
            assertBlocked(m, m === 'binding' || m === '_linkedBinding' ? ['fs'] : []);
        }
    });

    test('getBuiltinModule still routes through the module policy', () => {
        underPlugin(() => {
            const cp = (process as any).getBuiltinModule('child_process');
            assert.throws(() => cp.execSync('echo wjs'), /not permitted|blocked|sandbox|Security/i,
                'getBuiltinModule handed back an unguarded child_process');
        });
    });

    test('core itself is unaffected — the guards key off plugin context, not the method', () => {
        // Same call, no plugin context: must NOT throw the security error. (chdir to cwd is a no-op.)
        assert.doesNotThrow(() => process.chdir(process.cwd()));
    });
});

/**
 * The canary. Everything callable on `process` is either DENIED to plugins, or consciously ALLOWED.
 * A method in neither list is a surface nobody has looked at.
 */
describe('process surface — inventory canary', () => {
    // Reaches the host: process image, native bindings, privileges, lifecycle, debugger, host fs/env.
    const DENIED = new Set([
        'abort', 'binding', 'chdir', 'dlopen', 'execve', 'exit', 'initgroups', 'kill', 'loadEnvFile',
        'setegid', 'seteuid', 'setgid', 'setgroups', 'setuid', 'umask',
        '_debugEnd', '_debugProcess', '_kill', '_linkedBinding',
    ]);
    // Reviewed and judged safe: pure reads, timers, stream/emitter plumbing, or already policed
    // elsewhere (getBuiltinModule routes through the module policy; report.* is patched separately).
    const ALLOWED = new Set([
        'assert', 'availableMemory', 'constrainedMemory', 'cpuUsage', 'cwd', 'emitWarning',
        'getActiveResourcesInfo', 'getBuiltinModule', 'getegid', 'geteuid', 'getgid', 'getgroups',
        'getuid', 'hasUncaughtExceptionCaptureCallback', 'hrtime', 'memoryUsage', 'nextTick',
        'openStdin', 'ref', 'resourceUsage', 'setSourceMapsEnabled', 'setUncaughtExceptionCaptureCallback',
        'uptime', 'unref', 'reallyExit', 'threadCpuUsage', 'constructor',
        '_fatalException', '_getActiveHandles', '_getActiveRequests',
        '_rawDebug', '_startProfilerIdleNotifier', '_stopProfilerIdleNotifier', '_tickCallback',
        // EventEmitter surface inherited by process
        'addListener', 'emit', 'eventNames', 'getMaxListeners', 'listenerCount', 'listeners', 'off',
        'on', 'once', 'prependListener', 'prependOnceListener', 'rawListeners', 'removeAllListeners',
        'removeListener', 'setMaxListeners',
    ]);

    test('no callable on process is unclassified', () => {
        const callables = new Set<string>();
        for (let o = process; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
            for (const k of Object.getOwnPropertyNames(o)) {
                let v: any;
                try { v = (process as any)[k]; } catch { continue; }   // throwing getter — not callable surface
                if (typeof v === 'function') callables.add(k);
            }
        }
        const unknown = [...callables].filter(k => !DENIED.has(k) && !ALLOWED.has(k)).sort();
        assert.deepStrictEqual(unknown, [],
            `Unclassified callables on process (${process.version}): ${unknown.join(', ')}\n` +
            'A Node upgrade added host-reaching surface, or a method was renamed. Classify each one:\n' +
            '  • can a plugin use it to touch the host (process image, natives, privileges, fs, env,\n' +
            '    debugger, other processes)?  -> add to PROC_BLOCKED in core/secure-require.ts AND to DENIED here\n' +
            '  • otherwise -> add to ALLOWED here, with the reason.');
    });

    test('every DENIED name is actually patched', () => {
        for (const name of DENIED) assertBlocked(name, name === 'binding' || name === '_linkedBinding' ? ['fs'] : []);
    });
});
