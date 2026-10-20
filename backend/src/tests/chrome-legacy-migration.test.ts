/**
 * Legacy chrome → composable chrome (core/chrome-legacy + GET /chrome/:part/legacy + POST
 * /chrome/migrate-legacy).
 *
 * The retired /admin/footer page stored `footer_text`, `footer_copyright` and `footer_socials`; the
 * built-in Footer.tsx rendered them in the theme's layout v2 footer variant, and Header.tsx rendered the
 * theme's header variant. These tests drive the REAL router against a throwaway DB and theme dir and
 * pin the three promises the migration makes:
 *   LOSSLESS    every legacy value reaches the composition verbatim, and the legacy options survive.
 *   IDEMPOTENT  a second run (or a run after the admin edited the result) writes nothing.
 *   HONEST      a site whose theme ships chrome/footer.json is NOT migrated — that file, not the legacy
 *               footer, is what renders there, and a site composition would replace it.
 * Every composition produced must also pass the write authority (validateChromeData).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox the CWD first: core/themes resolves ./themes at module load.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-chrome-legacy-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes', 'plain'), { recursive: true });
fs.mkdirSync(path.join(TMP_ROOT, 'themes', 'composed', 'chrome'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

const FOOTER_TEXT = 'We roast <strong>small batches</strong>.\nVisit <a href="/shop">the shop</a>.';
const COPYRIGHT = '&copy; 2019 Roasters &mdash; <a href="/legal">Legal</a>';

const THEME_FOOTER = {
    root: { props: {} },
    content: [{ type: 'ChromeRow', props: { align: 'center', gap: 'md', items: [{ type: 'ChromeText', props: { text: 'Theme footer' } }] } }],
};

type Block = { type: string; props: Record<string, any> };
function flatten(blocks: Block[]): Block[] {
    const out: Block[] = [];
    for (const b of blocks) {
        out.push(b);
        if (Array.isArray(b.props?.items)) out.push(...flatten(b.props.items));
    }
    return out;
}

describe('legacy chrome conversion (pure builders)', () => {
    const { buildLegacyFooter, buildLegacyHeader } = require('../core/chrome-legacy');
    const { validateChromeData } = require('../core/chrome-validate');

    it('every footer variant/column count converts to a VALID composition that carries the legacy text verbatim', () => {
        const layouts = [
            undefined,
            { footer: { variant: 'columns', columns: 1 } },
            { footer: { variant: 'columns', columns: 2 } },
            { footer: { variant: 'columns', columns: 3 } },
            { footer: { variant: 'columns', columns: 4 } },
            { footer: { variant: 'minimal' } },
        ];
        for (const layout of layouts) {
            for (const asString of [false, true]) {
                const settings = {
                    footer_text: FOOTER_TEXT,
                    footer_copyright: COPYRIGHT,
                    active_theme_layout: asString && layout ? JSON.stringify(layout) : layout,
                };
                const composition = buildLegacyFooter(settings);
                const result = validateChromeData(composition, { part: 'footer' });
                assert.strictEqual(result.ok, true, `${JSON.stringify(layout)}: ${JSON.stringify(result.errors)}`);
                const blocks = flatten(composition.content);
                const html = blocks.filter((b) => b.type === 'ChromeRichText').map((b) => b.props.html);
                // The copyright is in EVERY variant; the footer text only where Footer.tsx shows it (columns).
                assert.ok(html.includes(COPYRIGHT), `${JSON.stringify(layout)}: copyright kept verbatim`);
                if (layout?.footer?.variant !== 'minimal') assert.ok(html.includes(FOOTER_TEXT), `${JSON.stringify(layout)}: footer text kept verbatim`);
                // Socials (footer_socials) and the footer-1 widget area are bound, as Footer.tsx binds them.
                assert.ok(blocks.some((b) => b.type === 'ChromeSocials' && b.props.source === 'settings'));
                assert.ok(blocks.some((b) => b.type === 'ChromeWidgets' && b.props.area === 'footer-1'));
            }
        }
    });

    it('columns: the grid has the theme\'s column count, and the menu/socials keep Footer.tsx\'s headings', () => {
        const composition = buildLegacyFooter({ footer_text: 'x', footer_copyright: '', active_theme_layout: { footer: { columns: 3 } } });
        const grid = composition.content.find((b: Block) => b.type === 'ChromeColumns');
        assert.strictEqual(grid.props.columns, '3');
        const blocks = flatten(composition.content);
        assert.ok(blocks.some((b) => b.type === 'ChromeNav' && b.props.location === 'footer' && b.props.title === 'Quick Links'));
        assert.ok(blocks.some((b) => b.type === 'ChromeSocials' && b.props.title === 'Connect'));
        // An empty legacy field produces no block (Footer.tsx renders nothing for it either).
        assert.strictEqual(blocks.filter((b) => b.type === 'ChromeRichText').length, 1);
    });

    it('every header variant converts to a VALID composition with its sticky/transparent flags', () => {
        const cases: Array<[any, (c: any) => void]> = [
            [undefined, (c) => {
                assert.deepStrictEqual(c.root.props, { sticky: true, transparent: false });
                const row = c.content[0];
                assert.strictEqual(row.props.align, 'between');
                assert.deepStrictEqual(row.props.items.map((b: Block) => b.type), ['ChromeLogo', 'ChromeNav']);
            }],
            [{ header: { variant: 'centered', sticky: false } }, (c) => {
                assert.strictEqual(c.root.props.sticky, false);
                assert.strictEqual(c.content.length, 2);
                assert.ok(c.content.every((r: Block) => r.props.align === 'center'));
            }],
            [{ header: { variant: 'minimal', transparent: true } }, (c) => {
                assert.strictEqual(c.root.props.transparent, true);
                const nav = flatten(c.content).find((b) => b.type === 'ChromeNav');
                assert.strictEqual(nav?.props.collapse, 'always', 'minimal keeps the nav in the drawer at every width');
            }],
        ];
        for (const [layout, check] of cases) {
            const c = buildLegacyHeader({ active_theme_layout: layout });
            const result = validateChromeData(c, { part: 'header' });
            assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
            check(c);
        }
    });
});

describe('legacy chrome API (GET /chrome/:part/legacy, POST /chrome/migrate-legacy)', () => {
    let request: any;
    let app: any;
    let adminToken: string;
    let subscriberToken: string;
    let options: any;

    const asAdmin = (r: any) => r.set('Authorization', `Bearer ${adminToken}`);
    const stored = async () => {
        const v = await options.getOption('site_chrome_footer', '');
        return typeof v === 'string' ? v : JSON.stringify(v);
    };

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        const dbAsync = database.getDbAsync();
        for (const login of ['admin', 'subscriber']) {
            await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`, [login, 'x', `${login}@example.com`, login]);
        }
        const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);
        const sub = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'subscriber'`);
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [admin.id]);
        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
        subscriberToken = jwt.sign({ userId: sub.id, username: 'subscriber' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        options = require('../core/options');
        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json());
        app.use('/api/v1/chrome', require('../routes/chrome'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('both endpoints are admin-only and write nothing for anyone else', async () => {
        await options.updateOption('footer_copyright', COPYRIGHT);
        assert.strictEqual((await request(app).get('/api/v1/chrome/footer/legacy')).status, 401);
        assert.strictEqual((await request(app).post('/api/v1/chrome/migrate-legacy')).status, 401);
        const sub = (r: any) => r.set('Authorization', `Bearer ${subscriberToken}`);
        assert.strictEqual((await sub(request(app).get('/api/v1/chrome/footer/legacy'))).status, 403);
        assert.strictEqual((await sub(request(app).post('/api/v1/chrome/migrate-legacy'))).status, 403);
        assert.strictEqual(await stored(), '');
    });

    it('GET /chrome/:part/legacy answers the converted header/footer, and 400 for the announcement bar', async () => {
        await options.updateOption('footer_text', FOOTER_TEXT);
        const footer = await asAdmin(request(app).get('/api/v1/chrome/footer/legacy'));
        assert.strictEqual(footer.status, 200);
        const html = flatten(footer.body.data.content).filter((b) => b.type === 'ChromeRichText').map((b) => b.props.html);
        assert.deepStrictEqual(html.sort(), [COPYRIGHT, FOOTER_TEXT].sort());
        const header = await asAdmin(request(app).get('/api/v1/chrome/header/legacy'));
        assert.strictEqual(header.status, 200);
        assert.strictEqual(header.body.data.content[0].type, 'ChromeRow');
        assert.strictEqual((await asAdmin(request(app).get('/api/v1/chrome/announcement/legacy'))).status, 400);
        assert.strictEqual(await stored(), '', 'the read endpoint never writes');
    });

    it('a theme that ships chrome/footer.json is NOT migrated — its file is what renders', async () => {
        fs.writeFileSync(path.join(TMP_ROOT, 'themes', 'composed', 'chrome', 'footer.json'), JSON.stringify(THEME_FOOTER));
        await options.updateOption('template', 'composed');
        const res = await asAdmin(request(app).post('/api/v1/chrome/migrate-legacy'));
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.footer, 'theme-composition');
        assert.strictEqual(await stored(), '');
    });

    it('migrates the legacy footer losslessly, then is idempotent', async () => {
        await options.updateOption('template', 'plain'); // no chrome/ → Footer.tsx is what renders
        await options.updateOption('active_theme_layout', JSON.stringify({ footer: { variant: 'columns', columns: 3 } }));
        const first = await asAdmin(request(app).post('/api/v1/chrome/migrate-legacy'));
        assert.strictEqual(first.status, 200);
        assert.strictEqual(first.body.footer, 'migrated');
        assert.strictEqual(first.body.header, 'nothing-to-migrate');

        const { buildLegacyFooter } = require('../core/chrome-legacy');
        const { validateChromeData } = require('../core/chrome-validate');
        const written = await stored();
        assert.ok(validateChromeData(written, { part: 'footer' }).ok, 'the stored composition passes the write authority');
        assert.deepStrictEqual(JSON.parse(written), buildLegacyFooter({
            footer_text: FOOTER_TEXT,
            footer_copyright: COPYRIGHT,
            active_theme_layout: { footer: { variant: 'columns', columns: 3 } },
        }));
        // Lossless: the legacy options are untouched (deleting the composition restores the old footer).
        assert.strictEqual(await options.getOption('footer_text', ''), FOOTER_TEXT);
        assert.strictEqual(await options.getOption('footer_copyright', ''), COPYRIGHT);

        // Idempotent: a second run changes nothing…
        const second = await asAdmin(request(app).post('/api/v1/chrome/migrate-legacy'));
        assert.strictEqual(second.body.footer, 'site-composition');
        assert.strictEqual(await stored(), written);

        // …and never overwrites what the admin made of it afterwards.
        const edited = JSON.stringify(THEME_FOOTER);
        await options.updateOption('site_chrome_footer', edited);
        await options.updateOption('footer_text', 'changed later');
        const third = await asAdmin(request(app).post('/api/v1/chrome/migrate-legacy'));
        assert.strictEqual(third.body.footer, 'site-composition');
        assert.strictEqual(await stored(), edited);
    });

    it('a site with no legacy text has nothing to migrate and writes nothing', async () => {
        await options.deleteOption('site_chrome_footer');
        await options.updateOption('footer_text', '');
        await options.updateOption('footer_copyright', '   ');
        const res = await asAdmin(request(app).post('/api/v1/chrome/migrate-legacy'));
        assert.strictEqual(res.body.footer, 'nothing-to-migrate');
        assert.strictEqual(await stored(), '');
    });
});
