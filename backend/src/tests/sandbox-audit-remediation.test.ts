/**
 * Regression tests for the plugin-sandbox red-team remediation (2026-07-10).
 * Each block maps to a confirmed finding; every fix is asserted both ways where practical
 * (the attack is blocked AND a legitimate equivalent still works).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

require('../core/io-guard'); // installs the global fs monkey-patches (guarded by effective-plugin context)
const { installSecureRequire } = require('../core/secure-require');
installSecureRequire(); // so require('fs').promises returns the metered secure proxy under plugin context
const { runWithContext } = require('../core/plugin-context');

// ─────────────────────────────────────────────────────────────────────────────
// #03 (CRITICAL) egress-guard: IPv6 must be classified by NUMERIC bytes, not text shape.
// ─────────────────────────────────────────────────────────────────────────────
const { isBlockedIp } = require('../core/egress-guard');

test('#03 IPv6 loopback/metadata are blocked in EVERY spelling (not just ::1 / ::ffff:)', () => {
    const mustBlock = [
        '::1', '::',                                   // canonical loopback / unspecified
        '0:0:0:0:0:0:0:1',                             // full-form ::1  (the bypass)
        '0::1', '0:0:0:0:0:0:0:0',                     // alt spellings
        '::ffff:169.254.169.254',                      // IPv4-mapped metadata (dotted — already worked)
        '0:0:0:0:0:ffff:a9fe:a9fe',                    // IPv4-mapped metadata, FULL form (the bypass)
        '0:0:0:0:0:ffff:7f00:1',                       // IPv4-mapped 127.0.0.1, full form
        'fe80::1',                                     // link-local
        'fec0::1',                                     // deprecated site-local (review nit)
        'fc00::1', 'fd12:3456::1',                     // unique-local (ULA)
        'ff02::1',                                     // multicast
        '64:ff9b::a9fe:a9fe',                          // NAT64 → 169.254.169.254 metadata (review should-fix)
        '64:ff9b::7f00:1',                             // NAT64 → 127.0.0.1
    ];
    for (const ip of mustBlock) {
        assert.strictEqual(isBlockedIp(ip), true, `expected ${ip} to be BLOCKED`);
    }
});

test('#03 genuine public IPv6/IPv4 are still allowed (no over-block)', () => {
    const mustAllow = ['2001:4860:4860::8888', '2606:4700:4700::1111', '8.8.8.8', '1.1.1.1', '64:ff9b::808:808'];
    for (const ip of mustAllow) {
        assert.strictEqual(isBlockedIp(ip), false, `expected ${ip} to be ALLOWED`);
    }
    // v4 metadata / private still blocked.
    for (const ip of ['169.254.169.254', '10.0.0.1', '127.0.0.1']) {
        assert.strictEqual(isBlockedIp(ip), true, `expected ${ip} to be BLOCKED`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// #02 (CRITICAL) options bridge: plugin_grants / cron are off-limits to plugins.
// ─────────────────────────────────────────────────────────────────────────────
const { isProtectedOption } = require('../core/plugin-api');

test('#02 security-critical option keys are protected; benign ones are not', () => {
    for (const k of ['plugin_grants', 'cron', 'plugin_strikes', 'plugin_health', 'siteurl', 'active_plugins']) {
        assert.strictEqual(isProtectedOption(k), true, `expected option '${k}' to be PROTECTED`);
    }
    for (const k of ['my_plugin_setting', 'greeting', 'items_per_page']) {
        assert.strictEqual(isProtectedOption(k), false, `expected option '${k}' to be writable`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// #01 / #04 / #06 / #08 path-traversal guards on slug-derived fs ops.
// ─────────────────────────────────────────────────────────────────────────────
const pluginRoutes: any = require('../routes/plugins');
const { PLUGINS_DIR } = require('../core/plugins');

test('#01/#06 isValidSlug rejects traversal/dot/separator tokens, accepts real slugs', () => {
    for (const bad of ['..', '.', '', '../../data', 'a/b', 'a\\b', '..zip', 'foo.', '.hidden', 'a'.repeat(65)]) {
        assert.strictEqual(pluginRoutes.isValidSlug(bad), false, `expected '${bad}' INVALID`);
    }
    for (const good of ['my-plugin', 'mail_server', 'a', 'Card-Gallery', 'x123']) {
        assert.strictEqual(pluginRoutes.isValidSlug(good), true, `expected '${good}' VALID`);
    }
});

test('#04/#08 resolveSafePluginDir throws on traversal and never returns PLUGINS_DIR itself', () => {
    for (const bad of ['..', '.', '../../data', '../../../etc/passwd', 'a/b']) {
        assert.throws(() => pluginRoutes.resolveSafePluginDir(bad), /Invalid plugin slug/, `expected throw for '${bad}'`);
    }
    const good = pluginRoutes.resolveSafePluginDir('good-plugin');
    const base = path.resolve(PLUGINS_DIR);
    assert.ok(good.startsWith(base + path.sep), 'resolved dir must be inside PLUGINS_DIR');
    assert.notStrictEqual(good, base, 'resolved dir must never be PLUGINS_DIR itself (rmSync-wipe guard)');
});

// ─────────────────────────────────────────────────────────────────────────────
// #07 (HIGH) io-guard per-plugin disk write quota (raw fs bypasses the bridge quota).
// ─────────────────────────────────────────────────────────────────────────────
const QSLUG = 'audit-quota-test-plugin';
const qdir = path.join(PLUGINS_DIR, QSLUG);

test('#07 a single oversized raw write is blocked (EDQUOT); a normal write still works', () => {
    fs.mkdirSync(qdir, { recursive: true });
    try {
        // Normal small write into own dir → allowed.
        runWithContext(QSLUG, () => {
            fs.writeFileSync(path.join(qdir, 'ok.bin'), Buffer.alloc(1024));
        });
        assert.ok(fs.existsSync(path.join(qdir, 'ok.bin')), 'normal write should succeed');

        // A single write past the 64MB single-write cap → EDQUOT, and nothing is written.
        let err: any = null;
        runWithContext(QSLUG, () => {
            try { fs.writeFileSync(path.join(qdir, 'huge.bin'), Buffer.alloc(65 * 1024 * 1024)); }
            catch (e) { err = e; }
        });
        assert.ok(err && err.code === 'EDQUOT', `expected EDQUOT, got ${err && err.code}`);
        assert.ok(!fs.existsSync(path.join(qdir, 'huge.bin')), 'the oversized file must not exist');
    } finally {
        fs.rmSync(qdir, { recursive: true, force: true });
    }
});

const QSLUG2 = 'audit-quota-promises-plugin';
const qdir2 = path.join(PLUGINS_DIR, QSLUG2);

test('#07 fs.promises writes are ALSO metered (blocker: the promises path bypassed the quota)', async () => {
    fs.mkdirSync(qdir2, { recursive: true });
    try {
        let err: any = null;
        await runWithContext(QSLUG2, async () => {
            const fsp = require('fs').promises; // secure proxy under plugin context → metered
            try { await fsp.writeFile(path.join(qdir2, 'huge.bin'), Buffer.alloc(65 * 1024 * 1024)); }
            catch (e) { err = e; }
        });
        assert.ok(err && err.code === 'EDQUOT', `expected EDQUOT via fs.promises, got ${err && (err.code || err.message)}`);
        assert.ok(!fs.existsSync(path.join(qdir2, 'huge.bin')), 'the oversized promises write must not exist');

        // A normal small fs.promises write still works (no regression).
        await runWithContext(QSLUG2, async () => {
            await require('fs').promises.writeFile(path.join(qdir2, 'ok.bin'), Buffer.alloc(1024));
        });
        assert.ok(fs.existsSync(path.join(qdir2, 'ok.bin')));
    } finally {
        fs.rmSync(qdir2, { recursive: true, force: true });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// #11 (MEDIUM) shortcode registration is owner-aware (no cross-owner override).
// ─────────────────────────────────────────────────────────────────────────────
const { addShortcode, removeShortcode, doShortcode } = require('../core/shortcodes');

test('#11 a plugin cannot override a core (or another plugin\'s) shortcode', () => {
    const TAG = 'wjs_audit_sc';
    // Core registers it (no plugin context).
    addShortcode(TAG, () => 'CORE');
    assert.strictEqual(doShortcode(`[${TAG}]`), 'CORE');
    // A plugin tries to hijack the same tag → refused, output unchanged.
    runWithContext('evil-plugin', () => addShortcode(TAG, () => 'HIJACKED'));
    assert.strictEqual(doShortcode(`[${TAG}]`), 'CORE', 'plugin override must be refused');

    // A plugin also cannot REMOVE a core/other-owner tag (teardown-bypass fix): removeShortcode must be
    // owner-aware even when called in the plugin's context (as the isolate cleanup now does).
    runWithContext('evil-plugin', () => removeShortcode(TAG));
    assert.strictEqual(doShortcode(`[${TAG}]`), 'CORE', 'plugin must not be able to unregister a core shortcode');

    // But a plugin CAN register (and remove) its OWN tag (no regression).
    const OWN = 'wjs_audit_own';
    runWithContext('good-plugin', () => addShortcode(OWN, () => 'MINE'));
    assert.strictEqual(doShortcode(`[${OWN}]`), 'MINE');
    runWithContext('good-plugin', () => removeShortcode(OWN));
    assert.notStrictEqual(doShortcode(`[${OWN}]`), 'MINE', 'plugin may remove its OWN shortcode');
});

// ─────────────────────────────────────────────────────────────────────────────
// #10 (MEDIUM) AST scanner flags aliased / indirect eval + Function-constructor.
// ─────────────────────────────────────────────────────────────────────────────
const { validatePluginPermissions } = require('../core/plugins');
const SSLUG = 'audit-scanner-test-plugin';
const sdir = path.join(PLUGINS_DIR, SSLUG);

function scanThrows(code: string): boolean {
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, 'manifest.json'), JSON.stringify({ name: SSLUG, isolated: true, permissions: [] }));
    fs.writeFileSync(path.join(sdir, 'index.js'), code);
    try { validatePluginPermissions(SSLUG, sdir, { name: SSLUG, permissions: [] }); return false; }
    catch { return true; }
    finally { fs.rmSync(sdir, { recursive: true, force: true }); }
}

test('#10 aliased and indirect eval / Function-constructor are now flagged', () => {
    assert.ok(scanThrows('const e = eval; e("1+1");'), 'const e = eval must be flagged');
    assert.ok(scanThrows('const F = Function; F("return 1")();'), 'const F = Function must be flagged');
    assert.ok(scanThrows('(0, eval)("1+1");'), 'indirect (0,eval) must be flagged');
    assert.ok(scanThrows('const F = [].constructor.constructor; F("return 1")();'), '.constructor.constructor alias must be flagged');
});

test('#10 benign code (incl. single this.constructor) still passes the scan (no false positive)', () => {
    assert.ok(!scanThrows('module.exports.init = () => { const x = 1 + 1; return x; };'), 'plain code must pass');
    assert.ok(!scanThrows('class A { clone() { return new this.constructor(); } } module.exports = A;'), 'single .constructor must not be flagged');
});
