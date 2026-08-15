/**
 * Unit Tests for Runtime Security Interception
 * Run with: node src/tests/secure-require.test.js
 */

import type { Response } from 'express';

const path = require('path');
const fs = require('fs');

// Test utilities
let passed = 0;
let failed = 0;

function test(name: string, fn: any) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (error) {
        console.log(`  ❌ ${name}`);
        console.log(`     Error: ${error.message}`);
        failed++;
    }
}

function expect(actual: any) {
    return {
        toBe(expected: any) {
            if (actual !== expected) {
                throw new Error(`Expected ${expected}, got ${actual}`);
            }
        },
        toBeTrue() {
            if (actual !== true) {
                throw new Error(`Expected true, got ${actual}`);
            }
        },
        toBeFalse() {
            if (actual !== false) {
                throw new Error(`Expected false, got ${actual}`);
            }
        },
        toThrow() {
            // This is for functions that should throw
            throw new Error('toThrow must be used with a function');
        }
    };
}

function expectThrows(fn: any, msgContains = '') {
    try {
        fn();
        throw new Error('Expected function to throw but it did not');
    } catch (error) {
        if (msgContains && !error.message.includes(msgContains)) {
            throw new Error(`Expected error to contain "${msgContains}" but got: ${error.message}`, { cause: error });
        }
        return true;
    }
}

