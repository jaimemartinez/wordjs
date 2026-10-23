/**
 * A PLUGIN UPDATE ON WINDOWS NO LONGER WAITS TWO MINUTES FOR ITS SANDBOX (FALLOS 149).
 *
 * Every in-place update retired the plugin's AppContainer profile: a recursive `icacls /remove /T` over
 * every zone its SID was granted — backend/node_modules included, ~23,500 entries carrying one inherited
 * ACE per plugin ever installed — which hit the 120 s timeout on a OneDrive checkout, and then the next
 * launch re-granted the very same zones recursively. Now:
 *   · an update does NOT retire: the plugin keeps its slug, so its profile and zones are exactly what the
 *     next launch grants. It only forgets the cached grant on its OWN folder, for every site's worker, so the
 *     files it moved in by rename (which keep the staging folder's security descriptor) are granted again;
 *   · grants and revokes touch zone ROOTS only (inheritance does the rest — the live test in
 *     sandbox-windows-appcontainer.test.ts proves descendants follow);
 *   · retirement (uninstall, site deletion) still revokes everything: root-only for zones granted this way,
 *     and a one-time DEEP revoke for a zone an earlier release granted recursively (explicit ACEs on its
 *     sub-folders, which a root-only revoke cannot reach).
 * The profile API is replaced at sandbox-windows' own seam, so this runs on every platform.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';

const sw = require('../core/sandbox-windows');
const sandboxPaths = require('../core/sandbox-paths');

const ROOT = path.join(os.tmpdir(), 'wjs-update-sandbox-root');

async function withStubs<T>(target: any, stubs: Record<string, any>, fn: () => Promise<T>): Promise<T> {
    const saved: Record<string, any> = {};
    for (const k of Object.keys(stubs)) { saved[k] = target[k]; target[k] = stubs[k]; }
    try { return await fn(); } finally { for (const k of Object.keys(saved)) target[k] = saved[k]; }
}

function recorder(opts: { platform?: string; legacyDirs?: string[] } = {}) {
    const calls = { derived: [] as string[], deleted: [] as string[], revoked: [] as string[][], deep: [] as string[][], forgotten: [] as Array<{ sid: string; dir: string }> };
    const legacy = new Set((opts.legacyDirs || []).map((d) => path.resolve(d).toLowerCase()));
    return {
        calls,
        api: {
            platform: () => opts.platform || 'win32',
            deriveSid: async (name: string) => { calls.derived.push(name); return `S-1-15-2-${calls.derived.length}`; },
            deleteProfile: async (name: string) => { calls.deleted.push(name); return true; },
            revoke: async (_sid: string, dirs: string[]) => { calls.revoked.push(dirs); return true; },
            revokeDeep: async (_sid: string, dirs: string[]) => { calls.deep.push(dirs); return true; },
            grantIsCached: () => true,
            legacyDeepGrant: (_sid: string, dir: string) => legacy.has(path.resolve(dir).toLowerCase()),
            forgetGrants: (sid: string, dir: string) => { calls.forgotten.push({ sid, dir }); },
        },
    };
}

describe('Windows sandbox on a plugin update', () => {
    test('the update refresh forgets ONLY the plugin folder\'s grant, for every site\'s worker — no revoke, no profile deleted', async () => {
        const r = recorder();
        const n = await withStubs(sw.__profileApi, r.api, () => sw.refreshPluginDirGrants(ROOT, 'alpha', [1, 3, 3]));
        assert.strictEqual(n, 2, 'one per distinct site');
        assert.deepStrictEqual(r.calls.derived, [sw.appContainerProfileNameForSite(ROOT, 'alpha', 1), sw.appContainerProfileNameForSite(ROOT, 'alpha', 3)]);
        const own1 = sandboxPaths.sandboxPaths(ROOT, 'alpha', path.resolve(__dirname, '../core'), 1).own;
        assert.deepStrictEqual(r.calls.forgotten.map((f) => f.dir), [own1, sandboxPaths.sandboxPaths(ROOT, 'alpha', path.resolve(__dirname, '../core'), 3).own]);
        assert.deepStrictEqual(r.calls.revoked, [], 'nothing is revoked');
        assert.deepStrictEqual(r.calls.deep, []);
        assert.deepStrictEqual(r.calls.deleted, [], 'the profile is kept');
    });

    test('off Windows the refresh is a no-op', async () => {
        const r = recorder({ platform: 'linux' });
        assert.strictEqual(await withStubs(sw.__profileApi, r.api, () => sw.refreshPluginDirGrants(ROOT, 'alpha', [1])), 0);
        assert.deepStrictEqual(r.calls.derived, []);
    });

    test('retirement still revokes everything: root-only for current grants, a deep revoke only for an earlier release\'s recursive ones', async () => {
        const zones = sw.appContainerZones(ROOT, 'alpha', path.resolve(__dirname, '../core'), 1);
        const nodeModules = path.join(ROOT, 'node_modules');
        assert.ok(zones.readExec.map((d: string) => path.resolve(d)).includes(path.resolve(nodeModules)), 'node_modules is an rx zone');
        const r = recorder({ legacyDirs: [nodeModules] });
        const ok = await withStubs(sw.__profileApi, r.api, () => sw.retireAppContainerPlugin(ROOT, 'alpha', 1));
        assert.strictEqual(ok, true);
        assert.deepStrictEqual(r.calls.deep, [[path.resolve(nodeModules)]], 'the legacy recursive grant gets the deep revoke, once');
        const shallow = (r.calls.revoked[0] || []).map((d) => path.resolve(d).toLowerCase());
        assert.ok(!shallow.includes(path.resolve(nodeModules).toLowerCase()), 'not revoked twice');
        assert.ok(shallow.includes(path.resolve(zones.readExec[2]).toLowerCase()), 'the plugin folder is revoked root-only');
        assert.deepStrictEqual(r.calls.deleted, [sw.appContainerProfileNameForSite(ROOT, 'alpha', 1)], 'the profile is deleted');
    });

    test('with no earlier recursive grant, retirement never walks a tree', async () => {
        const r = recorder();
        await withStubs(sw.__profileApi, r.api, () => sw.retireAppContainerPlugin(ROOT, 'alpha', 1));
        assert.deepStrictEqual(r.calls.deep, []);
        assert.strictEqual(r.calls.revoked.length, 1);
    });
});

describe('the update path does not retire the sandbox', () => {
    test('uninstallPluginData({ retireSandbox: false }) leaves the profile alone — even on Windows', async () => {
        const plugins = require('../core/plugins');
        const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        let retired = 0;
        const realRetire = sw.retireAppContainerPlugin;
        sw.retireAppContainerPlugin = async () => { retired++; return true; };
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            const kept = await plugins.uninstallPluginData('wjs-upd-sandbox-probe', { keepGrants: true, retireSandbox: false });
            assert.strictEqual(retired, 0, 'an update must not retire');
            assert.strictEqual(kept.appContainerRetired, false);
            await plugins.uninstallPluginData('wjs-upd-sandbox-probe', { keepGrants: true });
            assert.strictEqual(retired, 1, 'control: an uninstall still retires');
        } finally {
            if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
            sw.retireAppContainerPlugin = realRetire;
        }
    });

    test('runPluginUpdate refreshes the plugin folder after the swap (who retires is tested in plugin-update.test.ts)', () => {
        const src = require('fs').readFileSync(path.resolve(__dirname, '../routes/plugins.ts'), 'utf8');
        const body = src.slice(src.indexOf('async function runPluginUpdate'), src.indexOf('async function recoverInterruptedPluginUpdates'));
        const swap = body.indexOf('fs.renameSync(path.join(stagedPluginDir, entry)');
        const refresh = body.indexOf('refreshPluginDirGrants(');
        assert.ok(swap > 0 && refresh > swap, 'the folder is refreshed after the new files are in');
        assert.ok(body.includes('slug, core.pluginWorkerSiteIds())'), 'for every site\'s worker');
    });
});
