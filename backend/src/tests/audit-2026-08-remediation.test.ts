/**
 * WordJS — regression tests for the 2026-08-01 Proxmox/LXC sandbox audit remediations.
 * (SANDBOX_AUDIT_PROXMOX_LXC_2026-08-01.md)
 *
 *   F-02  updateOption() must REDACT secret-named option VALUES in the reactive `updated_option` hook,
 *         so a zero-permission isolated plugin subscribed to that hook cannot observe a secret it is
 *         forbidden to read via options.get. The stored value stays intact — only the hook payload is
 *         redacted, and a normal (non-secret) option passes through unchanged.
 *   F-06  The egress guard must fail CLOSED: a distinct deny-all state (policy unavailable) blocks EVERY
 *         host and OVERRIDES the allowlist, kept separate from "no policy configured" (allow-all-public).
 *
 * IMPORTANT: config.dbPath is repointed to a temp file BEFORE requiring ../config/database (see
 * wxr-import.test.ts / api.test.ts).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-audit0826-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

describe('audit F-02 — updated_option redacts secret VALUES (not names)', () => {
    let options: any;
    let hooks: any;

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        options = require('../core/options');
        hooks = require('../core/hooks');
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* */ }
        for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* */ } }
    });

    it('redacts secret-named values in the hook but passes normal options through, and stores the real value', async () => {
        const seen: Record<string, any> = {};
        const listener = (name: string, value: any) => { seen[name] = value; };
        hooks.addAction('updated_option', listener);
        try {
            await options.updateOption('jwt_secret', 'super-secret-value');
            await options.updateOption('smtp_password', 'hunter2');
            await options.updateOption('dkim_private_key', '-----BEGIN KEY-----');
            await options.updateOption('site_title', 'My Public Site');
            await options.updateOption('blogname', 'Public Name');
        } finally {
            hooks.removeAction('updated_option', listener);
        }

        // Secret-named options: the hook payload is redacted.
        assert.strictEqual(seen['jwt_secret'], '[redacted]', 'jwt_secret value leaked to the hook');
        assert.strictEqual(seen['smtp_password'], '[redacted]', 'smtp_password value leaked to the hook');
        assert.strictEqual(seen['dkim_private_key'], '[redacted]', 'dkim key value leaked to the hook');
        // Normal options: unchanged.
        assert.strictEqual(seen['site_title'], 'My Public Site', 'normal option must pass through unredacted');
        assert.strictEqual(seen['blogname'], 'Public Name', 'normal option must pass through unredacted');
        // Redaction only affects the hook payload — the stored value is the real one.
        assert.strictEqual(await options.getOption('jwt_secret'), 'super-secret-value', 'stored secret must be intact');
    });
});

describe('audit F-06 — egress guard fails CLOSED when policy unavailable', () => {
    // egress-guard is a standalone module with a one-way deny-all latch; run in this file's own process
    // (node --test isolates per file) and order the cases so the latch is set LAST.
    const eg = require('../core/egress-guard');

    it('allows all public hosts when NO allowlist is configured (unchanged behavior)', () => {
        assert.strictEqual(eg.isHostAllowed('example.com'), true);
    });

    it('default-denies unlisted hosts once an allowlist IS configured', () => {
        eg.setAllowedHosts(['allowed.example']);
        assert.strictEqual(eg.isHostAllowed('allowed.example'), true);
        assert.strictEqual(eg.isHostAllowed('evil.example'), false);
    });

    it('deny-all (policy unavailable) blocks EVERY host and overrides the allowlist', () => {
        eg.setAllowedHosts(['allowed.example']); // even with a configured allowlist...
        eg.setDenyAllEgress();                   // ...the fail-closed latch wins.
        assert.strictEqual(eg.isHostAllowed('allowed.example'), false);
        assert.strictEqual(eg.isHostAllowed('example.com'), false);
    });
});