console.log('\n🛡️ Runtime Security Interception Tests\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// ============================================
// Import secure require module
// ============================================

const { createSecureFs, createSecureChildProcess, installSecureRequire } = require('../core/secure-require');
const { runWithContext } = require('../core/plugin-context');

// ============================================
console.log('\n📁 Secure FS Tests (Outside Plugin Context):');
// ============================================

test('Core code can use fs.existsSync without context', () => {
    const secureFs = createSecureFs();
    const result = secureFs.existsSync(__filename);
    expect(result).toBeTrue();
});

test('Core code can use fs.readFileSync without context', () => {
    const secureFs = createSecureFs();
    const content = secureFs.readFileSync(__filename, 'utf8');
    expect(content.includes('Runtime Security')).toBeTrue();
});

// ============================================
console.log('\n🔒 Secure FS Tests (Inside Plugin Context - No Permission):');
// ============================================

test('Plugin without permission blocked from fs.readFileSync', () => {
    const secureFs = createSecureFs();

    runWithContext('test-malicious-plugin', () => {
        expectThrows(() => {
            secureFs.readFileSync('/etc/passwd', 'utf8');
        }, 'RUNTIME SECURITY BLOCK');
    });
});

test('Plugin without permission blocked from fs.writeFileSync', () => {
    const secureFs = createSecureFs();

    runWithContext('test-malicious-plugin', () => {
        expectThrows(() => {
            secureFs.writeFileSync('/tmp/malicious.txt', 'pwned');
        }, 'RUNTIME SECURITY BLOCK');
    });
});

test('Plugin CAN access its own directory', () => {
    const secureFs = createSecureFs();
    const pluginsDir = path.resolve(__dirname, '../../plugins');
    const testPluginDir = path.join(pluginsDir, 'test-own-dir-plugin');

    // Create test dir if not exists
    if (!fs.existsSync(testPluginDir)) {
        fs.mkdirSync(testPluginDir, { recursive: true });
    }

    // Plugin should be able to write to its own directory
    runWithContext('test-own-dir-plugin', () => {
        const testFile = path.join(testPluginDir, 'test.txt');
        secureFs.writeFileSync(testFile, 'allowed');
        const content = secureFs.readFileSync(testFile, 'utf8');
        expect(content).toBe('allowed');
        secureFs.unlinkSync(testFile);
    });

    // Cleanup
    fs.rmdirSync(testPluginDir);
});

// ============================================
console.log('\n⚡ Secure child_process Tests:');
// ============================================

test('Core code can use child_process.execSync without context', () => {
    const secureCP = createSecureChildProcess();
    // Just verify it doesn't throw - we won't actually execute
    expect(typeof secureCP.execSync).toBe('function');
});

test('Plugin ALWAYS blocked from child_process.exec', () => {
    const secureCP = createSecureChildProcess();

    runWithContext('test-malicious-plugin', () => {
        expectThrows(() => {
            secureCP.execSync('echo pwned');
        }, 'RUNTIME SECURITY BLOCK');
    });
});

test('Plugin ALWAYS blocked from child_process.spawn', () => {
    const secureCP = createSecureChildProcess();

    runWithContext('test-malicious-plugin', () => {
        expectThrows(() => {
            secureCP.spawnSync('ls', ['-la']);
        }, 'RUNTIME SECURITY BLOCK');
    });
});

test('Plugin ALWAYS blocked from child_process.fork', () => {
    const secureCP = createSecureChildProcess();

    runWithContext('test-malicious-plugin', () => {
        expectThrows(() => {
            secureCP.fork('./malicious.js');
        }, 'RUNTIME SECURITY BLOCK');
    });
});

// ============================================
console.log('\n🎭 Obfuscation Resistance Tests:');
// ============================================

test('Obfuscated code still blocked (dynamic property access)', () => {
    const secureFs = createSecureFs();

    runWithContext('test-obfuscated-plugin', () => {
        expectThrows(() => {
            // Attacker tries: secureFs["read" + "FileSync"]
            const method = 'read' + 'File' + 'Sync';
            secureFs[method]('/etc/passwd', 'utf8');
        }, 'RUNTIME SECURITY BLOCK');
    });
});

test('Obfuscated code still blocked (apply/call)', () => {
    const secureFs = createSecureFs();

    runWithContext('test-obfuscated-plugin', () => {
        expectThrows(() => {
            // Attacker tries: fs.readFileSync.call(fs, '/etc/passwd')
            secureFs.readFileSync.call(secureFs, '/etc/passwd', 'utf8');
        }, 'RUNTIME SECURITY BLOCK');
    });
});

// ============================================
console.log('\n🕳️  No-Context Bypass Resistance Tests:');
// ============================================

const { getPluginFromStack, getEffectivePlugin } = require('../core/plugin-context');

test('getPluginFromStack detects a plugin source frame', () => {
    const stack = 'Error\n    at fn (C:\\app\\backend\\plugins\\evil-plugin\\index.js:5:1)\n    at h (C:\\app\\backend\\src\\core\\hooks.ts:90:1)';
    expect(getPluginFromStack(stack)).toBe('evil-plugin');
});

test('getPluginFromStack detects a theme source frame', () => {
    const stack = 'Error\n    at r (/app/backend/themes/cool-theme/render.js:3:1)';
    expect(getPluginFromStack(stack)).toBe('theme:cool-theme');
});

test('getPluginFromStack returns null for a core-only stack (no false positive on src/core/plugins.ts)', () => {
    const stack = 'Error\n    at z (/app/backend/src/core/plugins.ts:740:1)\n    at q (/app/backend/src/index.ts:10:1)';
    expect(getPluginFromStack(stack)).toBe(null);
});

test('Detached plugin code (NO runWithContext) is blocked from fs — bypass closed', () => {
    // Simulate the real bypass: a plugin route handler / timer runs with an EMPTY
    // AsyncLocalStorage context but its source file is on the call stack. The guard must
    // still apply. We create a real file under plugins/ that calls the secure fs directly,
    // and invoke it WITHOUT runWithContext.
    const secureFs = createSecureFs();
    const pluginDir = path.join(path.resolve(__dirname, '../../plugins'), 'test-bypass-plugin');
    const runnerPath = path.join(pluginDir, 'runner.js');
    if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(runnerPath, "module.exports = (sfs) => sfs.readFileSync('/etc/passwd', 'utf8');\n");

    try {
        const runner = require(runnerPath);
        // No runWithContext here — exactly the detached scenario that used to be trusted.
        expectThrows(() => runner(secureFs), 'RUNTIME SECURITY BLOCK');
    } finally {
        delete require.cache[require.resolve(runnerPath)];
        fs.unlinkSync(runnerPath);
        fs.rmdirSync(pluginDir);
    }
});

test('Core code with no plugin frame still has full fs access (no regression)', () => {
    const secureFs = createSecureFs();
    // getEffectivePlugin must be null here (test file is under src/tests, not plugins/)
    expect(getEffectivePlugin()).toBe(null);
    expect(secureFs.existsSync(__filename)).toBeTrue();
});

// ============================================
console.log('\n🧬 Native-binding escape resistance (process.binding):');
// ============================================

// installSecureRequire patches process.binding / Module._load globally; do it once here.
installSecureRequire();

test('Detached plugin code is blocked from process.binding (escape closed)', () => {
    const pluginDir = path.join(path.resolve(__dirname, '../../plugins'), 'test-binding-plugin');
    const runnerPath = path.join(pluginDir, 'runner.js');
    if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir, { recursive: true });
    // A plugin trying to grab raw fs syscalls via process.binding, run WITHOUT runWithContext.
    fs.writeFileSync(runnerPath, "module.exports = () => process.binding('fs');\n");
    try {
        const runner = require(runnerPath);
        expectThrows(() => runner(), 'RUNTIME SECURITY BLOCK');
    } finally {
        delete require.cache[require.resolve(runnerPath)];
        fs.unlinkSync(runnerPath);
        fs.rmdirSync(pluginDir);
    }
});

