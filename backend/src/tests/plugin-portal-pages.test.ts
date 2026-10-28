/**
 * PLUGIN PORTAL PAGES — the standalone public page a plugin declares in frontend.portalPage, mounted by the
 * frontend at /portal/<slug> (core/portal-pages.ts, routes/plugin-bundles.ts).
 *
 * What must hold:
 *   · the declaration is validated (its slug and entry are written into generated TypeScript, its title
 *     and theme colour into a <head>), and two installed plugins never claim the same portal slug;
 *   · the portal is resolved by its PORTAL slug alone — never by folder name, never by admin-page slug —
 *     among ACTIVE plugins, so a folder that shares a portal's name cannot answer for it;
 *   · GET /plugins/<slug>/portal and the portal bundle routes apply the gate every plugin bundle has
 *     (active + browser:script), and every refusal is the SAME anonymous answer, so they are no inventory
 *     of what is installed;
 *   · a portal's sub-pages, service worker and file route (what lets a portal such as the conference one live in
 *     its plugin) are validated the same way, and GET /plugins/<slug>/portal/sw serves only the declared worker,
 *     inside the plugin's client/ tree, behind the same gate.
 *
 * Same harness as plugin-public-footprint.test.ts: the real app from ../index with a throwaway SQLite
 * file (the gate reads the real `active_plugins` option), probe plugins as real folders under the real
 * backend/plugins, removed afterwards.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-portal-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const request = require('supertest');
const database = require('../config/database');
const app = require('../index');

const configManager = require('../core/configManager');
const realIsInstalled = configManager.isInstalled;
const realGetConfig = configManager.getConfig;
configManager.isInstalled = () => true;
configManager.getConfig = () => ({ installedAt: '2020-01-01T00:00:00.000Z', dbDriver: config.dbDriver });

const portalPages = require('../core/portal-pages');

const API = config.api.prefix;
const PLUGINS_ROOT = path.resolve('./plugins'); // index.ts installPath('plugins'); the suite runs from backend/

const PID = process.pid;
const ON = `wjs-pp-on-${PID}`;        // active, granted browser:script
const OFF = `wjs-pp-off-${PID}`;      // installed, INACTIVE, still granted
const NG = `wjs-pp-ng-${PID}`;        // active, NOT granted browser:script
const PROBES = [ON, OFF, NG];
const portalOf = (folder: string) => `portal-${folder.replace('wjs-pp-', '')}`;
const adminOf = (folder: string) => `${folder}-admin`;

let options: any;
let memberId = 0;

function writeProbe(folder: string) {
    const dir = path.join(PLUGINS_ROOT, folder);
    const files: Record<string, string> = {
        'manifest.json': JSON.stringify({
            name: `Probe ${folder}`, version: '9.8.7', author: 'Probe Author', isolated: true,
            permissions: [{ scope: 'browser', access: 'script', reason: 'Probe UI.' }],
            frontend: {
                adminPage: { entry: 'client/admin/page.tsx', slug: adminOf(folder) },
                portalPage: {
                    entry: 'client/portal/page.tsx', slug: portalOf(folder),
                    title: 'Probe portal', themeColor: '#2563eb', viewportFit: 'cover',
                    serviceWorker: 'client/portal/sw.js', file: '/public/file',
                    pages: { me: { title: 'My page', private: true, app: { name: 'My page', backgroundColor: '#ffffff', icon: 'public/icon-512.png' } } },
                },
            },
        }),
        'index.js': "'use strict';\nmodule.exports = { init() {} };\n",
        'client/admin/page.tsx': 'export default function A() { return null; }\n',
        'client/portal/page.tsx': 'export default function P() { return null; }\n',
        'client/portal/sw.js': "self.addEventListener('push', () => {});\n",
        'dist/admin.bundle.js': 'export default function A() { return null; }\n',
        'dist/portal.bundle.js': 'export default function P() { return null; }\n',
        'dist/portal.bundle.css': '.portal-probe{}',
    };
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), body);
    }
}

/** Same status, same body: a caller cannot tell the two refusals apart. */
function assertSameAnswer(a: any, b: any, what: string) {
    assert.strictEqual(a.status, b.status, `${what}: status`);
    assert.strictEqual(a.text, b.text, `${what}: body`);
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await require('../core/roles').loadRoles();
    options = require('../core/options');
    const perms = require('../core/plugin-permissions');
    await perms.loadGrants();
    for (const folder of PROBES) writeProbe(folder);
    perms._setGrantsInMemory(ON, ['browser:script']);
    perms._setGrantsInMemory(OFF, ['browser:script']);
    perms._setGrantsInMemory(NG, []);
    await options.updateOption('active_plugins', [ON, NG]);
    // A signed-in user who is no administrator (GET /plugins/portals needs only a session).
    const r = await database.getDbAsync().run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        [`pp-member-${PID}`, 'x', `pp-member-${PID}@example.com`, 'Member']);
    memberId = r.lastID;
    await database.getDbAsync().run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'subscriber')`, [memberId]);
});

after(async () => {
    for (const folder of PROBES) { try { fs.rmSync(path.join(PLUGINS_ROOT, folder), { recursive: true, force: true }); } catch { /* */ } }
    configManager.isInstalled = realIsInstalled;
    configManager.getConfig = realGetConfig;
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

describe('frontend.portalPage: the declaration', () => {
    const withPage = (portalPage: unknown) => ({ frontend: { portalPage } });

    it('accepts a well-formed declaration, and no declaration at all', () => {
        assert.deepStrictEqual(portalPages.validatePortalPage({}), []);
        assert.deepStrictEqual(portalPages.validatePortalPage(withPage({ entry: 'client/portal/page.tsx', slug: 'field-portal' })), []);
        assert.deepStrictEqual(portalPages.validatePortalPage(withPage({
            entry: './client/portal/page.tsx', slug: 'conference', title: 'Field portal — Teams', themeColor: '#2563eb', viewportFit: 'cover',
        })), []);
    });

    it('refuses a slug that is not one lowercase URL segment', () => {
        for (const slug of ['', 'Upper', 'a/b', '-lead', 'trail-', 'with_underscore', '../x', 'a'.repeat(65), 42]) {
            assert.ok(portalPages.validatePortalPage(withPage({ entry: 'client/portal/page.tsx', slug })).length > 0, `slug ${JSON.stringify(slug)}`);
        }
    });

    it('refuses an entry outside the plugin\'s client/ tree', () => {
        for (const entry of ['../../etc/page.tsx', 'client/../../x.tsx', '/abs/page.tsx', 'server/page.tsx', 'client/portal/page.css', 'client/"x".tsx']) {
            assert.ok(portalPages.validatePortalPage(withPage({ entry, slug: 'ok' })).length > 0, `entry ${entry}`);
        }
    });

    it('refuses head details that could carry markup', () => {
        const base = { entry: 'client/portal/page.tsx', slug: 'ok' };
        for (const extra of [{ title: '</title><script>' }, { title: '' }, { title: 'x'.repeat(121) }, { themeColor: 'red;}' }, { themeColor: 'url(x)' }, { viewportFit: 'cover;x' }]) {
            assert.ok(portalPages.validatePortalPage(withPage({ ...base, ...extra })).length > 0, JSON.stringify(extra));
        }
    });

    it('validates sub-pages, the service worker and the file route', () => {
        const base = { entry: 'client/portal/page.tsx', slug: 'ok' };
        assert.deepStrictEqual(portalPages.validatePortalPage(withPage({
            ...base, serviceWorker: './client/portal/sw.js', file: '/public/badge/file',
            pages: { yo: { title: 'Mi inscripción', private: true, app: { name: 'Mi inscripción', shortName: 'Yo', description: 'Tu página.', backgroundColor: '#f3f4f6', themeColor: '#111827' } }, badge: { private: false } },
        })), []);
        for (const extra of [
            { serviceWorker: 'client/../sw.js' }, { serviceWorker: 'server/sw.js' }, { serviceWorker: 'client/sw.ts' }, { serviceWorker: '/abs/client/sw.js' },
            { file: 'public/x' }, { file: '/admin/x' }, { file: '/public/../x' }, { file: '/public/x?y=1' }, { file: 'https://evil.example/public/x' },
            { pages: [] }, { pages: { file: {} } }, { pages: { 'Up': {} } }, { pages: { 'a/b': {} } },
            { pages: { yo: { title: '<script>' } } }, { pages: { yo: { private: 'yes' } } }, { pages: { yo: { extra: 1 } } },
            { pages: { yo: { app: { name: '' } } } }, { pages: { yo: { app: { name: 'x', themeColor: 'red' } } } }, { pages: { yo: { app: { name: 'x', icons: [] } } } },
            { pages: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, {}])) },
        ]) {
            assert.ok(portalPages.validatePortalPage(withPage({ ...base, ...extra })).length > 0, JSON.stringify(extra).slice(0, 120));
        }
        // The head says WHETHER a worker or a file route exists, never their paths.
        const head = portalPages.portalPageHead(withPage({ ...base, serviceWorker: 'client/sw.js', file: '/public/f', pages: { me: { title: 'T', private: true, app: { name: 'N' } } } }));
        assert.deepStrictEqual(head, { serviceWorker: true, file: true, pages: { me: { title: 'T', private: true, app: { name: 'N' } } } });
    });

    it('validates an app icon: a .png under public/, nothing else', () => {
        const base = { entry: 'client/portal/page.tsx', slug: 'ok' };
        const withIcon = (icon: unknown) => withPage({ ...base, pages: { yo: { app: { name: 'x', icon } } } });
        for (const icon of ['public/icon.png', './public/icon-512.png', 'public/img/app_icon.v2.png']) {
            assert.deepStrictEqual(portalPages.validatePortalPage(withIcon(icon)), [], icon);
        }
        for (const icon of [
            'public/../manifest.png', 'public/a/../../x.png', '../public/x.png',
            '/public/x.png', '\\public\\x.png', 'public\\x.png', 'C:/public/x.png', 'https://evil.example/public/x.png', '//evil.example/x.png',
            'public/icon.svg', 'public/icon.jpg', 'public/icon.PNG', 'public/icon.png?x=1', 'public/.png', 'public/.hidden.png',
            'client/icon.png', 'data/icon.png', 'icon.png', 'public/', 'public//x.png', '', 1, null, ['public/x.png'],
        ]) {
            const problems = portalPages.validatePortalPage(withIcon(icon));
            assert.ok(problems.some((p: string) => /app\.icon/.test(p)), JSON.stringify(icon));
        }
        // The head gives the icon's URL on the static /plugins mount (under the plugin FOLDER), and only then.
        const manifest = withPage({ ...base, pages: { yo: { app: { name: 'N', icon: './public/icon.png' } }, no: { app: { name: 'M' } } } });
        assert.deepStrictEqual(portalPages.portalPageHead(manifest, 'my-plugin').pages, {
            yo: { app: { name: 'N', icon: '/plugins/my-plugin/public/icon.png' } }, no: { app: { name: 'M' } },
        });
        assert.deepStrictEqual(portalPages.portalPageHead(manifest).pages, { yo: { app: { name: 'N' } }, no: { app: { name: 'M' } } });
    });

    it('a portal slug belongs to one installed plugin', () => {
        const installed = new Map<string, string | null>([['plugin-a', 'shared'], ['plugin-b', null]]);
        const manifest = withPage({ entry: 'client/portal/page.tsx', slug: 'shared' });
        assert.match(String(portalPages.portalPageConflict('plugin-b', manifest, installed)), /already the portal page of the installed plugin "plugin-a"/);
        assert.strictEqual(portalPages.portalPageConflict('plugin-a', manifest, installed), null, 'its own declaration is not a conflict');
        assert.match(String(portalPages.portalPageConflict('plugin-b', withPage({ entry: 'x.tsx', slug: 'free' }), installed)), /entry/);
    });

    it('resolves a portal slug to the ONE active plugin declaring it', () => {
        const manifests: Record<string, any> = {
            a: withPage({ entry: 'client/p.tsx', slug: 'one' }),
            b: withPage({ entry: 'client/p.tsx', slug: 'two' }),
            c: withPage({ entry: 'client/p.tsx', slug: 'two' }),
            d: withPage({ entry: '../p.tsx', slug: 'bad' }),
        };
        const read = (f: string) => manifests[f];
        assert.strictEqual(portalPages.portalPageFolder('one', ['a', 'b'], read), 'a');
        assert.strictEqual(portalPages.portalPageFolder('one', ['b'], read), null, 'inactive plugins are not candidates');
        assert.strictEqual(portalPages.portalPageFolder('two', ['a', 'b', 'c'], read), null, 'a slug two plugins claim is nobody\'s');
        assert.strictEqual(portalPages.portalPageFolder('bad', ['d'], read), null, 'an invalid declaration serves nothing');
        assert.strictEqual(portalPages.portalPageFolder('a', ['a'], read), null, 'never by folder name');
    });
});

describe('GET /plugins/:slug/portal', () => {
    it('describes the portal of an active, granted plugin — only its head details', async () => {
        const res = await request(app).get(`${API}/plugins/${portalOf(ON)}/portal`);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body, {
            slug: portalOf(ON), title: 'Probe portal', themeColor: '#2563eb', viewportFit: 'cover',
            serviceWorker: true,
            pages: { me: { title: 'My page', private: true, app: { name: 'My page', backgroundColor: '#ffffff', icon: `/plugins/${ON}/public/icon-512.png` } } },
            // The plugin's own public route, under its FOLDER (plugin routes are mounted there).
            fileEndpoint: `/plugin/${ON}/public/file`,
        });
        assert.match(String(res.headers['cache-control']), /no-store/);
    });

    it('answers every other slug with the same 404', async () => {
        const unknown = await request(app).get(`${API}/plugins/never-installed-portal/portal`);
        assert.strictEqual(unknown.status, 404);
        for (const slug of [portalOf(OFF), portalOf(NG), ON, adminOf(ON), 'Bad_Slug']) {
            assertSameAnswer(await request(app).get(`${API}/plugins/${slug}/portal`), unknown, slug);
        }
    });
});

describe('GET /plugins/portals', () => {
    it('lists, to a signed-in user, exactly the portals that are served, with their titles', async () => {
        const anonymous = await request(app).get(`${API}/plugins/portals`);
        assert.strictEqual(anonymous.status, 401, 'no inventory for anonymous callers');
        const { generateToken } = require('../middleware/auth');
        const token = generateToken({ id: memberId, userLogin: `pp-member-${PID}` });
        const res = await request(app).get(`${API}/plugins/portals`).set('Authorization', `Bearer ${token}`);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const mine = res.body.filter((p: any) => String(p.slug).startsWith('portal-') && String(p.slug).endsWith(String(PID)));
        // The inactive plugin and the one not granted browser:script are not served, so not listed.
        assert.deepStrictEqual(mine, [{ slug: portalOf(ON), title: 'Probe portal' }]);
        assert.match(String(res.headers['cache-control']), /no-store/);
    });
});

describe('GET /plugins/:slug/portal/sw', () => {
    it('serves the declared service worker as-is, as JavaScript, revalidated and never sniffed', async () => {
        const res = await request(app).get(`${API}/plugins/${portalOf(ON)}/portal/sw`);
        assert.strictEqual(res.status, 200);
        assert.match(String(res.headers['content-type']), /^text\/javascript/);
        assert.strictEqual(res.headers['cache-control'], 'no-cache');
        assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
        assert.strictEqual(res.text, "self.addEventListener('push', () => {});\n");
    });

    it('answers the same 404 for every other slug, and for a declared worker that is missing', async () => {
        const unknown = await request(app).get(`${API}/plugins/never-installed-portal/portal/sw`);
        assert.strictEqual(unknown.status, 404);
        for (const slug of [portalOf(OFF), portalOf(NG), ON, adminOf(ON), 'Bad_Slug']) {
            assertSameAnswer(await request(app).get(`${API}/plugins/${slug}/portal/sw`), unknown, slug);
        }
        const sw = path.join(PLUGINS_ROOT, ON, 'client/portal/sw.js');
        const body = fs.readFileSync(sw);
        fs.rmSync(sw);
        try {
            assertSameAnswer(await request(app).get(`${API}/plugins/${portalOf(ON)}/portal/sw`), unknown, 'missing worker');
        } finally { fs.writeFileSync(sw, body); }
    });
});

describe('the portal bundle is resolved by the portal slug, behind the bundle gate', () => {
    it('serves dist/portal.bundle.js and its stylesheet for the portal slug', async () => {
        const js = await request(app).get(`${API}/plugins/${portalOf(ON)}/bundle?type=portal`);
        assert.strictEqual(js.status, 200);
        assert.match(js.text, /function P/);
        const css = await request(app).get(`${API}/plugins/${portalOf(ON)}/bundle/css?type=portal`);
        assert.strictEqual(css.status, 200);
        assert.strictEqual(css.text, '.portal-probe{}');
    });

    it('refuses the portal bundle by folder or admin slug, for an inactive plugin and without the grant', async () => {
        const unknown = await request(app).get(`${API}/plugins/never-installed-portal/bundle?type=portal`);
        assert.strictEqual(unknown.status, 404);
        for (const slug of [ON, adminOf(ON), portalOf(OFF), portalOf(NG)]) {
            assertSameAnswer(await request(app).get(`${API}/plugins/${slug}/bundle?type=portal`), unknown, `bundle ${slug}`);
        }
        const unknownCss = await request(app).get(`${API}/plugins/never-installed-portal/bundle/css?type=portal`);
        assert.strictEqual(unknownCss.status, 404);
        for (const slug of [ON, portalOf(OFF), portalOf(NG)]) {
            assertSameAnswer(await request(app).get(`${API}/plugins/${slug}/bundle/css?type=portal`), unknownCss, `css ${slug}`);
        }
    });

    it('a portal slug does not reach the other bundles', async () => {
        const res = await request(app).get(`${API}/plugins/${portalOf(ON)}/bundle?type=admin`);
        assert.strictEqual(res.status, 404);
        // ...which the admin slug still reaches, as before.
        assert.strictEqual((await request(app).get(`${API}/plugins/${adminOf(ON)}/bundle?type=admin`)).status, 200);
    });
});
