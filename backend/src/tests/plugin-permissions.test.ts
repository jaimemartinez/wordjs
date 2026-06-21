/**
 * Tests for the Android-style per-plugin permission grants (core/plugin-permissions.ts +
 * plugin-context.hasPermission). Model: a capability is allowed only if the manifest DECLARES it AND
 * an admin GRANTED it (default-deny). There is no trust tier — every plugin is gated the same way.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

require('../config/app');
require('../core/options');
require('../core/hooks');

const { hasPermission, runWithContext } = require('../core/plugin-context');
const perms = require('../core/plugin-permissions');

const SLUG = 'perm-test-plugin';
const dir = path.join(path.resolve(__dirname, '../../plugins'), SLUG);

before(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        name: SLUG,
        permissions: [{ scope: 'database', access: 'read' }, { scope: 'settings', access: 'write' }]
    }));
});
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

test('default-deny: a declared-but-ungranted permission is denied', async () => {
    await runWithContext(SLUG, async () => {
        perms._setGrantsInMemory(SLUG, []);
        assert.equal(hasPermission('database', 'read'), false);
        assert.equal(hasPermission('settings', 'write'), false);
    });
});

test('granting allows exactly that scope:access, nothing else', async () => {
    await runWithContext(SLUG, async () => {
        perms._setGrantsInMemory(SLUG, ['database:read']);
        assert.equal(hasPermission('database', 'read'), true);   // granted
        assert.equal(hasPermission('database', 'write'), false); // not declared (manifest is read-only)
        assert.equal(hasPermission('settings', 'write'), false); // declared but not granted
    });
});

test('admin grant implies read+write, but only for DECLARED scopes', async () => {
    await runWithContext(SLUG, async () => {
        perms._setGrantsInMemory(SLUG, ['database:admin', 'settings:admin']);
        assert.equal(hasPermission('database', 'read'), true);   // declared(read) + admin grant
        assert.equal(hasPermission('database', 'write'), false); // manifest only declares database:read
        assert.equal(hasPermission('settings', 'write'), true);  // declared(write) + admin grant
    });
});

test('cannot grant beyond the manifest (undeclared scope stays denied)', async () => {
    await runWithContext(SLUG, async () => {
        perms._setGrantsInMemory(SLUG, ['email:send']); // not in the manifest
        assert.equal(hasPermission('email', 'send'), false);
    });
});

test('network grant: off by default, on after granting', () => {
    perms._setGrantsInMemory(SLUG, []);
    assert.equal(perms.isNetworkGranted(SLUG), false);
    perms._setGrantsInMemory(SLUG, ['network']);
    assert.equal(perms.isNetworkGranted(SLUG), true);
});

// No trust tier: even a bundled plugin (mail-server) gets NOTHING without an explicit grant — there
// is no bypass. It only gains a capability once an admin grants it (and the manifest declares it).
test('no trust tier: even a bundled plugin needs grants (no bypass)', async () => {
    perms._setGrantsInMemory('mail-server', []); // no grants
    await runWithContext('mail-server', async () => {
        assert.equal(hasPermission('database', 'read'), false);
        assert.equal(hasPermission('email', 'admin'), false);
    });
    perms._setGrantsInMemory('mail-server', ['database:read']);
    await runWithContext('mail-server', async () => {
        assert.equal(hasPermission('database', 'read'), true);  // granted now
        assert.equal(hasPermission('email', 'admin'), false);   // still not granted
    });
});
