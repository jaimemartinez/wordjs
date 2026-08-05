/**
 * WordJS — site-import option guard.
 *
 * `POST /api/v1/import` (routes/export.ts → core/import-export.importSite) used to write EVERY key in
 * the bundle's `settings` map straight through updateOption(). That made an import a second door onto
 * options that have a dedicated, validating write path — 'site_chrome_header'/'site_chrome_footer'
 * (only PUT /api/v1/chrome/:part, which runs chrome-validate) and 'template'/'stylesheet' (only
 * switchTheme()) — the very keys the generic settings writers refuse (DEDICATED_WRITE_API in
 * routes/settings.ts). These tests lock the refusal AND the report of what was skipped.
 *
 * IMPORTANT: `config.dbPath` is repointed to a temp file BEFORE requiring `../config/database` or
 * anything that transitively loads it. See wxr-import.test.ts / starter-content.test.ts.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Repoint the DB at a temp file FIRST.
const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-import-guard-test-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

// 2. Now it is safe to pull in the DB layer (and, later, the importer).
const database = require('../config/database');

describe('site import — protected options are not writable through the bundle', () => {
    let importSite: any;
    let getOption: any;

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        // Safe to load only after config.dbPath is repointed (models bind dbAsync at require time).
        ({ importSite } = require('../core/import-export'));
        ({ getOption } = require('../core/options'));
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
            try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
    });

    it('writes ordinary settings and refuses the ones with a dedicated write API', async () => {
        const results = await importSite({
            settings: {
                blogname: 'Imported Site',
                posts_per_page: 7,
                // Dedicated write API — must never land through an import.
                template: '../plugins/evil',
                stylesheet: '../plugins/evil',
                site_chrome_header: '{"root":{"props":{}},"content":[]}',
                site_chrome_footer: '{"root":{"props":{}},"content":[]}'
            }
        });

        assert.strictEqual(await getOption('blogname'), 'Imported Site');
        assert.strictEqual(String(await getOption('posts_per_page')), '7');
        assert.strictEqual(results.settings.imported, 2);

        for (const key of ['template', 'stylesheet', 'site_chrome_header', 'site_chrome_footer']) {
            assert.strictEqual(await getOption(key), null, `${key} must not be written by an import`);
            assert.ok(results.settings.skipped.includes(key), `${key} must be reported as skipped`);
        }
    });

    it('refuses authorization-critical and secret-shaped keys too', async () => {
        const results = await importSite({
            settings: {
                blogdescription: 'ok',
                wordjs_user_roles: '{"subscriber":["*"]}',   // role -> capability map
                active_plugins: '["evil"]',
                marketplace_theme_sources: 'http://127.0.0.1/catalog.json',
                stripe_api_key: 'sk_live_x'                  // matched by name shape, not a fixed list
            }
        });

        assert.strictEqual(await getOption('blogdescription'), 'ok');
        assert.strictEqual(results.settings.imported, 1);

        for (const key of ['wordjs_user_roles', 'active_plugins', 'marketplace_theme_sources', 'stripe_api_key']) {
            assert.strictEqual(await getOption(key), null, `${key} must not be written by an import`);
            assert.ok(results.settings.skipped.includes(key), `${key} must be reported as skipped`);
        }
    });

    it('reports nothing skipped for a bundle exportSite() could have produced', async () => {
        // Every key exportSite() emits (see its includeSettings branch) must round-trip untouched.
        const results = await importSite({
            settings: {
                blogname: 'Round Trip',
                blogdescription: 'desc',
                posts_per_page: 10,
                date_format: 'F j, Y',
                time_format: 'g:i a',
                timezone_string: 'UTC',
                show_on_front: 'posts',
                page_on_front: 0,
                page_for_posts: 0
            }
        });

        assert.deepStrictEqual(results.settings.skipped, []);
        assert.strictEqual(results.settings.imported, 9);
    });

    it('ignores a settings map that is not an object', async () => {
        // Object.entries() on a string yields index keys, which used to become option rows '0', '1', ….
        const results = await importSite({ settings: 'blogname' });
        assert.strictEqual(results.settings.imported, 0);
        assert.strictEqual(await getOption('0'), null);
    });
});
