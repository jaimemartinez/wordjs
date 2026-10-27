/**
 * THE OPTIONS BRIDGE WRITES BY ALLOWLIST.
 *
 * settings:write lets a plugin write the options named after it (`<slug>_…`, normalized like its table
 * prefix) and nothing else: a site setting with no secret-shaped name — the audit retention, e-mail
 * verification, the upload limit, media storage, GraphQL introspection — is the site's, changed on its
 * own admin screen. The two values the core reads from the site's mail provider (`mail_domain`,
 * `mail_delivery_ready`) are written only by a plugin holding the `email:provider` grant. And the ledger
 * of the options a plugin created can only ever hold names the plugin may write, so uninstalling a
 * plugin never deletes a site setting.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-options-allowlist-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const SLUG = 'acme-shop';
const PROVIDER = 'acme-mail';

describe('options bridge: a plugin writes only its own options', () => {
    let perms: any, createPluginApi: any, runWithContext: any, getOption: any, owned: any;
    const made: string[] = [];
    function writePlugin(slug: string, permissions: any[]) {
        const dir = path.join(require('../core/plugins').PLUGINS_DIR, slug);
        fs.mkdirSync(dir, { recursive: true });
        made.push(dir);
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: slug, version: '1.0.0', isolated: true, permissions }));
        fs.writeFileSync(path.join(dir, 'index.js'), "'use strict';\nmodule.exports = { init() {} };\n");
    }

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        perms = require('../core/plugin-permissions');
        ({ createPluginApi } = require('../core/plugin-api'));
        ({ runWithContext } = require('../core/plugin-context'));
        ({ getOption } = require('../core/options'));
        owned = require('../core/plugin-owned-options');
        await perms.loadGrants();
        const settings = [{ scope: 'settings', access: 'read' }, { scope: 'settings', access: 'write' }];
        writePlugin(SLUG, settings);
        writePlugin(PROVIDER, [...settings, { scope: 'email', access: 'provider', reason: 'sends the site mail' }]);
        perms._setGrantsInMemory(SLUG, ['settings:read', 'settings:write']);
        perms._setGrantsInMemory(PROVIDER, ['settings:read', 'settings:write', 'email:provider']);
    });

    after(async () => {
        for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
        try { await database.closeDatabase(); } catch { /* */ }
        try { fs.rmSync(TMP_DB, { force: true }); } catch { /* */ }
    });

    const as = <T>(slug: string, fn: (api: any) => Promise<T>) => runWithContext(slug, () => fn(createPluginApi(slug)));

    it('writes and reads back an option in its own namespace', async () => {
        await as(SLUG, (api) => api.options.set('acme_shop_config', { currency: 'EUR' }));
        assert.deepStrictEqual(await as(SLUG, (api) => api.options.get('acme_shop_config')), { currency: 'EUR' });
        assert.ok((await owned.optionsOwnedBy(SLUG)).includes('acme_shop_config'), 'its own option is recorded as its own');
    });

    const SITE_SETTINGS = [
        'audit_retention_days', 'require_email_verification', 'comment_registration', 'upload_max_size_mb',
        'media_storage_driver', 'media_storage_bucket', 'graphql_introspection', 'mail_domain', 'mail_delivery_ready',
        // Starts like the slug, but is not under `acme_shop_`.
        'blogname', 'acme_shopping', 'acme_shop',
    ];

    for (const name of SITE_SETTINGS) {
        it(`refuses to write the site option '${name}'`, async () => {
            await assert.rejects(() => as(SLUG, (api) => api.options.set(name, '1')), /not writable by plugins/);
            assert.ok(!(await owned.optionsOwnedBy(SLUG)).includes(name), 'and never records it as the plugin\'s');
        });
    }

    it('the namespace is judged case-insensitively, as MySQL compares option names', async () => {
        await as(SLUG, (api) => api.options.set('ACME_SHOP_Mode', 'live'));
        assert.strictEqual(await getOption('ACME_SHOP_Mode', null), 'live');
    });

    it('the mail provider publishes mail_domain / mail_delivery_ready; a plugin without the grant cannot', async () => {
        await as(PROVIDER, (api) => api.options.set('mail_domain', 'acme.org'));
        await as(PROVIDER, (api) => api.options.set('mail_delivery_ready', '1'));
        assert.strictEqual(await getOption('mail_domain', ''), 'acme.org');
        await assert.rejects(() => as(SLUG, (api) => api.options.set('mail_domain', 'evil.example')), /not writable/);
        assert.strictEqual(await getOption('mail_domain', ''), 'acme.org');
    });

    it('the ledger never records a site option, even when asked directly', async () => {
        await owned.noteOptionWrite(SLUG, 'audit_retention_days');
        await owned.noteOptionWrite(SLUG, 'users_can_register');
        const mine = await owned.optionsOwnedBy(SLUG);
        assert.ok(!mine.includes('audit_retention_days') && !mine.includes('users_can_register'));
    });

    it('namespaces follow the slug the way table prefixes do', () => {
        assert.strictEqual(owned.optionNamespace('photo-carousel'), 'photo_carousel_');
        assert.strictEqual(owned.optionNamespace('theme:gaceta'), 'theme_gaceta_');
        assert.strictEqual(owned.isPluginWritableOption('photo-carousel', 'photo_carousel_list'), true);
        assert.strictEqual(owned.isPluginWritableOption('photo-carousel', 'photo_carousel_'), false, 'the bare prefix names nothing');
        assert.strictEqual(owned.isPluginWritableOption('photo-carousel', 'carousels_list'), false);
    });
});

