/**
 * WordJS - every (site, plugin) worker's AppContainer profile goes when the worker is gone for good
 * (documentation/multisite-design.md, "Phase 2 as built").
 *
 * On Windows core/plugin-isolate launches each worker of a multisite network under its own AppContainer
 * profile, named for its worker key: `<slug>` on site 1, `s<id>:<slug>` elsewhere (themes:
 * `theme:<slug>` / `s<id>:theme:<slug>`). Deleting a plugin used to retire only site 1's; deleting a site
 * retired none of its workers' profiles and left their private storage behind.
 *
 *  · MOCKED tests run everywhere: the profile API (derive / delete / revoke / the ACL-marker check) is
 *    replaced at sandbox-windows' own seam, and the callers' one call into sandbox-windows is recorded.
 *  · The LIVE test runs only on Windows with WORDJS_TEST_APPCONTAINER=1 (it registers real profiles),
 *    like the live half of sandbox-windows-appcontainer.test.ts, and removes everything it made.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const sw = require('../core/sandbox-windows');
const sandboxPaths = require('../core/sandbox-paths');
const siteContext = require('../core/site-context');
const config = require('../config/app');

const IS_WIN = process.platform === 'win32';
const LIVE = IS_WIN && process.env.WORDJS_TEST_APPCONTAINER === '1';
const ROOT = path.join(os.tmpdir(), 'wjs-retire-root');
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

/** Swap members of an object for the duration of `fn`, restoring them whatever happens. */
async function withStubs<T>(target: any, stubs: Record<string, any>, fn: () => Promise<T>): Promise<T> {
    const saved: Record<string, any> = {};
    for (const k of Object.keys(stubs)) { saved[k] = target[k]; target[k] = stubs[k]; }
    try { return await fn(); } finally { for (const k of Object.keys(saved)) target[k] = saved[k]; }
}

/** A recording profile API: every SID is `S-1-15-2-<n>` of the profile it was derived from. */
function fakeProfileApi(platform: string) {
    const sids = new Map<string, string>();
    const calls = { derived: [] as string[], deleted: [] as string[], revoked: [] as Array<{ sid: string; dirs: string[] }> };
    return {
        calls,
        sidOf: (profile: string) => sids.get(profile),
        api: {
            platform: () => platform,
            deriveSid: async (name: string) => {
                calls.derived.push(name);
                if (!sids.has(name)) sids.set(name, `S-1-15-2-${sids.size + 1}`);
                return sids.get(name);
            },
            deleteProfile: async (name: string) => { calls.deleted.push(name); return true; },
            revoke: async (sid: string, dirs: string[]) => { calls.revoked.push({ sid, dirs }); return true; },
            grantIsCached: () => true,
            // Retirement revokes every candidate zone that exists (not only where a marker proves a grant).
            exists: () => true,
        },
    };
}

