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
 *     of what is installed.
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
                },
            },
        }),
        'index.js': "'use strict';\nmodule.exports = { init() {} };\n",
        'client/admin/page.tsx': 'export default function A() { return null; }\n',
        'client/portal/page.tsx': 'export default function P() { return null; }\n',
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
        assert.deepStrictEqual(res.body, { slug: portalOf(ON), title: 'Probe portal', themeColor: '#2563eb', viewportFit: 'cover' });
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
