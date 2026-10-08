/**
 * THE OPTIONS BRIDGE AND THE HOST'S OWN BOOKKEEPING — three ways a plugin holding nothing but
 * settings:write reached decisions the permission system makes.
 *
 *  1. `plugin_assets` is the enqueue registry. A plugin granted settings:write but NOT assets:write
 *     wrote its own public/*.js into it through options.set, and the public layout emitted it as a
 *     <script src> on every page (same origin as the admin app) — the exposure assets:write and
 *     browser:script exist to gate. Now: the name is refused by the bridge, AND getActiveAssets() emits
 *     only the entries of plugins that hold assets:write today, whoever wrote the row.
 *
 *  2. `plugin_browser_capability_migrated` was the only guard of the one-time browser:script upgrade.
 *     Cleared through the bridge, the next boot re-granted browser:script to every active plugin with
 *     browser code, undoing the administrator's revocations. Now: the name is refused, and the marker
 *     lives inside the grant store, so clearing the old option re-grants nothing.
 *
 *  3. isProtectedOption compared names byte-for-byte while MySQL/MariaDB compare `option_name` under a
 *     case-, accent- and ignorable-insensitive PAD SPACE collation. No MySQL server runs in this suite,
 *     so the collation is MODELLED EXPLICITLY below (mysqlUnicodeCiFold) and every protected name is
 *     probed with spellings that model says are the same row.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-host-bookkeeping-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const PROBE = 'wjs-hb-probe';   // ships public/x.js and a hooks bundle; granted settings only
const OTHER = 'wjs-hb-other';   // another active plugin with browser code, revoked by the admin

/**
 * utf8mb4_unicode_ci as far as these names are concerned: accents and compatibility forms fold (NFKD +
 * combining marks dropped), zero-weight code points vanish, case folds, `ß` expands to `ss`, and PAD
 * SPACE ignores trailing spaces. Two names with the same fold are ONE option row on MySQL/MariaDB.
 */
function mysqlUnicodeCiFold(name: string): string {
    const { IGNORABLE_RANGES } = require('../core/protected-meta');
    let out = '';
    for (const ch of name.normalize('NFKD')) {
        const cp = ch.codePointAt(0) as number;
        if (cp >= 0x0300 && cp <= 0x036f) continue;
        if ((IGNORABLE_RANGES as Array<[number, number]>).some(([lo, hi]) => cp >= lo && cp <= hi)) continue;
        out += ch;
    }
    return out.toLowerCase().replace(/ß/g, 'ss').replace(/ +$/, '');
}

/** Spellings of `name` that the model above folds to the same row. */
function collationTwins(name: string): string[] {
    const accented: Record<string, string> = { a: 'à', e: 'é', i: 'í', o: 'ó', u: 'ú' };
    const vowel = name.search(/[aeiou]/);
    const out = [
        name.toUpperCase(),
        name[0].toUpperCase() + name.slice(1),
        `${name} `,
        `${name}   `,
        `${name}\u200b`,
        `\ufeff${name}`,
        `${name[0]}\u00ad${name.slice(1)}`,
        String.fromCodePoint(name.codePointAt(0)! - 0x61 + 0xff41) + name.slice(1), // fullwidth first letter
    ];
    if (vowel >= 0) out.push(name.slice(0, vowel) + accented[name[vowel]] + name.slice(vowel + 1));
    if (name.includes('ss')) out.push(name.replace('ss', 'ß'));
    return out;
}

