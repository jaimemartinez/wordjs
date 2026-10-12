/**
 * THE PUBLIC FOOTPRINT OF THE PLUGIN INSTALL — what an anonymous caller can learn about which plugins sit
 * on disk, and in which versions, from the URLs the host serves without asking who is calling.
 *
 * The static /plugins mount (index.ts) answered anonymous requests for EVERY INSTALLED plugin, active or
 * not:
 *   · /plugins/<slug>/manifest.json handed out name, exact version, author, requested permissions and
 *     dependencies — the inventory an attacker matches against known-vulnerable versions;
 *   · /plugins/<slug>/client/admin/admin.css, dist/component.bundle.css and public/** confirmed that a
 *     slug was installed even while it was deactivated;
 *   · a slug→folder rewrite in front of the mount resolved the admin-page slug of an INACTIVE plugin, and
 *     scanned every installed manifest for a segment it did not recognise (a timing difference between
 *     "installed" and "not installed").
 * The bundle routes (#403) had the same oracle in a different shape: an unknown slug answered
 * /bundle/css with a 200 empty stylesheet while an installed-but-inactive plugin got a 404, and /bundle
 * answered the two with different bodies.
 *
 * WHY THE REAL app FROM ../index, WITH A DATABASE. The defects are properties of the static mount and of
 * the middleware order in index.ts (a suite that builds its own express() has no /plugins mount), and
 * the gate reads the real `active_plugins` option and the real session — so the active list, the grants
 * and the signed-in users below are real rows in a throwaway SQLite file, not stubs. The install guard is
 * stubbed in memory exactly as public-surface-hardening.test.ts does (see the note there).
 *
 * The probe plugins are real folders under the real backend/plugins (both the static mount and the
 * bundle router resolve that directory themselves), under names nothing else uses, removed afterwards.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-footprint-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const database = require('../config/database');
const app = require('../index');

const configManager = require('../core/configManager');
const realIsInstalled = configManager.isInstalled;
const realGetConfig = configManager.getConfig;
configManager.isInstalled = () => true;
configManager.getConfig = () => ({ installedAt: '2020-01-01T00:00:00.000Z', dbDriver: config.dbDriver });

const API = config.api.prefix;
const PLUGINS_ROOT = path.resolve('./plugins'); // index.ts installPath('plugins'); the suite runs from backend/

const PID = process.pid;
const ON = `wjs-fp-on-${PID}`;        // active, granted browser:script
const OFF = `wjs-fp-off-${PID}`;      // installed, INACTIVE, still granted (grants outlive deactivation)
const NG = `wjs-fp-ng-${PID}`;        // active, NOT granted browser:script
const NOPE = `wjs-fp-nope-${PID}`;    // never installed
const PROBES = [ON, OFF, NG];
const adminSlugOf = (slug: string) => `${slug}-page`;

let options: any, perms: any;
let adminCookie = '', subscriberCookie = '';
// A subscriber's capabilities without access_admin_panel: signed in, but not an admin-panel user.
let noPanelCookie = '';
const NO_PANEL_ROLE = `wjs_fp_nopanel_${process.pid}`;
// The non-administrators who open a plugin's admin page in practice — conference-manager's team (2.15.0)
// is made of subscribers, authors and editors, plus users of a role a plugin defines that carries only
// access_admin_panel. #410 compiles that page's Tailwind classes into client/admin/admin.css; it must
// reach every one of them, or their screens render without the classes (the transparent scanner).
const teamCookies: Record<string, string> = {};
const PLUGIN_TEAM_ROLE = `wjs_fp_team_${process.pid}`;

function writeProbe(slug: string) {
    const dir = path.join(PLUGINS_ROOT, slug);
    const files: Record<string, string> = {
        'manifest.json': JSON.stringify({
            name: `Probe ${slug}`, version: '9.8.7', author: 'Probe Author', isolated: true,
            permissions: [{ scope: 'browser', access: 'script', reason: 'Probe UI.' }],
            dependencies: { 'left-pad': '^1.0.0' },
            frontend: { adminPage: { entry: 'client/admin/page.tsx', slug: adminSlugOf(slug) } },
            theme: { accent: '#123456', 'bad key': 'dropped', nested: { no: 1 } },
        }),
        'index.js': "'use strict';\nmodule.exports = { init() {} };\n",
        'public/probe.css': '.probe{}',
        'client/admin/admin.css': '.admin-probe{}',
        'client/admin/page.tsx': 'export default function P() { return null; }\n',
        'dist/component.bundle.css': '.block-probe{}',
        'dist/component.bundle.js': 'export const versoComponents = {};\n',
        // Exactly the shape backend/scripts/build-plugin.js writes, version included: the field the
        // anonymous /bundle/manifest route must never pass through. (Plus two entries no build would
        // write, to prove the route lists only names it would itself serve.)
        'dist/manifest.build.json': JSON.stringify({
            slug, bundles: ['component.bundle.js', '../../wordjs-config.json', 42],
            externals: ['react'], version: '9.8.7',
        }),
        // What the path allowlist must keep off the mount even for an ACTIVE, GRANTED plugin: private
        // runtime data (the shape of mail-server's data/), a file dropped at runtime, a source map, a
        // document that would run in this origin.
        'data/secret.txt': 'encryption key material',
        'data/bayes.json': '{"spam":{}}',
        'data/attachments/msg.eml': 'From: victim@example.com',
        'leak.txt': 'exfiltrated',
        'public/probe.css.map': '{"version":3}',
        'public/probe.html': '<script>alert(1)</script>',
    };
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), body);
    }
}

async function setActive(list: string[]) {
    await options.updateOption('active_plugins', list);
}

/**
 * The headers that do not vary per request — what a caller could compare between two refusals. Volatile
 * by construction: the date, the rate limiter's running count, and the random value of a CSRF cookie
 * the session middleware sets (its NAME is kept: whether one is set is part of the answer).
 */
