/**
 * WordJS - Starter content seeder (install wizard) tests
 *
 * Verifies seedStarterContent() against a throwaway temp SQLite database:
 * the Puck home page (+ homepage_id option), the welcome post, the About page,
 * the header menu — and that the whole seeder is idempotent (safe to run twice).
 *
 * IMPORTANT: `config.dbPath` is repointed to a temp file BEFORE requiring
 * `../config/database` or anything that transitively loads it (the seeder, the
 * Menu model, core/options). See api.test.ts for the rationale.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Repoint the DB at a temp file FIRST.
const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-starter-test-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

// 2. Now it is safe to pull in the DB layer (and, later, the seeder).
const database = require('../config/database');

describe('starter content seeder', () => {
    let dbAsync: any;
    let seedStarterContent: any;

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();

        // A real author for the seeded posts.
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@test.local', 'Administrator']
        );

        // Safe to load only after config.dbPath is repointed (module loads dbAsync at require time).
        ({ seedStarterContent } = require('../core/starter-content'));
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
            try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
    });

    it('seeds home page (Puck), welcome post, about page and header menu', async () => {
        const out = await seedStarterContent(1, 'Test Site');

        // Home page exists, is published, and is the configured front page.
        assert.ok(out.homeId, 'homeId returned');
        const home = await dbAsync.get("SELECT * FROM posts WHERE post_name = 'home' AND post_type = 'page'");
        assert.ok(home, 'home page row exists');
        assert.strictEqual(home.post_status, 'publish');
        const { getOption } = require('../core/options');
        assert.strictEqual(String(await getOption('homepage_id', null)), String(out.homeId), 'homepage_id points at the seeded page');

        // The home page carries valid Puck data built from core blocks.
        const meta = await dbAsync.get("SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = '_puck_data'", [home.id]);
        assert.ok(meta, '_puck_data meta exists');
        const puck = JSON.parse(meta.meta_value);
        assert.ok(Array.isArray(puck.content) && puck.content.length >= 4, 'puck content has blocks');
        assert.strictEqual(puck.content[0].type, 'Heading');
        assert.ok(puck.content[0].props.title.includes('Test Site'), 'headline uses the site name');

        // Welcome post + About page.
        const post = await dbAsync.get("SELECT * FROM posts WHERE post_name = 'welcome-to-wordjs' AND post_type = 'post'");
        assert.ok(post, 'welcome post exists');
        assert.strictEqual(post.post_status, 'publish');
        assert.strictEqual(post.author_id, 1);
        const about = await dbAsync.get("SELECT * FROM posts WHERE post_name = 'about' AND post_type = 'page'");
        assert.ok(about, 'about page exists');

        // Header menu with items, assigned to the header location.
        assert.strictEqual(out.menu, true);
        const menuTerm = await dbAsync.get(
            "SELECT t.term_id AS id FROM terms t JOIN term_taxonomy tt ON tt.term_id = t.term_id WHERE tt.taxonomy = 'nav_menu' AND t.slug = 'main-menu'"
        );
        assert.ok(menuTerm, 'main-menu term exists');
        const locations = await getOption('nav_menu_locations', {});
        assert.strictEqual(String(locations.header), String(menuTerm.id), 'menu assigned to header location');
        const items = await dbAsync.all("SELECT * FROM posts WHERE post_type = 'nav_menu_item'");
        assert.strictEqual(items.length, 2, 'two menu items (Home, About)');
    });

    it('is idempotent — running twice creates no duplicates', async () => {
        await seedStarterContent(1, 'Test Site');

        const homes = await dbAsync.all("SELECT id FROM posts WHERE post_name = 'home' AND post_type = 'page'");
        assert.strictEqual(homes.length, 1, 'still exactly one home page');
        const posts = await dbAsync.all("SELECT id FROM posts WHERE post_name = 'welcome-to-wordjs'");
        assert.strictEqual(posts.length, 1, 'still exactly one welcome post');
        const items = await dbAsync.all("SELECT id FROM posts WHERE post_type = 'nav_menu_item'");
        assert.strictEqual(items.length, 2, 'menu items not duplicated');
        const menus = await dbAsync.all(
            "SELECT t.term_id FROM terms t JOIN term_taxonomy tt ON tt.term_id = t.term_id WHERE tt.taxonomy = 'nav_menu' AND t.slug = 'main-menu'"
        );
        assert.strictEqual(menus.length, 1, 'still exactly one main-menu');
    });
});
