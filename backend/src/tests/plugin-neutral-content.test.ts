/**
 * PUBLIC CONTENT WITHOUT PLUGIN-SPECIFIC CORE CODE.
 *
 * Two places in the core used to exist for single plugins:
 *   · the static front page kept a hardcoded `[cards]` → card-gallery / `[vgallery]` → video-gallery map;
 *   · every post mounted an initialiser for photo-carousel's `[carousel]` markup.
 * The first is now the plugins' own manifest declaration, served by GET /plugins/shortcodes; the second
 * is gone, because photo-carousel renders a plain-markup carousel on the core's plugin-neutral
 * `wjs-snap-strip` primitive (the sanitizer always stripped the <style> its old output relied on).
 *
 * Drives the REAL router over supertest with probe plugins on disk, and the REAL photo-carousel module.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-neutral-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const pluginsCore = require('../core/plugins');

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/api/v1', require('../routes'));

const ID = process.pid;
const WITH_COMPONENT = `wjs-sc-gallery-${ID}`;
const NO_COMPONENT = `wjs-sc-headless-${ID}`;
const INACTIVE = `wjs-sc-idle-${ID}`;
const SECOND = `wjs-sc-second-${ID}`;
const created: string[] = [];

function writePlugin(slug: string, manifest: any) {
    const dir = path.join(pluginsCore.PLUGINS_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: slug, name: slug, version: '1.0.0', isolated: true, ...manifest }));
    created.push(dir);
}
const component = { components: [{ name: 'Probe', entry: 'client/Probe.tsx', locations: [] }] };

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    writePlugin(WITH_COMPONENT, { frontend: component, shortcodes: [{ tag: 'probegallery' }, { tag: 'bad tag!' }, { tag: 'SHARED' }] });
    writePlugin(NO_COMPONENT, { shortcodes: [{ tag: 'headless' }] });
    writePlugin(INACTIVE, { frontend: component, shortcodes: [{ tag: 'idle' }] });
    writePlugin(SECOND, { frontend: component, shortcodes: [{ tag: 'shared' }, { tag: 'second' }] });
    await require('../core/options').updateOption('active_plugins', [WITH_COMPONENT, NO_COMPONENT, SECOND]);
});

after(async () => {
    for (const dir of created) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
    try { await database.close(); } catch { /* */ }
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

