/**
 * WHAT A PLUGIN GETS TO PUT IN FRONT OF A BROWSER, AND WHAT IT IS TOLD ABOUT THE CALLER.
 *
 *   · JavaScript a plugin ships under public/ runs in a browser on the site's origin exactly like its
 *     dist/ bundles, so the static /plugins mount serves it under the same gate: the plugin is ACTIVE and
 *     the administrator granted it browser:script (core/plugin-serving pluginPathServable). Styles,
 *     images and fonts under public/ keep the active-only rule.
 *   · A plugin route's req.user carries the caller's email and login only when the plugin holds
 *     users:read — the grant that lets it read accounts through the users bridge. Without it the route
 *     still gets what a gate needs: id, role, the mailbox fact and its own capabilities
 *     (core/plugin-isolate projectRouteUser).
 *
 * Boots the real app from ../index (the /plugins mount lives there), with the DB repointed at a
 * throwaway file and the install guard stubbed, as public-surface-hardening.test.ts does. Activity and
 * grants are stated in memory.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
config.dbPath = path.join(os.tmpdir(), `wjs-browser-code-${process.pid}-${Date.now()}.db`);
config.dbDriver = 'sqlite-native';

const request = require('supertest');
const app = require('../index');

const configManager = require('../core/configManager');
const realIsInstalled = configManager.isInstalled;
const realGetConfig = configManager.getConfig;
configManager.isInstalled = () => true;
configManager.getConfig = () => ({ installedAt: '2020-01-01T00:00:00.000Z', dbDriver: config.dbDriver });
after(() => {
    configManager.isInstalled = realIsInstalled;
    configManager.getConfig = realGetConfig;
});

const PLUGINS_ROOT = path.resolve('./plugins');
const PROBE = 'wjs-browser-code-probe';
const probeDir = path.join(PLUGINS_ROOT, PROBE);

async function withProbe(fn: () => any, { active = true, grants = [] as string[] } = {}): Promise<any> {
    const corePlugins = require('../core/plugins');
    const perms = require('../core/plugin-permissions');
    const realIsActive = corePlugins.isPluginActive;
    corePlugins.isPluginActive = async (slug: string) => (slug === PROBE ? active : realIsActive(slug));
    perms._setGrantsInMemory(PROBE, grants);
    try {
        return await fn();
    } finally {
        corePlugins.isPluginActive = realIsActive;
        perms._setGrantsInMemory(PROBE, []);
    }
}

describe('public/ JavaScript is browser code: served only with browser:script', () => {
    before(() => {
        fs.mkdirSync(path.join(probeDir, 'public', 'nested'), { recursive: true });
        fs.writeFileSync(path.join(probeDir, 'manifest.json'), JSON.stringify({ name: 'Probe', isolated: true }));
        fs.writeFileSync(path.join(probeDir, 'public', 'app.js'), 'window.probe = 1;\n');
        fs.writeFileSync(path.join(probeDir, 'public', 'mod.mjs'), 'export const probe = 1;\n');
        fs.writeFileSync(path.join(probeDir, 'public', 'UPPER.JS'), 'window.upper = 1;\n');
        fs.writeFileSync(path.join(probeDir, 'public', 'nested', 'deep.js'), 'window.deep = 1;\n');
        fs.writeFileSync(path.join(probeDir, 'public', 'style.css'), '.probe{}');
    });
    after(() => { try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* best effort */ } });

    const SCRIPTS = ['public/app.js', 'public/mod.mjs', 'public/UPPER.JS', 'public/nested/deep.js'];

    it('an active plugin WITHOUT browser:script: its scripts are a 404, its stylesheet still served', async () => {
        await withProbe(async () => {
            const css = await request(app).get(`/plugins/${PROBE}/public/style.css`);
            assert.strictEqual(css.status, 200, 'control: non-script public files keep the active-only rule');
            for (const rel of SCRIPTS) {
                const r = await request(app).get(`/plugins/${PROBE}/${rel}`);
                assert.strictEqual(r.status, 404, `${rel} served without browser:script`);
            }
        }, { grants: ['settings:read'] });
    });

    it('assets:write alone does not publish script files either', async () => {
        await withProbe(async () => {
            const r = await request(app).get(`/plugins/${PROBE}/public/app.js`);
            assert.strictEqual(r.status, 404);
        }, { grants: ['assets:write'] });
    });

    it('with browser:script granted, every script is served (nosniff)', async () => {
        await withProbe(async () => {
            for (const rel of SCRIPTS) {
                const r = await request(app).get(`/plugins/${PROBE}/${rel}`);
                assert.strictEqual(r.status, 200, `${rel} refused despite the grant`);
                assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
            }
        }, { grants: ['browser:script', 'assets:write'] });
    });

    it('granted but inactive: still a 404', async () => {
        await withProbe(async () => {
            assert.strictEqual((await request(app).get(`/plugins/${PROBE}/public/app.js`)).status, 404);
            assert.strictEqual((await request(app).get(`/plugins/${PROBE}/public/style.css`)).status, 404);
        }, { active: false, grants: ['browser:script'] });
    });

    it('pluginPathServable states the rule per path', async () => {
        const { pluginPathServable } = require('../core/plugin-serving');
        await withProbe(async () => {
            assert.strictEqual(await pluginPathServable(PROBE, 'public/style.css'), true);
            assert.strictEqual(await pluginPathServable(PROBE, 'public/a.js'), false);
            assert.strictEqual(await pluginPathServable(PROBE, 'public/a.cjs'), false);
            assert.strictEqual(await pluginPathServable(PROBE, 'dist/component.bundle.css'), false);
        });
    });
});

describe('a plugin route sees the caller\'s email and login only with users:read', () => {
    const CALLER = { id: 7, role: 'subscriber', userEmail: 'caller@example.test', userLogin: 'caller' };
    const project = () => require('../core/plugin-isolate').projectRouteUser(CALLER, PROBE);

    it('without users:read: no email, no login — the gate fields are all there', async () => {
        await withProbe(async () => {
            const u = project();
            assert.strictEqual(u.id, 7);
            assert.strictEqual(u.role, 'subscriber');
            assert.strictEqual(typeof u.hasProfessionalMailbox, 'boolean');
            assert.ok(Array.isArray(u.pluginCapabilities));
            assert.strictEqual('userEmail' in u, false, 'email handed to a plugin without users:read');
            assert.strictEqual('userLogin' in u, false, 'login handed to a plugin without users:read');
        }, { grants: ['settings:read', 'express:register_route'] });
    });

    it('with users:read (or users:admin): both are forwarded', async () => {
        for (const grant of ['users:read', 'users:admin']) {
            await withProbe(async () => {
                const u = project();
                assert.strictEqual(u.userEmail, 'caller@example.test', grant);
                assert.strictEqual(u.userLogin, 'caller', grant);
            }, { grants: [grant] });
        }
    });

    it('an anonymous request is still null', () => {
        assert.strictEqual(require('../core/plugin-isolate').projectRouteUser(null, PROBE), null);
    });
});
