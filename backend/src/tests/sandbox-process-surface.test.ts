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

/**
 * THE SANDBOX'S OWN WATCHDOG MUST BE ABLE TO FIRE.
 *
 * secure-require replaces `process.exit` with a guard that throws whenever an effective plugin is on
 * the stack. That is right for plugin code. But plugin-worker.js calls process.exit in its OWN
 * lifecycle paths — guard-install failure, the ESM-guard abort, and the 512 MB memory watchdog — and
 * timer callbacks are deliberately re-entered in the plugin's context, so the watchdog's exit ran as
 * if the PLUGIN had called it and was refused:
 *
 *     RUNTIME SECURITY BLOCK: process.exit (host process control is not permitted in the plugin sandbox)
 *
 * Seen first on macOS, where a heavy plugin crossed the RSS budget. The child still died, because an
 * uncaught throw ends it — but with exit code 7 instead of 1, and with a message that reads as the
 * plugin attacking the sandbox when it was the sandbox's own limit trying to apply. Linux and Windows
 * never crossed the budget in these suites, so nothing had ever exercised it.
 *
 * The worker now binds its own exit before any guard is installed. These assertions keep it that way,
 * because the failure mode is a safety mechanism that looks present and cannot act.
 */
describe('the worker keeps its own way out', () => {
    const workerSrc = require('node:fs').readFileSync(
        require('node:path').resolve(__dirname, '../core/plugin-worker.js'), 'utf8');

    test('the exit reference is captured before any guard is installed', () => {
        const capture = workerSrc.indexOf('const hardExit = process.exit.bind(process);');
        const install = workerSrc.indexOf('installSecureRequire');
        assert.ok(capture !== -1, 'the worker no longer captures its own exit');
        assert.ok(install !== -1, 'installSecureRequire is gone from the worker');
        assert.ok(capture < install,
            'the exit is captured AFTER the guards install, so the guard has already replaced it');
    });

    test('no lifecycle path calls the guarded process.exit', () => {
        // Comments quote the guarded call by name, so they are stripped before matching — otherwise the
        // explanation of the bug would read as the bug.
        const code = workerSrc
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .split('\n').map((l: string) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
        const direct = [...code.matchAll(/(?<![\w$.])process\.exit\s*\(/g)];
        // One occurrence is legitimate: the capture itself, `process.exit.bind(process)` — which is not
        // a call, so it does not match the pattern above.
        assert.deepStrictEqual(direct.map((m) => m[0]), [],
            'a worker lifecycle path still calls process.exit directly; the guard will refuse it when a '
            + 'plugin context is on the stack, turning a clean exit into an uncaught throw');
        assert.ok(/hardExit\(1\)/.test(code), 'the worker no longer exits through its captured reference');
    });

    test('an uncaught plugin error is reported as itself, not as a sandbox violation', () => {
        // THE ONE THAT HID EVERYTHING ELSE. With no uncaughtException handler, Node's default path runs
        // process._fatalException, which calls process.exit() — and the guard throws on that, because a
        // plugin context is still on the stack. The operator then sees
        //
        //     RUNTIME SECURITY BLOCK: process.exit ... at process._fatalException
        //
        // and the actual exception is gone. Every uncaught error in any plugin on any platform was
        // reported as the plugin attacking the sandbox. One macOS fixture stayed unexplained through a
        // whole investigation because of it: the message named the wrong cause with total confidence.
        assert.match(workerSrc, /process\.on\('uncaughtException'/,
            'the worker must handle uncaught exceptions itself, or the guard replaces them with a lie');
        assert.match(workerSrc, /process\.on\('unhandledRejection'/,
            'an unhandled rejection reaches the same fatal path and needs the same treatment');
        assert.match(workerSrc, /function reportFatalAndExit[\s\S]{0,600}hardExit\(1\)/,
            'the handler must terminate through the captured exit, not the guarded one');
        assert.match(workerSrc, /reportFatalAndExit[\s\S]{0,600}process\.stderr\.write/,
            'the real stack must reach stderr, which is what the isolate forwards to the operator');
    });

    test('plugin code cannot forge control frames or sever the bridge', () => {
        // MEASURED before the fix: a plugin sending `{kind:'ready'}` made the host resolve the load
        // before init() had finished — it consulted a filter the plugin had not registered yet — which
        // also means the startup deadline was defeatable by any plugin at will. `{kind:'fatal'}` tore
        // the plugin down with a message the plugin wrote. process.send is host-process control.
        const sr = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../core/secure-require.ts'), 'utf8');
        for (const m of ['send', 'disconnect']) {
            assert.match(sr, new RegExp("PROC_BLOCKED = \\[[^\\]]*'" + m + "'"), `process.${m} is no longer refused to plugin code`);
        }
        // NOTE: process.channel itself is deliberately NOT trapped. Node reads that property on its own
        // internal IPC send path, and RPC callbacks run in plugin context, so a getter that threw under
        // plugin context broke every legitimate bridge call. Measured, then reverted. The teeth are on
        // send/disconnect above — forging a frame and severing the bridge are the actual capabilities;
        // reading the handle without them does nothing a plugin can act on.

        // The worker must have captured the real send BEFORE the guard installs, or its own control
        // frames would be refused too — and the capture is the only reason the guard can be absolute.
        const capture = workerSrc.indexOf('const rawSend = ');
        const install = workerSrc.indexOf('installSecureRequire');
        assert.ok(capture !== -1 && capture < install, 'the worker no longer captures process.send before the guards');
        assert.match(workerSrc, /rawSend && rawSend\(m\)/, 'the worker send() no longer uses the captured reference');
    });

    test('the memory watchdog is one of the paths that was fixed', () => {
        // Named explicitly: this is the path that actually fired, and the one whose failure is silent
        // until a plugin balloons memory in production.
        const watchdog = workerSrc.slice(workerSrc.indexOf('exceeded memory budget'));
        assert.ok(watchdog.length > 0, 'the memory watchdog is gone');
        assert.match(watchdog.slice(0, 400), /hardExit\(1\)/,
            'the memory watchdog still terminates through the guarded exit');
    });
});
