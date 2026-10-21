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

    it('seeds the showcase home page, welcome + sample posts, about page and menus', async () => {
        const out = await seedStarterContent(1, 'Test Site');

        // Home page exists, is published, and is the configured front page.
        assert.ok(out.homeId, 'homeId returned');
        const home = await dbAsync.get("SELECT * FROM posts WHERE post_name = 'home' AND post_type = 'page'");
        assert.ok(home, 'home page row exists');
        assert.strictEqual(home.post_status, 'publish');
        const { getOption } = require('../core/options');
        assert.strictEqual(String(await getOption('homepage_id', null)), String(out.homeId), 'homepage_id points at the seeded page');

        // The home page carries the showcase document: full-width Sections of core blocks.
        const meta = await dbAsync.get("SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = '_puck_data'", [home.id]);
        assert.ok(meta, '_puck_data meta exists');
        const puck = JSON.parse(meta.meta_value);
        assert.ok(Array.isArray(puck.content) && puck.content.length >= 8, 'puck content has its sections');
        assert.ok(puck.content.every((b: any) => b.type === 'Section'), 'every top-level block is a Section');
        assert.ok(meta.meta_value.includes('Welcome to Test Site'), 'the hero greets the site by name');

        // Every block id is unique (the editor keys selection and motion by it).
        const ids: string[] = [];
        const walk = (node: any) => {
            if (Array.isArray(node)) { node.forEach(walk); return; }
            if (!node || typeof node !== 'object') return;
            if (typeof node.type === 'string' && node.props && typeof node.props.id === 'string') ids.push(node.props.id);
            for (const v of Object.values(node.props || {})) if (Array.isArray(v)) walk(v);
        };
        walk(puck.content);
        assert.ok(ids.length > 50, `walked the tree (${ids.length} blocks)`);
        assert.strictEqual(new Set(ids).size, ids.length, 'block ids are unique');

        // Verso emits at most 30 distinct interactions per page (IX_MAX_UNITS_PER_PAGE); past that the
        // rest render with no CSS at all. Identical bodies share a unit, so count distinct bodies.
        const units = new Set<string>();
        const collect = (node: any) => {
            if (Array.isArray(node)) { node.forEach(collect); return; }
            if (!node || typeof node !== 'object') return;
            if (node.props && node.props.ix) units.add(JSON.stringify(node.props.ix));
            for (const v of Object.values(node.props || {})) if (Array.isArray(v)) collect(v);
        };
        collect(puck.content);
        assert.ok(units.size > 10 && units.size <= 30, `distinct interactions within the page budget (${units.size}/30)`);

        // The page's light surfaces and the text on them come from the THEME's tokens (the default
        // theme defines them with the very values the page used to hardcode). Hardcoded white surfaces
        // kept the page white under a dark theme while its headings, forms and FAQ took that theme's
        // light text — lavender on white under Circuito, 1.46:1.
        const LIGHT = /^#(?:fff|ffffff|f1f2fb|f8f9ff|ede9fe)$/i;
        const hardcoded: string[] = [];
        const surfaces = (node: any) => {
            if (Array.isArray(node)) { node.forEach(surfaces); return; }
            if (!node || typeof node !== 'object' || !node.props) return;
            const look = node.props.look || {};
            const paints: Array<[string, unknown]> = [['bg', node.props.bg], ['look.bgColor', look.bgColor],
                ['look.gradFrom', look.gradFrom], ['look.gradVia', look.gradVia], ['look.gradTo', look.gradTo]];
            for (const [k, v] of paints) if (typeof v === 'string' && LIGHT.test(v)) hardcoded.push(`${node.props.id} ${k}=${v}`);
            for (const v of Object.values(node.props)) if (Array.isArray(v)) surfaces(v);
        };
        surfaces(puck.content);
        assert.deepStrictEqual(hardcoded, [], 'light surfaces use theme tokens');
        assert.ok(meta.meta_value.includes('var(--wjs-bg-surface)'), 'the bands paint the theme surface');

        // Welcome post + About page.
        const post = await dbAsync.get("SELECT * FROM posts WHERE post_name = 'welcome-to-wordjs' AND post_type = 'post'");
        assert.ok(post, 'welcome post exists');
        assert.strictEqual(post.post_status, 'publish');
        assert.strictEqual(post.author_id, 1);
        const about = await dbAsync.get("SELECT * FROM posts WHERE post_name = 'about' AND post_type = 'page'");
        assert.ok(about, 'about page exists');
        for (const slug of ['five-things-to-try', 'how-the-home-page-was-built']) {
            const sample = await dbAsync.get("SELECT * FROM posts WHERE post_name = ? AND post_type = 'post'", [slug]);
            assert.ok(sample && sample.post_status === 'publish', `sample post ${slug} is published`);
        }

        // Header menu with items, assigned to the header location.
        assert.strictEqual(out.menu, true);
        const menuTerm = await dbAsync.get(
            "SELECT t.term_id AS id FROM terms t JOIN term_taxonomy tt ON tt.term_id = t.term_id WHERE tt.taxonomy = 'nav_menu' AND t.slug = 'main-menu'"
        );
        assert.ok(menuTerm, 'main-menu term exists');
        const locations = await getOption('nav_menu_locations', {});
        assert.strictEqual(String(locations.header), String(menuTerm.id), 'menu assigned to header location');
        assert.strictEqual(String(locations.footer), String(menuTerm.id), 'menu assigned to footer location');
        const items = await dbAsync.all("SELECT * FROM posts WHERE post_type = 'nav_menu_item'");
        assert.strictEqual(items.length, 4, 'four menu items (Home, Features, Showcase, About)');
    });

    it('is idempotent — running twice creates no duplicates', async () => {
        await seedStarterContent(1, 'Test Site');

        const homes = await dbAsync.all("SELECT id FROM posts WHERE post_name = 'home' AND post_type = 'page'");
        assert.strictEqual(homes.length, 1, 'still exactly one home page');
        const posts = await dbAsync.all("SELECT id FROM posts WHERE post_name = 'welcome-to-wordjs'");
        assert.strictEqual(posts.length, 1, 'still exactly one welcome post');
        const samples = await dbAsync.all("SELECT id FROM posts WHERE post_name IN ('five-things-to-try', 'how-the-home-page-was-built')");
        assert.strictEqual(samples.length, 2, 'sample posts not duplicated');
        const items = await dbAsync.all("SELECT id FROM posts WHERE post_type = 'nav_menu_item'");
        assert.strictEqual(items.length, 4, 'menu items not duplicated');
        const menus = await dbAsync.all(
            "SELECT t.term_id FROM terms t JOIN term_taxonomy tt ON tt.term_id = t.term_id WHERE tt.taxonomy = 'nav_menu' AND t.slug = 'main-menu'"
        );
        assert.strictEqual(menus.length, 1, 'still exactly one main-menu');
    });
});