function stableHeaders(res: any): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
        if (k === 'date' || k.includes('request-id') || k === 'ratelimit-remaining' || k === 'ratelimit-reset') continue;
        out[k] = k === 'set-cookie'
            ? ([] as string[]).concat(v as any).map((c) => String(c).split('=')[0]).join(',')
            : String(v);
    }
    return out;
}

/** Same status, same body, same headers: a caller cannot tell the two answers apart. */
function assertSameAnswer(a: any, b: any, what: string) {
    assert.strictEqual(a.status, b.status, `${what}: status`);
    assert.strictEqual(a.text, b.text, `${what}: body`);
    assert.deepStrictEqual(stableHeaders(a), stableHeaders(b), `${what}: headers`);
}

/**
 * Run `fn` and return every plugin-tree path the fs module was asked about meanwhile (sync and async
 * entry points alike: `send` uses fs.stat, the old rewrite used existsSync/readdirSync/readFileSync).
 */
async function pluginTreeTouches(fn: () => Promise<unknown>): Promise<string[]> {
    const names = ['existsSync', 'statSync', 'lstatSync', 'readdirSync', 'readFileSync', 'realpathSync',
        'stat', 'lstat', 'readdir', 'readFile', 'open', 'createReadStream'];
    const root = PLUGINS_ROOT.toLowerCase();
    const seen: string[] = [];
    const saved: Record<string, any> = {};
    for (const n of names) {
        saved[n] = fs[n];
        fs[n] = function (this: any, p: any, ...rest: any[]) {
            if (typeof p === 'string' || Buffer.isBuffer(p)) {
                const abs = path.resolve(String(p)).toLowerCase();
                if (abs === root || abs.startsWith(root + path.sep)) {
                    seen.push(path.relative(root, abs).split(path.sep).join('/'));
                }
            }
            return saved[n].call(this, p, ...rest);
        };
    }
    try { await fn(); } finally { for (const n of names) fs[n] = saved[n]; }
    return seen;
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    const db = database.getDbAsync();
    await require('../core/roles').loadRoles();
    options = require('../core/options');
    perms = require('../core/plugin-permissions');
    await perms.loadGrants();
    const seed = async (login: string, role: string) => {
        const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            [login, 'x', `${login}@example.com`, login]);
        await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
        const token = jwt.sign({ userId: r.lastID, username: login }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
        // The session COOKIE: what a <link rel=stylesheet> and a same-origin fetch actually carry.
        return `wordjs_token=${token}`;
    };
    adminCookie = await seed('fpadmin', 'administrator');
    subscriberCookie = await seed('fpsubscriber', 'subscriber');
    await require('../core/roles').setRole(PLUGIN_TEAM_ROLE, { name: 'Probe team', capabilities: ['read', 'access_admin_panel'] });
    teamCookies.subscriber = subscriberCookie;
    for (const role of ['author', 'editor', PLUGIN_TEAM_ROLE]) teamCookies[role] = await seed(`fp${role.replace(/[^a-z]/g, '')}`, role);
    await require('../core/roles').setRole(NO_PANEL_ROLE, { name: 'Probe reader', capabilities: ['read'] });
    noPanelCookie = await seed('fpnopanel', NO_PANEL_ROLE);
    for (const slug of PROBES) writeProbe(slug);
    perms._setGrantsInMemory(ON, ['browser:script']);
    perms._setGrantsInMemory(OFF, ['browser:script']);
    perms._setGrantsInMemory(NG, []);
    await setActive([ON, NG]);
});

