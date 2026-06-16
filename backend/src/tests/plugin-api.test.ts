/**
 * Tests for the plugin capability bridge (src/core/plugin-api.ts).
 * The plugin gets admin on the relevant scopes, so these assert the bridge's OWN constraints
 * (secret-option blocklist, core-table scoping, path confinement) — not the permission gate.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Preload core modules from the (trusted) test context so later in-plugin-context lazy loads
// don't trip the fs sandbox during their first require.
require('../config/app');
require('../core/options');
require('../config/database');
require('../core/hooks');

const { createPluginApi } = require('../core/plugin-api');
const { runWithContext } = require('../core/plugin-context');

const SLUG = 'test-api-plugin';
const dir = path.join(path.resolve(__dirname, '../../plugins'), SLUG);

before(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        name: SLUG,
        permissions: [
            { scope: 'settings', access: 'admin' },
            { scope: 'database', access: 'admin' },
            { scope: 'filesystem', access: 'admin' }
        ]
    }));
});
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

test('bridge blocks reading secret-named options', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        await assert.rejects(() => api.options.get('mail_security_dkim_private_key'), /not readable/);
        await assert.rejects(() => api.options.set('jwt_secret', 'x'), /not writable/);
    });
});

test('bridge blocks SQL touching core tables', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        await assert.rejects(() => api.db.all('SELECT * FROM users'), /off-limits/);
        await assert.rejects(() => api.db.run("UPDATE user_meta SET meta_value='administrator'"), /off-limits/);
    });
});

test('bridge confines fs to the plugin dir + uploads', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        await assert.rejects(() => api.fs.read('../../package.json'), /outside/);
        await assert.rejects(() => api.fs.write('manifest.json', 'x'), /immutable/);
    });
});