describe('the options bridge refuses the host\'s bookkeeping, under every spelling the database matches', () => {
    let core: any, perms: any, getOption: any, updateOption: any, createPluginApi: any, runWithContext: any;
    let isProtectedOption: any, PROTECTED_OPTION_NAMES: Set<string>, getActiveAssets: any;
    let request: any, app: any;
    const made: string[] = [];

    function writePlugin(slug: string, permissions: any[], files: Record<string, string>) {
        const dir = path.join(core.PLUGINS_DIR, slug);
        fs.mkdirSync(dir, { recursive: true });
        made.push(dir);
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: slug, version: '1.0.0', isolated: true, permissions }));
        fs.writeFileSync(path.join(dir, 'index.js'), "'use strict';\nmodule.exports = { init() {} };\n");
        for (const [rel, body] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), body);
        }
    }

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        core = require('../core/plugins');
        perms = require('../core/plugin-permissions');
        ({ getOption, updateOption } = require('../core/options'));
        ({ createPluginApi, isProtectedOption, PROTECTED_OPTION_NAMES } = require('../core/plugin-api'));
        ({ runWithContext } = require('../core/plugin-context'));
        ({ getActiveAssets } = require('../core/plugin-assets'));
        await perms.loadGrants();

        const declared = [
            { scope: 'settings', access: 'read' },
            { scope: 'settings', access: 'write' },
            { scope: 'assets', access: 'write' },
            { scope: 'browser', access: 'script', reason: 'admin hooks' },
        ];
        writePlugin(PROBE, declared, {
            'public/x.js': 'document.title = "owned";\n',
            'dist/hooks.bundle.js': 'window.x = 1;\n',
        });
        writePlugin(OTHER, [{ scope: 'browser', access: 'script', reason: 'admin page' }], {
            'dist/admin.bundle.js': 'window.y = 1;\n',
        });
        // The admin granted the settings scopes ONLY — not assets:write, not browser:script.
        perms._setGrantsInMemory(PROBE, ['settings:read', 'settings:write']);

        request = require('supertest');
        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json());
        app.use('/api/v1/plugins', require('../routes/plugins'));
        app.use(errorHandler);
    });

    after(async () => {
        for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
        try { await database.closeDatabase(); } catch { /* */ }
        try { fs.rmSync(TMP_DB, { force: true }); } catch { /* */ }
    });

    const bridge = () => createPluginApi(PROBE);
    const asPlugin = <T>(fn: () => Promise<T>) => runWithContext(PROBE, fn);
    const forgedAssets = () => ({
        [PROBE]: [{ kind: 'script', handle: 'x', src: `/plugins/${PROBE}/public/x.js`, inFooter: false, strategy: '' }],
    });

    describe('1 — plugin_assets: settings:write is not assets:write', () => {
        it('the bridge refuses to write (or read) the enqueue registry', async () => {
            await asPlugin(async () => {
                await assert.rejects(() => bridge().options.set('plugin_assets', forgedAssets()), /not writable by plugins/);
                await assert.rejects(() => bridge().options.get('plugin_assets'), /not readable by plugins/);
            });
            const stored = (await getOption('plugin_assets', {})) || {};
            assert.ok(!Object.hasOwn(stored, PROBE), 'nothing was written for the plugin');
        });

        it('an entry in the registry is emitted only while its plugin HOLDS assets:write', async () => {
            // Whoever wrote the row (an earlier bridge, a revoked grant, a restored backup), the public
            // list follows today's grant.
            await updateOption('plugin_assets', forgedAssets());
            await updateOption('active_plugins', [PROBE]);
            try {
                const srcs = async () => (await request(app).get('/api/v1/plugins/assets')).body.scripts.map((s: any) => s.src);
                assert.deepStrictEqual(await srcs(), [], 'not granted → not on any public page');
                assert.deepStrictEqual((await getActiveAssets()).scripts, []);

                // Control: the very same row renders once the administrator grants assets:write.
                perms._setGrantsInMemory(PROBE, ['settings:read', 'settings:write', 'assets:write']);
                assert.deepStrictEqual(await srcs(), [`/plugins/${PROBE}/public/x.js`]);

                // And a revoke takes it off again at the next read.
                perms._setGrantsInMemory(PROBE, ['settings:read', 'settings:write']);
                assert.deepStrictEqual(await srcs(), []);
            } finally {
                await updateOption('active_plugins', []);
                await updateOption('plugin_assets', {});
            }
        });
    });

    describe('2 — the browser:script upgrade cannot be replayed to undo a revoke', () => {
        it('the bridge refuses the old completion marker', async () => {
            await asPlugin(async () => {
                await assert.rejects(() => bridge().options.set('plugin_browser_capability_migrated', false), /not writable by plugins/);
                await assert.rejects(() => bridge().options.set('plugin_browser_capability_migrated', ''), /not writable by plugins/);
            });
        });

        it('clearing the old marker after the upgrade re-grants nothing — the admin\'s revokes stand', async () => {
            await perms.setGrants(PROBE, ['settings:read', 'settings:write']);
            await perms.setGrants(OTHER, []);
            await updateOption('active_plugins', [PROBE, OTHER]);
            try {
                // The genuine one-time upgrade: both active plugins ship browser code, both get it once.
                const first = await core.migrateBrowserCapabilityGrants();
                assert.deepStrictEqual([...first].sort(), [OTHER, PROBE].sort());

                // The administrator revokes browser:script from both.
                await perms.setGrants(PROBE, ['settings:read', 'settings:write']);
                await perms.setGrants(OTHER, []);

                // The attack: the old marker cleared (what options.set did before it was refused), then a
                // reboot — loadGrants() and the upgrade step, in index.ts order.
                await updateOption(core.BROWSER_CAPABILITY_MIGRATION_OPTION, null);
                await updateOption(core.BROWSER_CAPABILITY_MIGRATION_OPTION, false);
                await perms.loadGrants();
                assert.deepStrictEqual(await core.migrateBrowserCapabilityGrants(), [], 'a second run grants nothing');
                assert.ok(!perms.getGrants(PROBE).includes('browser:script'), 'the revoke on the plugin itself stands');
                assert.ok(!perms.getGrants(OTHER).includes('browser:script'), 'and on every other plugin');
                assert.ok(await perms.getHostMarker(core.BROWSER_CAPABILITY_MIGRATION_MARKER), 'completion is recorded in the grant store');
            } finally {
                await updateOption('active_plugins', []);
            }
        });

        it('the marker never surfaces as a plugin\'s grant record', async () => {
            await perms.loadGrants();
            assert.deepStrictEqual(perms.getGrants(perms.HOST_RECORD_KEY), []);
            assert.strictEqual(perms.isGranted(perms.HOST_RECORD_KEY, 'browser', 'script'), false);
        });
    });

    describe('twins — the same host-owned class, and the theme backstop that drifted from the list', () => {
        const TWINS = ['site_chrome_announcement', 'custom_post_types', 'custom_content_schemas', 'custom_taxonomies'];

        it('the third chrome part and the content-type/taxonomy registries are refused by the bridge', async () => {
            await asPlugin(async () => {
                for (const name of TWINS) {
                    await assert.rejects(() => bridge().options.set(name, {}), /not writable by plugins/, name);
                }
            });
        });

        it('a theme context is refused every name the bridge protects (one list, not a drifted copy)', () => {
            const { assertThemeOptionWritable } = require('../core/options');
            runWithContext('theme:wjs-hb-theme', () => {
                for (const name of ['plugin_assets', 'plugin_browser_capability_migrated', 'mfa_policy', 'admin_notices', ...TWINS, 'PLUGIN_GRANTS', 'plugin_grants ']) {
                    assert.throws(() => assertThemeOptionWritable(name), /not writable from theme context/, JSON.stringify(name));
                }
                assert.doesNotThrow(() => assertThemeOptionWritable('blogdescription'), 'ordinary names stay writable');
            });
        });
    });

    describe('3 — a protected name is protected under every spelling the database treats as the same', () => {
        it('the collation model folds each twin to its protected name (sanity of the model itself)', () => {
            for (const name of PROTECTED_OPTION_NAMES) {
                for (const twin of collationTwins(name)) {
                    assert.strictEqual(mysqlUnicodeCiFold(twin), mysqlUnicodeCiFold(name), `${JSON.stringify(twin)} must model as ${name}`);
                }
            }
        });

        it('isProtectedOption answers true for every collation twin of every protected name', () => {
            const missed: string[] = [];
            for (const name of PROTECTED_OPTION_NAMES) {
                for (const twin of collationTwins(name)) {
                    if (!isProtectedOption(twin)) missed.push(JSON.stringify(twin));
                }
            }
            assert.deepStrictEqual(missed, [], 'spellings the bridge would let through to a protected row');
        });

        it('secret-named options keep their protection when the secret word is decorated', () => {
            for (const twin of ['smtp_pässword', 'smtp_passwórd', 'mail_security_dkím_private_key', 'stripe_api_kéy', 'SMTP_PASSWORD ', 'smtp_password\u200b']) {
                assert.strictEqual(isProtectedOption(twin), true, `${JSON.stringify(twin)} names a secret row on MySQL`);
            }
        });

        it('the bridge refuses the twins for real (read and write)', async () => {
            await asPlugin(async () => {
                await assert.rejects(() => bridge().options.set('plugin_grants ', { [PROBE]: ['database:admin'] }), /not writable by plugins/);
                await assert.rejects(() => bridge().options.set('plugin_grànts', { [PROBE]: ['database:admin'] }), /not writable by plugins/);
                await assert.rejects(() => bridge().options.get('smtp_pässword'), /not readable by plugins/);
                await assert.rejects(() => bridge().options.get(['plugin_grants'] as any), /not readable by plugins/);
            });
        });

        it('twin: a site import skips the same spellings (it is gated by the same predicate)', async () => {
            const { importSite } = require('../core/import-export');
            const before = await getOption('plugin_grants', {});
            const res = await importSite({
                settings: {
                    'plugin_grants ': { [PROBE]: ['database:admin'] },
                    'plugin_grànts': { [PROBE]: ['database:admin'] },
                    'SITEURL​': 'https://evil.example',
                    blogdescription: 'imported tagline',
                },
            }, {});
            assert.deepStrictEqual([...res.settings.skipped].sort(), ['SITEURL​', 'plugin_grànts', 'plugin_grants '].sort());
            assert.strictEqual(res.settings.imported, 1, 'only the ordinary setting is written');
            assert.deepStrictEqual(await getOption('plugin_grants', {}), before);
            assert.strictEqual(await getOption('blogdescription', ''), 'imported tagline');
        });

        it('ordinary plugin option names are untouched (no over-block)', async () => {
            for (const name of ['bookings_config', 'carousels_list', 'youtube_videos_cache_ttl', 'mail_delivery_ready', 'mail_domain', 'WPLANG', 'blogname']) {
                assert.strictEqual(isProtectedOption(name), false, name);
            }
            await asPlugin(async () => {
                await bridge().options.set('bookings_config', { slots: 3 });
                assert.deepStrictEqual(await bridge().options.get('bookings_config'), { slots: 3 });
            });
        });
    });
});