test('Core code (no plugin frame) can still use process.binding', () => {
    // No plugin on the stack → not blocked.
    let threw = false;
    try { (process as any).binding('fs'); } catch (e) { if (String(e.message).includes('RUNTIME SECURITY BLOCK')) threw = true; }
    expect(threw).toBeFalse();
});

// ============================================
console.log('\n🔴 Red-team Adversarial Escape Tests:');
// ============================================

// installSecureRequire() already called above. These run a real runner file under plugins/
// so getEffectivePlugin() (call-stack detection) classifies them as a plugin even without
// runWithContext — exactly the detached scenario the audit exploited.

function withRunner(slug: any, src: any, fn: any) {
    const pluginDir = path.join(path.resolve(__dirname, '../../plugins'), slug);
    const runnerPath = path.join(pluginDir, 'runner.js');
    if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(runnerPath, src);
    try {
        const runner = require(runnerPath);
        fn(runner);
    } finally {
        delete require.cache[require.resolve(runnerPath)];
        if (fs.existsSync(runnerPath)) fs.unlinkSync(runnerPath);
        if (fs.existsSync(pluginDir)) fs.rmdirSync(pluginDir);
    }
}

test("require('node:child_process') from plugin returns the SECURE blocking module", () => {
    withRunner('rt-node-cp', "module.exports = () => require('node:child_process').execSync('echo pwned');\n", (runner: any) => {
        expectThrows(() => runner(), 'RUNTIME SECURITY BLOCK');
    });
});

test("require('node:fs') in plugin returns the secure proxy (write outside dir throws)", () => {
    withRunner('rt-node-fs', "module.exports = () => require('node:fs').writeFileSync('/tmp/pwn.txt','x');\n", (runner: any) => {
        expectThrows(() => runner(), 'RUNTIME SECURITY BLOCK');
    });
});

test("Detached plugin with Error.stackTraceLimit=0 is STILL blocked from fs (stack hardening)", () => {
    const secureFs = createSecureFs();
    withRunner('rt-stacklimit', "module.exports = (sfs) => { Error.stackTraceLimit = 0; return sfs.readFileSync('/etc/passwd','utf8'); };\n", (runner: any) => {
        const saved = Error.stackTraceLimit;
        try {
            expectThrows(() => runner(secureFs), 'RUNTIME SECURITY BLOCK');
        } finally {
            Error.stackTraceLimit = saved;
        }
    });
});

test('fs deny-by-default: secureFs.cpSync throws in plugin context', () => {
    const secureFs = createSecureFs();
    runWithContext('rt-deny-plugin', () => {
        expectThrows(() => {
            secureFs.cpSync('/tmp/a', '/tmp/b');
        }, 'RUNTIME SECURITY BLOCK');
    });
});

test('fs deny-by-default: secureFs.openAsBlob throws in plugin context', () => {
    const secureFs = createSecureFs();
    runWithContext('rt-deny-plugin', () => {
        expectThrows(() => {
            secureFs.openAsBlob(__filename);
        }, 'RUNTIME SECURITY BLOCK');
    });
});