after(async () => {
    for (const slug of PROBES) { try { fs.rmSync(path.join(PLUGINS_ROOT, slug), { recursive: true, force: true }); } catch { /* */ } }
    configManager.isInstalled = realIsInstalled;
    configManager.getConfig = realGetConfig;
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

describe('precondition', () => {
    it('runs against an installed site with a real active list', async () => {
        assert.deepStrictEqual(await options.getOption('active_plugins', []), [ON, NG]);
        const r = await request(app).get(`${API}/plugins/active`);
        assert.strictEqual(r.status, 200, 'the API prefix must reach its routers (not a 503 setup_required)');
        assert.ok(r.body.includes(ON) && !r.body.includes(OFF), 'the active list is what the gate reads');
    });
});

describe('static /plugins: manifest.json is never served', () => {
    it('404s the manifest of an ACTIVE and of an INACTIVE plugin, anonymously and to an administrator', async () => {
        for (const slug of [ON, OFF, NG]) {
            for (const cookie of [null, adminCookie]) {
                const req = request(app).get(`/plugins/${slug}/manifest.json`);
                const r = cookie ? await req.set('Cookie', cookie) : await req;
                assert.strictEqual(r.status, 404, `${slug}/manifest.json (${cookie ? 'admin' : 'anonymous'})`);
                assert.ok(!r.text.includes('9.8.7') && !r.text.includes('Probe Author'), 'no manifest bytes');
            }
        }
        // The in-tree plugin too: the rule is not probe-specific.
        assert.strictEqual((await request(app).get('/plugins/hello-world/manifest.json')).status, 404);
    });
});

describe('static /plugins: public/** only for an ACTIVE plugin', () => {
    it('serves an active plugin\'s public asset', async () => {
        const r = await request(app).get(`/plugins/${ON}/public/probe.css`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.text, '.probe{}');
        assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    });

    it('404s an inactive plugin\'s public asset exactly like a plugin that was never installed', async () => {
        const off = await request(app).get(`/plugins/${OFF}/public/probe.css`);
        const nope = await request(app).get(`/plugins/${NOPE}/public/probe.css`);
        assert.strictEqual(off.status, 404);
        assertSameAnswer(off, nope, 'inactive vs never installed');
    });

    it('refuses without touching the plugin tree, so "installed" costs the same as "not installed"', async () => {
        // The old slug→folder rewrite stat'ed <segment>/manifest.json and, on a miss, read every manifest
        // on disk; the file layer then stat'ed the asset. A refusal now happens before any of it.
        for (const url of [`/plugins/${OFF}/public/probe.css`, `/plugins/${NOPE}/public/probe.css`,
            `/plugins/${adminSlugOf(OFF)}/public/probe.css`, `/plugins/${OFF}/dist/component.bundle.css`]) {
            const touched = await pluginTreeTouches(async () => {
                assert.strictEqual((await request(app).get(url)).status, 404, url);
            });
            assert.deepStrictEqual(touched, [], `${url} must be refused before the filesystem is consulted`);
        }
    });

    it('stops serving at the next request after a deactivation, and resumes on reactivation', async () => {
        await setActive([NG]);
        try {
            assert.strictEqual((await request(app).get(`/plugins/${ON}/public/probe.css`)).status, 404);
        } finally {
            await setActive([ON, NG]);
        }
        assert.strictEqual((await request(app).get(`/plugins/${ON}/public/probe.css`)).status, 200);
    });
});

describe('static /plugins: for an ACTIVE, GRANTED plugin the path allowlist still decides', () => {
    // The activity gate answers 404 for an inactive plugin before the allowlist matters, so a refusal
    // asserted against an inactive probe holds whatever the allowlist says. The real-world case is an
    // ACTIVE plugin (mail-server is active, and its data/ holds attachments and the spam corpus), so the
    // allowlist and the containment proof are asserted here against ON — active and granted
    // browser:script, so every 404 below can only come from the path rules.
    it('serves the control asset, so the 404s below are not the gate', async () => {
        assert.strictEqual((await request(app).get(`/plugins/${ON}/public/probe.css`)).status, 200);
        assert.strictEqual((await request(app).get(`/plugins/${ON}/dist/component.bundle.css`)).status, 200);
    });

    it('404s its source, its data/ dir, runtime drops, source maps and documents', async () => {
        for (const rel of [
            'index.js',                     // code
            'data/secret.txt',              // private runtime data
            'data/bayes.json',              // the shape the audit named on mail-server
            'data/attachments/msg.eml',
            'data/attachments',
            'leak.txt',                     // a file dropped at runtime: the exfiltration channel of #3
            'public/probe.css.map',         // source map
            'public/probe.html',            // a document that would run in this origin
            'client/admin/page.tsx',        // admin page source
            'dist/component.bundle.js',     // bundle JS: only through the gated bundle route
            'dist/manifest.build.json',
            '',                             // directory listing
        ]) {
            const url = `/plugins/${ON}/${rel}`;
            const r = await request(app).get(url);
            assert.strictEqual(r.status, 404, `${url} must not be served (got ${r.status})`);
        }
        assert.strictEqual((await request(app).get(`/plugins/${ON}`)).status, 404, 'the plugin root itself');
    });

    it('404s traversal out of an active plugin\'s published dir, encoded or not', async () => {
        for (const url of [
            `/plugins/${ON}/public/%2e%2e/index.js`,
            `/plugins/${ON}/public/%2e%2e/data/secret.txt`,
            `/plugins/${ON}/public/..%2fleak.txt`,
            `/plugins/${ON}/public/..%5cleak.txt`,
            `/plugins/${ON}/..%2f..%2fwordjs-config.json`,
            `/plugins/${ON}/public/%2e%2e%2f%2e%2e%2f%2e%2e%2fwordjs-config.json`,
        ]) {
            const r = await request(app).get(url);
            assert.ok(r.status === 404 || r.status === 400, `${url} → ${r.status}`);
            for (const leak of ['module.exports', 'encryption key', 'exfiltrated', 'siteUrl']) {
                assert.ok(!String(r.text || '').includes(leak), `${url} leaked "${leak}"`);
            }
        }
    });
});

describe('static /plugins: dist/component.bundle.css follows the bundle gate (active + browser:script)', () => {
    it('serves it for an active, granted plugin, revalidated on every load', async () => {
        const r = await request(app).get(`/plugins/${ON}/dist/component.bundle.css`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.text, '.block-probe{}');
        assert.strictEqual(r.headers['cache-control'], 'no-cache', 'same caching as /bundle/css: a revoke is seen at the next load');
        assert.ok(r.headers.etag, 'an ETag, so revalidation is a cheap 304');
        const again = await request(app).get(`/plugins/${ON}/dist/component.bundle.css`).set('If-None-Match', r.headers.etag);
        assert.strictEqual(again.status, 304);
    });

    it('404s it when the plugin is not granted browser:script, or inactive — like a missing file', async () => {
        const ng = await request(app).get(`/plugins/${NG}/dist/component.bundle.css`);
        const off = await request(app).get(`/plugins/${OFF}/dist/component.bundle.css`);
        const nope = await request(app).get(`/plugins/${NOPE}/dist/component.bundle.css`);
        assert.strictEqual(ng.status, 404, 'active but not granted');
        assert.strictEqual(off.status, 404, 'granted but inactive');
        assertSameAnswer(ng, nope, 'not granted vs never installed');
        assertSameAnswer(off, nope, 'inactive vs never installed');
    });

    it('a revoke takes effect at the very next request', async () => {
        perms._setGrantsInMemory(ON, []);
        try {
            assert.strictEqual((await request(app).get(`/plugins/${ON}/dist/component.bundle.css`)).status, 404);
        } finally {
            perms._setGrantsInMemory(ON, ['browser:script']);
        }
    });
});

describe('static /plugins: client/admin/admin.css is not on the static mount', () => {
    it('404s it for everyone, even an administrator, even for an active plugin', async () => {
        for (const slug of [ON, OFF]) {
            assert.strictEqual((await request(app).get(`/plugins/${slug}/client/admin/admin.css`)).status, 404);
            assert.strictEqual((await request(app).get(`/plugins/${slug}/client/admin/admin.css`).set('Cookie', adminCookie)).status, 404);
        }
    });
});

describe('static /plugins: no admin-slug alias resolves', () => {
    it('an inactive plugin\'s admin slug is not turned into its folder', async () => {
        // The rewrite mapped /plugins/<adminSlug>/… to /plugins/<folder>/… for any INSTALLED plugin.
        const alias = await request(app).get(`/plugins/${adminSlugOf(OFF)}/public/probe.css`);
        const nope = await request(app).get(`/plugins/${NOPE}/public/probe.css`);
        assert.strictEqual(alias.status, 404);
        assertSameAnswer(alias, nope, 'inactive admin slug vs never installed');
    });

    it('nor an active plugin\'s: the static mount is addressed by folder only', async () => {
        assert.strictEqual((await request(app).get(`/plugins/${adminSlugOf(ON)}/public/probe.css`)).status, 404);
        assert.strictEqual((await request(app).get(`/plugins/${ON}/public/probe.css`)).status, 200);
    });
});

describe('GET /api/v1/plugins/:slug/admin-style{,/css} — the admin page\'s styling, signed-in only', () => {
    const style = (slug: string, sub = '') => request(app).get(`${API}/plugins/${slug}/admin-style${sub}`);

    it('answers an anonymous caller 401 BEFORE looking at the slug — the same answer for every slug', async () => {
        for (const sub of ['', '/css']) {
            const answers = [];
            for (const slug of [ON, OFF, NOPE, adminSlugOf(ON), adminSlugOf(OFF)]) {
                const r = await style(slug, sub);
                assert.strictEqual(r.status, 401, `${slug}${sub}`);
                answers.push(r);
            }
            for (const r of answers.slice(1)) assertSameAnswer(r, answers[0], `anonymous admin-style${sub}`);
        }
    });

    it('gives a signed-in administrator exactly what the page reads, never the manifest', async () => {
        for (const slug of [ON, adminSlugOf(ON)]) {
            const r = await style(slug).set('Cookie', adminCookie);
            assert.strictEqual(r.status, 200, slug);
            assert.deepStrictEqual(r.body, { style: null, theme: { accent: '#123456' }, stylesheet: true });
            assert.strictEqual(r.headers['cache-control'], 'private, no-store');
            for (const leak of ['9.8.7', 'Probe Author', 'permissions', 'left-pad', 'adminPage']) {
                assert.ok(!r.text.includes(leak), `admin-style leaks "${leak}"`);
            }
        }
    });

    it('serves admin.css privately to a signed-in session for an active plugin', async () => {
        const r = await style(ON, '/css').set('Cookie', adminCookie);
        assert.strictEqual(r.status, 200);
        assert.match(String(r.headers['content-type']), /text\/css/);
        assert.strictEqual(r.text, '.admin-probe{}');
        assert.strictEqual(r.headers['cache-control'], 'private, no-cache');
        assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
        const again = await style(ON, '/css').set('Cookie', adminCookie).set('If-None-Match', r.headers.etag);
        assert.strictEqual(again.status, 304);
    });

    it('is not administrator-only: a signed-in non-administrator gets it too (plugin pages are per-capability)', async () => {
        assert.strictEqual((await style(ON).set('Cookie', subscriberCookie)).status, 200);
        assert.strictEqual((await style(ON, '/css').set('Cookie', subscriberCookie)).status, 200);
    });

    it('reaches every plugin team role — subscriber, author, editor and a plugin role with access_admin_panel', async () => {
        assert.deepStrictEqual(Object.keys(teamCookies).sort(), ['author', 'editor', 'subscriber', PLUGIN_TEAM_ROLE].sort());
        for (const [role, cookie] of Object.entries(teamCookies)) {
            const info = await style(ON).set('Cookie', cookie);
            assert.strictEqual(info.status, 200, `${role}: admin-style`);
            assert.strictEqual(info.body.stylesheet, true, `${role}: told there is a stylesheet to link`);
            const css = await style(adminSlugOf(ON), '/css').set('Cookie', cookie);
            assert.strictEqual(css.status, 200, `${role}: admin-style/css by admin slug`);
            assert.strictEqual(css.text, '.admin-probe{}', `${role}: the packaged admin.css itself`);
        }
    });

    it('revalidates admin.css on every load, so an updated plugin\'s compiled classes arrive at once (#410)', async () => {
        // The stylesheet is regenerated from the UI sources on every plugin update, next to bundles that are
        // already no-cache; its URL carries no version. no-cache + ETag: a 304 while unchanged, the new
        // bytes on the first load after an update.
        const file = path.join(PLUGINS_ROOT, ON, 'client', 'admin', 'admin.css');
        const first = await style(ON, '/css').set('Cookie', subscriberCookie);
        assert.strictEqual(first.headers['cache-control'], 'private, no-cache');
        assert.ok(first.headers.etag, 'an ETag to revalidate against');
        assert.strictEqual((await style(ON, '/css').set('Cookie', subscriberCookie).set('If-None-Match', first.headers.etag)).status, 304);
        fs.writeFileSync(file, '.admin-probe{}\n/*! wordjs:plugin-utilities probe */\n@layer utilities { @layer wjs-plugin { .bg-black { background-color: #000 } } }\n');
        try {
            const updated = await style(ON, '/css').set('Cookie', subscriberCookie).set('If-None-Match', first.headers.etag);
            assert.strictEqual(updated.status, 200, 'an updated stylesheet is not a 304');
            assert.match(updated.text, /@layer wjs-plugin/);
        } finally {
            fs.writeFileSync(file, '.admin-probe{}');
        }
    });

    it('404s an inactive plugin — by folder or by admin slug — exactly like one that was never installed', async () => {
        for (const sub of ['', '/css']) {
            const nope = await style(NOPE, sub).set('Cookie', adminCookie);
            assert.strictEqual(nope.status, 404);
            for (const slug of [OFF, adminSlugOf(OFF)]) {
                assertSameAnswer(await style(slug, sub).set('Cookie', adminCookie), nope, `${slug}${sub} vs never installed`);
            }
        }
    });

    it('stops at the next request after a deactivation', async () => {
        assert.strictEqual((await style(ON, '/css').set('Cookie', adminCookie)).status, 200, 'served while active');
        await setActive([NG]);
        try {
            assert.strictEqual((await style(ON, '/css').set('Cookie', adminCookie)).status, 404);
            assert.strictEqual((await style(ON).set('Cookie', adminCookie)).status, 404);
        } finally {
            await setActive([ON, NG]);
        }
    });
});

describe('the bundle routes (#403 twin): inactive is indistinguishable from not installed', () => {
    const SUBS = ['bundle?type=component', 'bundle/css?type=component', 'bundle/manifest'];

    it('answers an inactive plugin, its admin slug and a never-installed slug identically', async () => {
        for (const sub of SUBS) {
            const nope = await request(app).get(`${API}/plugins/${NOPE}/${sub}`);
            assert.strictEqual(nope.status, 404, `${NOPE}/${sub}: never installed is a 404 (was a 200 empty stylesheet on /bundle/css)`);
            for (const slug of [OFF, adminSlugOf(OFF), NG]) {
                assertSameAnswer(await request(app).get(`${API}/plugins/${slug}/${sub}`), nope, `${slug}/${sub} vs never installed`);
            }
        }
    });

    it('still serves an active, granted plugin — by folder and by admin slug', async () => {
        for (const slug of [ON, adminSlugOf(ON)]) {
            for (const sub of SUBS) {
                assert.strictEqual((await request(app).get(`${API}/plugins/${slug}/${sub}`)).status, 200, `${slug}/${sub}`);
            }
        }
    });

    it('/bundle/manifest returns only the bundle list — never the version the build manifest records', async () => {
        // build-plugin.js writes { slug, bundles, externals, version } into dist/manifest.build.json, and
        // this route is anonymous for every active, granted plugin: passing the file through published
        // the exact version that the change takes off the static mount. Only bundle names the host would
        // itself serve come back; everything else in the file is dropped.
        for (const slug of [ON, adminSlugOf(ON)]) {
            const r = await request(app).get(`${API}/plugins/${slug}/bundle/manifest`);
            assert.strictEqual(r.status, 200, slug);
            assert.deepStrictEqual(r.body, { bundles: ['component.bundle.js'] }, `${slug}: the reduced view`);
            for (const leak of ['9.8.7', 'version', 'externals', 'wordjs-config', ON]) {
                assert.ok(!r.text.includes(leak), `${slug}/bundle/manifest leaks "${leak}"`);
            }
        }
    });

    it('resolves a slug by looking only at ACTIVE plugins, so the work does not depend on what is installed', async () => {
        const off = await pluginTreeTouches(async () => { await request(app).get(`${API}/plugins/${OFF}/bundle/css?type=component`); });
        const nope = await pluginTreeTouches(async () => { await request(app).get(`${API}/plugins/${NOPE}/bundle/css?type=component`); });
        assert.deepStrictEqual(off.sort(), nope.sort(), 'an inactive plugin and an unknown slug touch the same files');
        assert.ok(!off.some((p) => p.startsWith(`${OFF}/`)), `the inactive plugin's own folder is never read (${off.join(', ')})`);
    });
});

describe('GET /api/v1/plugins/registry: a plugin\'s browser:script grant only for an admin-panel user', () => {
    const registry = (cookie?: string) => {
        const r = request(app).get(`${API}/plugins/registry`);
        return cookie ? r.set('Cookie', cookie) : r;
    };
    const ours = (body: any) => Object.fromEntries((body.plugins as any[]).filter((e) => PROBES.includes(e.id)).map((e) => [e.id, e]));

    it('an anonymous caller gets the active plugins without their grant', async () => {
        const r = await registry();
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(ours(r.body), {
            [ON]: { id: ON, path: `/plugins/${ON}`, frontend: {} },
            [NG]: { id: NG, path: `/plugins/${NG}`, frontend: {} },
        });
        assert.ok(!r.text.includes('"browser"'), `the grant reached an anonymous caller: ${r.text}`);
        assert.match(String(r.headers['cache-control']), /private/, 'an answer that depends on the caller is not shareable');
    });

    it('a signed-in caller with access_admin_panel gets it — the administrator and a subscriber alike', async () => {
        for (const [who, cookie] of [['administrator', adminCookie], ['subscriber', subscriberCookie], [PLUGIN_TEAM_ROLE, teamCookies[PLUGIN_TEAM_ROLE]]]) {
            const r = await registry(cookie);
            assert.strictEqual(r.status, 200, who);
            assert.deepStrictEqual(ours(r.body), {
                [ON]: { id: ON, path: `/plugins/${ON}`, browser: true, frontend: {} },
                [NG]: { id: NG, path: `/plugins/${NG}`, browser: false, frontend: {} },
            }, who);
        }
    });

    it('a signed-in caller without access_admin_panel gets the anonymous answer', async () => {
        const r = await registry(noPanelCookie);
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body, (await registry()).body);
        assert.ok(!r.text.includes('"browser"'), `the grant reached a caller without access_admin_panel: ${r.text}`);
    });
});