// The bundled plugins that kept options under bare names now keep them under their own namespace — and
// still see what an earlier version stored, so an update loses no carousel, gallery or video list.
describe('bundled plugins: options moved under the plugin namespace without losing data', () => {
    const PLUGINS_ROOT = path.resolve(__dirname, '../../../marketplace/plugins');

    function boot(slug: string, stored: Record<string, any>) {
        const routes = new Map<string, any>();
        const writes: string[] = [];
        const noop = new Proxy({}, { get: () => () => undefined });
        const wordjs: any = new Proxy({
            options: {
                async get(key: string, def: any = null) { return Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : def; },
                async set(key: string, value: any) { writes.push(key); stored[key] = value; return true; },
            },
            http: { route(method: string, p: string, ...rest: any[]) { routes.set(`${method} ${p}`, rest[rest.length - 1]); } },
        }, { get: (t: any, k: string) => (k in t ? t[k] : noop) });
        const mod = require(path.join(PLUGINS_ROOT, slug, 'index.js'));
        mod.init(wordjs);
        const call = async (key: string, params: any = {}) => {
            let body: any;
            const res: any = { status() { return res; }, json(b: any) { body = b; return res; }, send(b: any) { body = b; return res; } };
            await routes.get(key)({ params, query: {}, body: {} }, res);
            return body;
        };
        return { call, writes, stored };
    }

    it('photo-carousel reads its legacy list and writes only photo_carousel_…', async () => {
        const b = boot('photo-carousel', { carousels_list: ['c1'], carousel_c1: { title: 'Hero', images: [] } });
        const list = await b.call('get /');
        assert.deepStrictEqual(list.map((c: any) => c.id), ['c1']);
        assert.ok(b.writes.length > 0 && b.writes.every((k) => k.startsWith('photo_carousel_')), b.writes.join(','));
        assert.deepStrictEqual(b.stored.photo_carousel_carousels_list, ['c1'], 'carried over under its own name');
    });

    it('card-gallery and video-gallery write only under their own namespace', async () => {
        const c = boot('card-gallery', { card_galleries_list: ['g1'], card_gallery_g1: { name: 'G', cards: [] } });
        await c.call('get /');
        assert.ok(c.writes.every((k) => k.startsWith('card_gallery_')), c.writes.join(','));
        const v = boot('video-gallery', { vgallery_galleries_list: ['default'], vgallery_data_default: { name: 'V', videos: [] } });
        assert.ok(v.writes.every((k) => k.startsWith('video_gallery_')), v.writes.join(','));
        for (const k of [...c.writes, ...v.writes]) {
            assert.ok(require('../core/plugin-owned-options').isPluginWritableOption(k.startsWith('card') ? 'card-gallery' : 'video-gallery', k), k);
        }
    });
});