test("require('worker_threads') is blocked (inert) for plugins", () => {
    withRunner('rt-worker', "module.exports = () => new (require('worker_threads').Worker)('x');\n", (runner: any) => {
        expectThrows(() => runner(), 'RUNTIME SECURITY BLOCK');
    });
});

test("require('vm') is blocked (inert) for plugins", () => {
    withRunner('rt-vm', "module.exports = () => require('vm').runInThisContext('1+1');\n", (runner: any) => {
        expectThrows(() => runner(), 'RUNTIME SECURITY BLOCK');
    });
});

// ============================================
console.log('\n⚓ ALS-anchoring (route handlers run in plugin context):');
// ============================================

test('Plugin-registered route handler is ALS-anchored even when invoked detached + stack blinded', () => {
    const pc = require('../core/plugin-context');
    const { anchorPluginRoutes } = require('../core/appRegistry');

    // Minimal express-like app that just stores the registered handler.
    let stored: any = null;
    const app: any = { get(_path: any, h: any) { stored = h; return app; } };
    anchorPluginRoutes(app);

    // Register the handler AS the plugin (registration happens inside its context).
    pc.runWithContext('anchored-evil', () => {
        app.get('/x', (_req: any, res: Response) => { (res as any).seen = pc.getCurrentPlugin(); });
    });

    // Invoke later, fully DETACHED (no runWithContext) and with the stack scan blinded.
    const savedLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    const res: any = {};
    try { stored({}, res); } finally { Error.stackTraceLimit = savedLimit; }

    // ALS context is authoritative — the handler ran as its plugin without relying on the stack.
    expect(res.seen).toBe('anchored-evil');
});

test('Slug spoofing: an eval frame faking a plugins/ sourceURL is NOT attributed that slug', () => {
    const pc = require('../core/plugin-context');
    const fakeFile = path.resolve(__dirname, '../../plugins/conference-manager/spoof.js'); // does NOT exist
    let detected: any = 'unset';
    // eval'd code whose CallSite getFileName() is the fake plugins/ path via //# sourceURL.
    const code = "detected = require('../core/plugin-context').getPluginFromStack();\n//# sourceURL=" + fakeFile;
    (function () { eval(code); })();
    // realpath of the non-existent fake file fails → not attributed; must not borrow a real slug.
    expect(detected !== 'conference-manager').toBeTrue();
});

// ============================================
console.log('\n🧩 Core-module policy + fs.promises + Router anchoring:');
// ============================================