describe('AppContainer profile per (site, plugin) worker', () => {
    test("a worker's profile is the one plugin-isolate launches it under", () => {
        for (const slug of ['alpha', 'theme:verso']) {
            assert.strictEqual(sw.appContainerProfileNameForSite(ROOT, slug, 1), sw.appContainerProfileNameForPlugin(ROOT, slug), 'site 1 keeps the single-site profile');
            for (const id of [2, 9]) {
                // plugin-isolate's worker key is siteKeyPrefix(site) + slug; sandbox-paths' siteStorageSlug must agree.
                const key = siteContext.siteKeyPrefix(id) + slug;
                assert.strictEqual(sandboxPaths.siteStorageSlug(slug, id), key);
                assert.strictEqual(sw.appContainerProfileNameForSite(ROOT, slug, id), sw.appContainerProfileNameForPlugin(ROOT, key));
            }
        }
        const names = new Set([
            sw.appContainerProfileNameForSite(ROOT, 'alpha', 1), sw.appContainerProfileNameForSite(ROOT, 'alpha', 2),
            sw.appContainerProfileNameForSite(ROOT, 'alpha', 3), sw.appContainerProfileNameForSite(ROOT, 'beta', 2),
            sw.appContainerProfileNameForSite(ROOT, 'theme:alpha', 2),
        ]);
        assert.strictEqual(names.size, 5, 'no two (site, worker) pairs share a profile');
    });

    test("retiring site 3's worker names only site 3's profile and site 3's storage", async () => {
        const fake = fakeProfileApi('win32');
        const ok = await withStubs(sw.__profileApi, fake.api, () => sw.retireAppContainerPlugin(ROOT, 'alpha', 3));
        assert.strictEqual(ok, true);
        const mine = sw.appContainerProfileNameForSite(ROOT, 'alpha', 3);
        assert.deepStrictEqual(fake.calls.derived, [mine]);
        assert.deepStrictEqual(fake.calls.deleted, [mine]);
        assert.strictEqual(fake.calls.revoked.length, 1);
        assert.strictEqual(fake.calls.revoked[0].sid, fake.sidOf(mine));
        const revoked = fake.calls.revoked[0].dirs.map((d) => path.resolve(d).toLowerCase());
        for (const dir of sandboxPaths.privateStorageDirs(ROOT, 'alpha', 3)) assert.ok(revoked.includes(path.resolve(dir).toLowerCase()), `site 3's storage ${dir}`);
        for (const other of [sandboxPaths.privateStorageDirs(ROOT, 'alpha', 1), sandboxPaths.privateStorageDirs(ROOT, 'alpha', 2), sandboxPaths.privateStorageDirs(ROOT, 'beta', 3)]) {
            for (const dir of other) assert.ok(!revoked.includes(path.resolve(dir).toLowerCase()), `never another worker's storage (${dir})`);
        }
    });

    test('a theme worker of another site is retired under its s<id>:theme: profile', async () => {
        const fake = fakeProfileApi('win32');
        await withStubs(sw.__profileApi, fake.api, () => sw.retireAppContainerPlugin(ROOT, 'theme:verso', 4));
        assert.deepStrictEqual(fake.calls.deleted, [sw.appContainerProfileNameForPlugin(ROOT, 's4:theme:verso')]);
    });

    test('off Windows there is no persistent profile: nothing is derived, revoked or deleted', async () => {
        for (const platform of ['linux', 'darwin']) {
            const fake = fakeProfileApi(platform);
            const ok = await withStubs(sw.__profileApi, fake.api, () => sw.retireAppContainerPlugin(ROOT, 'alpha', 3));
            assert.strictEqual(ok, false);
            assert.deepStrictEqual(fake.calls, { derived: [], deleted: [], revoked: [] });
        }
    });
});

describe('deleting a plugin retires its profile on every other site', () => {
    const plugins = require('../core/plugins');
    const network = require('../core/network');

    test('one call per secondary site of the registry (suspended included), none for site 1', async () => {
        const calls: Array<[string, string, number]> = [];
        const sites = [{ id: 1, status: 'active' }, { id: 2, status: 'active' }, { id: 5, status: 'suspended' }];
        const retired = await withStubs(config, { multisite: { enabled: true } }, () =>
            withStubs(network, { listSites: () => sites }, () =>
                withStubs(sw, { retireAppContainerPlugin: async (root: string, slug: string, id: number) => { calls.push([root, slug, id]); return id === 2; } }, () =>
                    plugins.retireOnSecondarySites('alpha'))));
        assert.deepStrictEqual(calls, [[BACKEND_ROOT, 'alpha', 2], [BACKEND_ROOT, 'alpha', 5]]);
        assert.deepStrictEqual(retired, [2], 'reports the sites whose profile was removed');
    });

    test('a single-site install touches no other site', async () => {
        const calls: number[] = [];
        const retired = await withStubs(config, { multisite: { enabled: false } }, () =>
            withStubs(sw, { retireAppContainerPlugin: async (_r: string, _s: string, id: number) => { calls.push(id); return true; } }, () =>
                plugins.retireOnSecondarySites('alpha')));
        assert.deepStrictEqual(calls, []);
        assert.deepStrictEqual(retired, []);
    });

    test('one failing site does not stop the others', async () => {
        const calls: number[] = [];
        const retired = await withStubs(config, { multisite: { enabled: true } }, () =>
            withStubs(network, { listSites: () => [{ id: 1 }, { id: 2 }, { id: 3 }] }, () =>
                withStubs(sw, { retireAppContainerPlugin: async (_r: string, _s: string, id: number) => { calls.push(id); if (id === 2) throw new Error('boom'); return true; } }, () =>
                    plugins.retireOnSecondarySites('alpha'))));
        assert.deepStrictEqual(calls, [2, 3]);
        assert.deepStrictEqual(retired, [3]);
    });
});

