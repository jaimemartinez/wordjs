/**
 * THE ANONYMOUS SIDEBAR RENDER — escaped output, a locked-down response, and keys that resolve.
 *
 * GET /api/v1/widgets/sidebars/:id/render needs no authentication and answers text/html on the API
 * origin (same-origin with the admin). The built-in renderers interpolated editor-controlled values raw
 * — category names (stored verbatim by anyone with manage_categories), post titles, widget titles — so
 * a category named `<img src=x onerror=…>` was stored XSS against whoever opened the URL, admins
 * included. It was masked only by a second bug: instance keys were split on the LAST '-', and
 * addWidgetToSidebar now mints crypto.randomUUID() instance ids (four hyphens), so every widget added
 * since then resolved to an unregistered id and was skipped — the endpoint answered ''.
 *
 * Pinned here:
 *   1. both key shapes render: UUID keys from addWidgetToSidebar and legacy base-36 keys, including
 *      for a widget id that itself contains '-';
 *   2. term names, post titles/slugs and widget titles are escaped in the HTML;
 *   3. the response carries a no-script sandboxing CSP and nosniff;
 *   4. term names are stripped of markup on write (defence in depth), and a markup-only name is a 400.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// CWD in a temp dir and config.dbPath repointed BEFORE the DB layer / routers load.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-widgets-render-'));
process.chdir(TMP_ROOT);
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const PAYLOAD = '<img src=x onerror=alert(document.domain)>';

describe('sidebar render: escaping, headers and instance keys', () => {
    let request: any;
    let app: any;
    let dbAsync: any;
    let W: any;
    let Term: any;

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();
        W = require('../core/widgets');
        Term = require('../models/Term');
        const express = require('express');
        app = express();
        app.use(express.json());
        app.use('/api/v1/widgets', require('../routes/widgets'));
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); } catch { /* ignore */ }
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    const render = (id: string) => request(app).get(`/api/v1/widgets/sidebars/${id}/render`);

    it('parseInstanceKey resolves UUID and legacy keys, longest registered id first', () => {
        W.registerWidget('promo-box', 'Promo', { render: async () => '' });
        W.registerWidget('promo', 'Promo short', { render: async () => '' });
        try {
            const uuid = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
            assert.deepStrictEqual(W.parseInstanceKey(`categories-${uuid}`), { widgetId: 'categories', instanceId: uuid });
            assert.deepStrictEqual(W.parseInstanceKey('categories-lx3k9a'), { widgetId: 'categories', instanceId: 'lx3k9a' });
            assert.deepStrictEqual(W.parseInstanceKey(`promo-box-${uuid}`), { widgetId: 'promo-box', instanceId: uuid });
            assert.deepStrictEqual(W.parseInstanceKey('promo-box-lx3k9a'), { widgetId: 'promo-box', instanceId: 'lx3k9a' });
            assert.deepStrictEqual(W.parseInstanceKey('promo-lx3k9a'), { widgetId: 'promo', instanceId: 'lx3k9a' });
            assert.strictEqual(W.parseInstanceKey('gone-widget-lx3k9a'), null);
        } finally {
            W.unregisterWidget('promo-box');
            W.unregisterWidget('promo');
        }
    });

    it('a widget added with addWidgetToSidebar (UUID key) renders, and so does a legacy key', async () => {
        const key = await W.addWidgetToSidebar('sidebar-1', 'search', { title: 'Find' });
        assert.match(key, /^search-[0-9a-f]{8}-[0-9a-f]{4}-/);
        let r = await render('sidebar-1');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('class="search-form"'), `UUID-keyed widget must render, got: ${JSON.stringify(r.text)}`);
        assert.ok(r.text.includes('<h3 class="widget-title">Find</h3>'));

        await W.setSidebarWidgets('footer-1', ['custom_html-legacy1']);
        await W.setWidgetSettings('custom_html', 'legacy1', { html: '<p>legacy</p>' });
        r = await render('footer-1');
        assert.ok(r.text.includes('<p>legacy</p>'), `legacy-keyed widget must render, got: ${JSON.stringify(r.text)}`);
    });

    it('escapes category names, post titles/slugs and widget titles', async () => {
        // Bypass the write-side stripping on purpose: rows imported before it, or written by any other
        // path, must still come out escaped.
        const cat = await Term.create({ name: 'Placeholder', taxonomy: 'category' });
        await dbAsync.run('UPDATE terms SET name = ?, slug = ? WHERE term_id = ?', [PAYLOAD, 'a"><svg onload=1>', cat.termId]);
        const Post = require('../models/Post');
        const post = await Post.create({ title: 'placeholder', content: 'x', authorId: 1, status: 'publish', type: 'post' });
        await dbAsync.run('UPDATE posts SET post_title = ?, post_name = ? WHERE id = ?', [`<script>alert(1)</script>`, 'p"onmouseover="alert(1)', post.id]);

        await W.setSidebarWidgets('sidebar-1', []);
        await W.addWidgetToSidebar('sidebar-1', 'categories', { title: `</h3>${PAYLOAD}`, hideEmpty: false });
        await W.addWidgetToSidebar('sidebar-1', 'recent_posts', { title: 'Recent', number: 5 });

        const r = await render('sidebar-1');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('class="categories"'), `categories widget must render, got: ${JSON.stringify(r.text)}`);
        assert.ok(r.text.includes('class="recent-posts"'));
        assert.ok(!r.text.includes('<img'), `raw <img> in output: ${r.text}`);
        assert.ok(!r.text.includes('<svg'), `raw <svg> in output: ${r.text}`);
        assert.ok(!r.text.includes('<script'), `raw <script> in output: ${r.text}`);
        assert.ok(!/"\s*onmouseover=/.test(r.text), `attribute break-out in output: ${r.text}`);
        assert.ok(r.text.includes('&lt;img src=x onerror=alert(document.domain)&gt;'));
        assert.ok(r.text.includes('&lt;/h3&gt;&lt;img'), 'the widget title is escaped too');
        assert.ok(r.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    });

    it('serves the fragment with a sandboxing CSP and nosniff', async () => {
        const r = await render('sidebar-1');
        assert.match(r.headers['content-type'], /text\/html/);
        assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
        const csp = String(r.headers['content-security-policy'] || '');
        assert.match(csp, /default-src 'none'/);
        assert.match(csp, /\bsandbox\b/);
        assert.ok(!/script-src/.test(csp), 'no script source may be allowed');
    });

    it('strips markup from term names on write; plain text (including < and &) is kept', async () => {
        const t = await Term.create({ name: `News ${PAYLOAD}<b>!</b>`, taxonomy: 'category' });
        assert.strictEqual(t.name, 'News !');
        const plain = await Term.create({ name: 'R&D < Ops', taxonomy: 'post_tag' });
        assert.strictEqual(plain.name, 'R&D < Ops');
        const updated = await Term.update(t.termId, 'category', { name: `Renamed<script>x</script>` });
        assert.strictEqual(updated.name, 'Renamedx');
        // Markup only: the stored name is kept (no empty UPDATE).
        const kept = await Term.update(t.termId, 'category', { name: PAYLOAD });
        assert.strictEqual(kept.name, 'Renamedx');
        await assert.rejects(() => Term.create({ name: PAYLOAD, taxonomy: 'category' }), /required/);
    });

    it('does not let nested tags splice a new tag together (one pass is not enough)', () => {
        assert.strictEqual(Term.sanitizeName('a<scr<script>ipt>alert(1)</script>b'), 'aalert(1)b');
        assert.strictEqual(Term.sanitizeName('<<img src=x>img src=x onerror=alert(1)>'), '');
        assert.ok(!/<[a-z]/i.test(Term.sanitizeName('<sc<sc<script>ript>ript>x')));
        assert.strictEqual(Term.sanitizeName('R&D < Ops > Sales'), 'R&D < Ops > Sales');
    });
});