(() => {
    // Pre-load (from core context) so they're cached before the plugin runner requires them —
    // in production these load at startup before any plugin; the lazy first-load fs.existsSync
    // would otherwise run with the plugin on the stack and be (correctly) blocked.
    require('../config/app');
    require('../core/options');
    require('../config/database');

    const pluginDir = path.join(path.resolve(__dirname, '../../plugins'), 'test-policy-plugin');
    const runnerPath = path.join(pluginDir, 'runner.js');
    if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir, { recursive: true });
    // Manifest grants database:read so the dbAsync permission gate passes — isolating MY table-scoping
    // guard (a permissioned plugin still must not touch users/options).
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({ name: 'test-policy-plugin', permissions: [{ scope: 'database', access: 'read' }] }));
    fs.writeFileSync(runnerPath,
        "module.exports = {\n" +
        "  reqImportExport: () => require('../../src/core/import-export'),\n" +
        "  reqPluginContext: () => require('../../src/core/plugin-context'),\n" +
        "  reqConfig: () => require('../../src/config/app'),\n" +
        "  reqOptions: () => require('../../src/core/options'),\n" +
        "  promisesEscape: () => require('fs').promises.readFile('/etc/passwd','utf8'),\n" +
        "  dbUsers: () => require('../../src/config/database').dbAsync.all('SELECT * FROM users'),\n" +
        "  dbOwn: () => require('../../src/config/database').dbAsync.all('SELECT 1 FROM sqlite_master WHERE 0'),\n" +
        "};\n");
    let runner: any;
    try { runner = require(runnerPath); } catch (e) { /* ignore */ }

    test('Core policy: plugin requiring import-export is blocked (#4)', () => {
        expectThrows(() => runner.reqImportExport(), 'not accessible');
    });
    test('Core policy: plugin requiring plugin-context is blocked (#7)', () => {
        expectThrows(() => runner.reqPluginContext(), 'not accessible');
    });
    test('Core policy: plugin requiring config/app gets secrets redacted (#3)', () => {
        const cfg = runner.reqConfig();
        expect(cfg.jwtSecret === undefined).toBeTrue();
        expect((cfg.jwt || {}).secret === undefined).toBeTrue();
    });
    test('Core policy: legitimate plugin-API module (options) still loads', () => {
        const opt = runner.reqOptions();
        expect(typeof opt.getOption).toBe('function');
    });
    test('dbAsync scoping: plugin SQL on the users table is blocked (#dbscope)', () => {
        // The in-process config/database path now delegates to the same lexer-based guard as the RPC
        // bridge (plugin-api.assertSqlAllowed), so a query touching the core `users` table is denied with
        // the unified "core table … off-limits / not owned by this plugin" message (previously the weaker
        // regex path said "dbAsync(users)"). Assert the block, not the exact legacy wording.
        expectThrows(() => runner.dbUsers(), 'Plugin DB access denied');
    });
    test('fs.promises is proxied for plugins — escape outside dir rejects (#2)', async () => {
        let blocked = false;
        try { await runner.promisesEscape(); } catch (e) { blocked = /SECURITY BLOCK/i.test(e.message); }
        expect(blocked).toBeTrue();
    });

    if (fs.existsSync(runnerPath)) { delete require.cache[require.resolve(runnerPath)]; }
    try { fs.rmSync(pluginDir, { recursive: true, force: true }); } catch { /* */ }
})();

test('express.Router() handler is ALS-anchored (#1)', () => {
    const express = require('express');
    const pc = require('../core/plugin-context');
    const appReg = require('../core/appRegistry');
    appReg.setApp(express()); // patches the shared Router prototype
    const router = express.Router();
    pc.runWithContext('router-evil', () => {
        router.get('/x', (_req: any, res: Response) => { (res as any).seen = pc.getCurrentPlugin(); });
    });
    const layer = router.stack.find((l: any) => l.route);
    const handler = layer.route.stack[0].handle;
    const savedLimit = Error.stackTraceLimit; Error.stackTraceLimit = 0;
    const res: any = {};
    try { handler({}, res, () => {}); } finally { Error.stackTraceLimit = savedLimit; }
    expect(res.seen).toBe('router-evil');
});

test('Plugin is denied symlink creation even in its own dir (#9)', () => {
    const secureFs = createSecureFs();
    runWithContext('test-malicious-plugin', () => {
        expectThrows(() => secureFs.symlinkSync('/etc', '/tmp/evil-link'), 'not permitted');
    });
});

test('Plugin is blocked from writing a manifest.json (#6)', () => {
    const { isPathSafe } = require('../core/io-guard');
    const pluginsDir = path.resolve(__dirname, '../../plugins');
    runWithContext('test-malicious-plugin', () => {
        const ok = isPathSafe(path.join(pluginsDir, 'test-malicious-plugin', 'manifest.json'), true);
        expect(ok).toBeFalse();
    });
});

test('EventEmitter listener registered by a plugin is ALS-anchored when fired detached (#crit-RCE)', () => {
    const pc = require('../core/plugin-context');
    const EventEmitter = require('events');
    const em = new EventEmitter();
    let seen: any = 'unset';
    // Plugin registers the listener inside its context (as during init / a route handler).
    pc.runWithContext('ee-evil', () => {
        em.on('boom', () => { seen = pc.getCurrentPlugin(); });
    });
    // Core fires it later with empty ALS and a blinded stack — it must STILL run as the plugin.
    const savedLimit = Error.stackTraceLimit; Error.stackTraceLimit = 0;
    try { em.emit('boom'); } finally { Error.stackTraceLimit = savedLimit; }
    expect(seen).toBe('ee-evil');
});

// ============================================
// Summary
// ============================================
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
    process.exit(1);
} else {
    console.log('✨ All tests passed! Runtime security is working.\n');
    process.exit(0);
}