describe("deleting a site retires its workers' profiles and private storage", () => {
    const networkSites = require('../core/network-sites');
    const plugins = require('../core/plugins');
    const themes = require('../core/themes');
    // A site id no real install reaches, so the storage directories made below can only be this test's.
    const SITE = 987001;
    const OTHER = 987002;
    const made: string[] = [];
    after(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

    test("every plugin and theme worker of the site, and nothing of another site's", async () => {
        const mk = (slug: string, id: number) => sandboxPaths.privateStorageDirs(BACKEND_ROOT, slug, id).map((d: string) => {
            fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(path.join(d, 'marker'), 'x');
            made.push(d);
            return d;
        });
        const doomed = [...mk('alpha', SITE), ...mk('theme:verso', SITE)];
        const kept = [...mk('alpha', OTHER), ...mk('alpha', 1)];
        const calls: Array<[string, number]> = [];
        const warnings = await withStubs(plugins, { scanPlugins: () => [{ slug: 'alpha' }, { slug: 'beta' }] }, () =>
            withStubs(themes, { scanThemes: () => [{ slug: 'verso' }] }, () =>
                withStubs(sw, { retireAppContainerPlugin: async (_r: string, key: string, id: number) => { calls.push([key, id]); return true; } }, () =>
                    networkSites.retireSiteWorkers(SITE))));
        assert.deepStrictEqual(warnings, []);
        assert.deepStrictEqual(calls, [['alpha', SITE], ['beta', SITE], ['theme:verso', SITE]]);
        for (const d of doomed) assert.ok(!fs.existsSync(d), `removed: ${d}`);
        for (const d of kept) assert.ok(fs.existsSync(path.join(d, 'marker')), `kept: ${d}`);
    });

    test('the main site is never retired this way', async () => {
        const calls: number[] = [];
        await withStubs(sw, { retireAppContainerPlugin: async (_r: string, _k: string, id: number) => { calls.push(id); return true; } }, () =>
            networkSites.retireSiteWorkers(1));
        assert.deepStrictEqual(calls, []);
    });
});

describe('live: a real (site, plugin) profile is removed and its neighbours are not', { skip: !LIVE ? 'set WORDJS_TEST_APPCONTAINER=1 on Windows (this test registers AppContainer profiles)' : false }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-retire-live-'));
    const target = sw.appContainerProfileNameForSite(root, 'alpha', 7);
    const neighbours = [sw.appContainerProfileNameForSite(root, 'alpha', 1), sw.appContainerProfileNameForSite(root, 'beta', 7), sw.appContainerProfileNameForSite(root, 'alpha', 8)];
    after(async () => {
        for (const p of [target, ...neighbours]) { try { await sw.deleteAppContainerProfile(p); } catch { /* */ } }
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
    });

    // A registered profile has a mapping under the user's hive, keyed by its package SID.
    const MAPPINGS = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings';
    function registered(sid: string): boolean {
        try { execFileSync('reg', ['query', `${MAPPINGS}\\${sid}`], { stdio: 'ignore' }); return true; } catch { return false; }
    }

    test('retire removes s7:alpha only', async () => {
        const sid = await sw.ensureAppContainerProfile(target);
        assert.ok(sid, 'profile creation must succeed on this host');
        const others: string[] = [];
        for (const p of neighbours) { const s = await sw.ensureAppContainerProfile(p); assert.ok(s); others.push(s as string); }
        assert.ok(registered(sid as string), 'the profile is registered before');
        // Give its private storage a real grant, so the revoke path runs too.
        const storage = sandboxPaths.privateStorageDirs(root, 'alpha', 7)[0];
        fs.mkdirSync(storage, { recursive: true });
        assert.strictEqual(await sw.grantAppContainerAccess(sid, [storage], 'full'), true);
        assert.strictEqual(sw.__aclGrantIsCached(sid, storage, 'full'), true);

        assert.strictEqual(await sw.retireAppContainerPlugin(root, 'alpha', 7), true);
        assert.ok(!registered(sid as string), 'its profile is gone');
        assert.strictEqual(sw.__aclGrantIsCached(sid, storage, 'full'), false, 'its grant marker is gone');
        for (const s of others) assert.ok(registered(s), `a neighbour's profile stays (${s})`);
    });
});