describe('GET /plugins/shortcodes — the front page\'s embeds come from the plugins\' own declarations', () => {
    test('lists active plugins\' declared tags that a site component renders; nothing else', async () => {
        const res = await request(app).get('/api/v1/plugins/shortcodes');
        assert.equal(res.status, 200, 'public: an anonymous front page asks for it');
        const mine = res.body.filter((s: any) => String(s.plugin).endsWith(`-${ID}`));
        const byTag = Object.fromEntries(mine.map((s: any) => [s.tag, s.plugin]));
        assert.equal(byTag.probegallery, WITH_COMPONENT);
        assert.equal(byTag.second, SECOND);
        assert.equal(byTag.headless, undefined, 'a plugin with no site component has nothing to render a tag with');
        assert.equal(byTag.idle, undefined, 'an inactive plugin\'s tags are not offered');
        assert.equal(byTag['bad tag!'], undefined, 'a tag must be an identifier');
        assert.equal(byTag.shared, SECOND < WITH_COMPONENT ? SECOND : WITH_COMPONENT, 'a contested tag goes to the first plugin by slug, once');
        assert.equal(mine.filter((s: any) => s.tag === 'shared').length, 1);
    });

    test('the bundled gallery plugins declare the tags the core used to hardcode', () => {
        const manifest = (slug: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../marketplace/plugins/${slug}/manifest.json`), 'utf8'));
        assert.ok(manifest('card-gallery').shortcodes.some((s: any) => s.tag === 'cards'));
        assert.ok(manifest('video-gallery').shortcodes.some((s: any) => s.tag === 'vgallery'));
        assert.ok(Array.isArray(manifest('card-gallery').frontend.components) && Array.isArray(manifest('video-gallery').frontend.components));
    });
});

describe('photo-carousel [carousel] — plain markup on the core\'s snap-strip, no host initialiser', () => {
    const PLUGIN_DIR = path.resolve(__dirname, '../../../marketplace/plugins/photo-carousel');
    async function shortcodeHandler(store: Record<string, any>) {
        const handlers: Record<string, any> = {};
        const mod: any = { exports: {} };
        const src = fs.readFileSync(path.join(PLUGIN_DIR, 'index.js'), 'utf8');
        const wrapper = require('vm').runInThisContext(`(function (exports, require, module, __filename, __dirname) {${src}\n})`, { filename: path.join(PLUGIN_DIR, 'index.js') });
        wrapper(mod.exports, (spec: string) => require(spec.startsWith('.') ? path.resolve(PLUGIN_DIR, spec) : spec), mod, path.join(PLUGIN_DIR, 'index.js'), PLUGIN_DIR);
        const bridge = {
            options: { async get(k: string, d: any) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d; }, async set() { return true; } },
            http: { route() { /* routes are not under test */ } },
            shortcodes: { add(tag: string, fn: any) { handlers[tag] = fn; } },
            adminMenu: { add() { } },
        };
        (global as any).wordjs = bridge;
        await mod.exports.init(bridge);
        return handlers.carousel;
    }

    test('renders sanitizer-proof markup: the snap-strip classes, escaped attributes, no <style>/<button>/<script>', async () => {
        const render = await shortcodeHandler({
            carousel_c1: { images: [{ url: '/a.jpg', caption: 'First <b>slide</b>' }, '/b.jpg?x="1"'], autoplay: true, interval: 3000 },
        });
        assert.equal(typeof render, 'function', 'the plugin registers [carousel]');
        const html = await render({ id: 'c1' });
        assert.match(html, /^<div class="wjs-snap-strip wjs-snap-strip--16x9 photo-carousel"/);
        assert.equal((html.match(/class="wjs-snap-strip__item"/g) || []).length, 2);
        assert.doesNotMatch(html, /<style|<button|<script|\son\w+=/i, 'nothing the sanitizer strips or a host script would have to wire');
        assert.match(html, /src="\/b\.jpg\?x=&quot;1&quot;"/, 'attribute values are escaped');
        assert.match(html, /<figcaption class="wjs-snap-strip__caption">First &lt;b&gt;slide&lt;\/b&gt;<\/figcaption>/);
        assert.equal(await render({}), '', 'no id, nothing');
        assert.equal(await render({ id: 'missing' }), '');
    });

    test('the core styles the primitive in the framework sheet, without binding `position`', () => {
        const css = fs.readFileSync(path.resolve(__dirname, '../../public/css/wordjs-ui.css'), 'utf8');
        const rules = css.match(/\.wjs-snap-strip[^{]*\{[^}]*\}/g) || [];
        assert.ok(rules.some((r: string) => /scroll-snap-type:\s*x mandatory/.test(r)), 'a scroll-snapping row');
        assert.ok(rules.some((r: string) => /\.wjs-snap-strip__item[^{]*\{[^}]*scroll-snap-align:\s*start/.test(r)));
        for (const r of rules) assert.doesNotMatch(r, /position\s*:/, 'author-usable classes must never bind position (security.style)');
    });

    test('the host no longer ships a photo-carousel initialiser', () => {
        const root = path.resolve(__dirname, '../../../frontend/src');
        assert.equal(fs.existsSync(path.join(root, 'components/content/LegacyCarousels.tsx')), false);
        const post = fs.readFileSync(path.join(root, 'components/public/PostContent.tsx'), 'utf8');
        assert.doesNotMatch(post, /LegacyCarousels|photo-carousel/);
    });
});
