/**
 * WordJS — THE MULTISITE GUARANTEES ON EVERY ENGINE (documentation/multisite-design.md).
 *
 * One suite, run by three entry files — multisite-engine-sqlite / -postgres / -mysql.test.ts — each in its
 * own process (the engine is process-wide). It boots the REAL Express app with multisite ON over the
 * engine, creates two twin sites through the real network API, and proves on that engine what a network
 * promises: each site's tables live in its own namespace (a SQLite file, a Postgres schema, a MySQL
 * database) and nowhere else; the network store is the engine's own (network.db, the wordjs_network schema,
 * the <db>_network database); a session, a row id, a plugin's database principal and a collaboration room
 * never cross sites; each site has its own leases, backups and certificate; a deleted site leaves nothing
 * behind and its id is never handed out again.
 *
 * THE WORLD. A throwaway install directory (config, uploads, SQLite files) the process chdirs into before
 * any application module loads. Postgres and MySQL get a dedicated database (`wordjs_msengine`), dropped and
 * created again at the start, so a run never sees another run's sites. Connection settings come from the
 * same variables the other engine suites read (PGHOST…, MYSQL_HOST…).
 *
 * SKIP POLICY. Locally an unreachable engine is a skip. Under WORDJS_CI_DB=1 the CI services are wired up,
 * so an unreachable engine FAILS the suite — never a silent green.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

type Engine = 'sqlite-native' | 'postgres' | 'mysql';

const DB = 'wordjs_msengine';
const PASSWORD = 'Correct-Horse-9!';
const MAIN_URL = 'http://main.example.com';
const TWO = 'two.example.com';
const THREE = 'three.example.com';
const FOUR = 'four.example.com';

function pgSettings() {
    return {
        host: process.env.PGHOST || '127.0.0.1',
        port: Number(process.env.PGPORT) || 5432,
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD ?? 'password',
    };
}
function mysqlSettings() {
    return {
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_PORT) || 3306,
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD ?? 'password',
    };
}

/** Drop every database / schema an earlier run left and create the suite's own, empty. */
async function freshServer(engine: Engine): Promise<string | null> {
    try {
        if (engine === 'postgres') {
            const { Client } = require('pg');
            const admin = new Client({ ...pgSettings(), database: 'postgres', connectionTimeoutMillis: 5000 });
            await admin.connect();
            try {
                await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
                await admin.query(`CREATE DATABASE ${DB} TEMPLATE template0 ENCODING 'UTF8'`);
            } finally { await admin.end(); }
        } else if (engine === 'mysql') {
            const mysql = require('mysql2/promise');
            const c = await mysql.createConnection({ ...mysqlSettings(), connectTimeout: 5000 });
            try {
                const [rows] = await c.query("SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'wordjs\\_msengine%'");
                for (const r of rows as any[]) await c.query(`DROP DATABASE \`${String(r.n)}\``);
                await c.query(`CREATE DATABASE ${DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            } finally { await c.end(); }
        }
        return null;
    } catch (e: any) {
        return `no reachable ${engine}: ${e && e.message}`;
    }
}

/** A query against the engine's server as its administrator, outside the app (the suite's eyes). */
async function serverQuery(engine: Engine, sql: string, params: any[] = []): Promise<any[]> {
    if (engine === 'postgres') {
        const { Client } = require('pg');
        const c = new Client({ ...pgSettings(), database: DB });
        await c.connect();
        try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
    }
    const mysql = require('mysql2/promise');
    const c = await mysql.createConnection({ ...mysqlSettings() });
    try { const [rows] = await c.query(sql, params); return rows as any[]; } finally { await c.end(); }
}

export function runMultisiteEngineSuite(engine: Engine): void {
    const ORIGINAL_CWD = process.cwd();
    const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-msengine-${engine}-${process.pid}-`));
    const DATA_DIR = path.join(TMP_INSTALL, 'data');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(TMP_INSTALL, 'wordjs-config.json'), JSON.stringify({
        installedAt: '2026-01-01T00:00:00.000Z',
        dbDriver: engine,
        siteUrl: MAIN_URL,
        hostPolicy: { ipLiterals: 'any' },
        multisite: { enabled: true },
    }, null, 2));
    process.chdir(TMP_INSTALL);
    const ENV_KEYS = ['WORDJS_ALLOWED_HOSTS', 'WORDJS_IP_HOSTS', 'WORDJS_DEV_ORIGINS', 'WORDJS_TRUST_PROXY'];
    const SAVED_ENV: Record<string, string | undefined> = {};
    for (const key of ENV_KEYS) { SAVED_ENV[key] = process.env[key]; delete process.env[key]; }

    const config = require('../../config/app');
    config.dbPath = path.join(DATA_DIR, 'wordjs-native.db');
    config.dbDriver = engine;
    if (engine === 'postgres') config.db = { ...config.db, ...pgSettings(), name: DB };
    if (engine === 'mysql') config.db = { ...config.db, ...mysqlSettings(), name: DB };
    config.siteUrl = MAIN_URL;
    config.site.url = MAIN_URL;
    config.frontendUrl = MAIN_URL;
    config.uploads.dir = path.join(TMP_INSTALL, 'uploads');
    config.uploads.privateDir = path.join(DATA_DIR, 'private-uploads');
    config.nodeEnv = 'production';
    config.multisite = { enabled: true };

    const request = require('supertest');
    const database = require('../../config/database');
    const siteContext = require('../../core/site-context');
    const network = require('../../core/network');
    const app = require('../../index');
    const API = config.api.prefix;

    let skipReason: string | null = null;
    let server: any;
    const ids: Record<string, number> = {};
    const tokens: Record<string, string> = {};

    const direct = (method: string, url: string, host: string) =>
        (request(server) as any)[method](url).set('Host', host).set('Origin', `http://${host}`);
    const bearer = (method: string, url: string, host: string, token: string) =>
        direct(method, url, host).set('Authorization', `Bearer ${token}`);
    async function signIn(host: string, username: string): Promise<string> {
        const res = await direct('post', `${API}/auth/login`, host).send({ username, password: PASSWORD });
        assert.strictEqual(res.status, 200, `sign-in on ${host}: ${res.status} ${JSON.stringify(res.body)}`);
        const cookie = ([] as string[]).concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('wordjs_token='));
        return decodeURIComponent(String(cookie).split(';')[0].slice('wordjs_token='.length));
    }
    /** Create a site the way the network screen does: the real route, re-authenticated. */
    async function createSite(slug: string, host: string, title: string) {
        const res = await bearer('post', `${API}/network/sites`, 'main.example.com', tokens.net).send({
            slug, url: `http://${host}`, title, adminUsername: 'admin', adminEmail: `admin@${host}`, adminPassword: PASSWORD, currentPassword: PASSWORD,
        });
        assert.strictEqual(res.status, 201, `create ${host}: ${res.status} ${JSON.stringify(res.body)}`);
        return res.body.site;
    }
    const skipped = (t: any) => {
        if (!skipReason) return false;
        if (process.env.WORDJS_CI_DB === '1') assert.fail(skipReason);
        t.skip(skipReason);
        return true;
    };

    before(async () => {
        skipReason = await freshServer(engine);
        if (skipReason) return;
        await siteContext.runWithSite(1, async () => {
            await database.init({ driver: engine });
            await database.initializeDatabase();
            await require('../../core/options').initDefaultOptions(config);
            await require('../../core/roles').loadRoles();
            await require('../../core/post-types').initPostTypes();
            await require('../../core/post-types').initTaxonomies();
            require('../../core/adminMenu').initCoreMenus();
            const db = database.getDbAsync();
            const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
                ['netadmin', bcrypt.hashSync(PASSWORD, 10), 'netadmin@main.example.com', 'netadmin']);
            await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [r.lastID]);
            ids.netadmin = Number(r.lastID);
            await network.ready({ watch: true });
            await network.registerPrimarySite(MAIN_URL);
            await network.addNetworkAdmin(ids.netadmin, 'netadmin');
        });
        require('../../core/plugins-ready').markPluginsReady();
        server = http.createServer(app);
        await new Promise<void>((resolve) => siteContext.runWithSite(null, () => server.listen(0, '127.0.0.1', resolve)));
        tokens.net = await signIn('main.example.com', 'netadmin');
        ids.two = (await createSite('two', TWO, 'Site Two')).id;
        ids.three = (await createSite('three', THREE, 'Site Three')).id;
        tokens.two = await signIn(TWO, 'admin');
        tokens.three = await signIn(THREE, 'admin');
    });

    after(async () => {
        try { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); } catch { /* */ }
        // The probe plugin's principals are server-wide (roles / users outlive the database): drop them.
        if (!skipReason && engine !== 'sqlite-native') {
            try {
                if (engine === 'postgres') {
                    for (const r of await serverQuery(engine, "SELECT rolname FROM pg_roles WHERE rolname LIKE 'wjp!_role!_msprobe%' ESCAPE '!'")) {
                        await serverQuery(engine, `DROP OWNED BY "${r.rolname}"`).catch(() => { /* */ });
                        await serverQuery(engine, `DROP ROLE IF EXISTS "${r.rolname}"`);
                    }
                } else {
                    for (const r of await serverQuery(engine, "SELECT User AS u FROM mysql.user WHERE User LIKE 'wjp!_msprobe%' ESCAPE '!'")) {
                        await serverQuery(engine, `DROP USER IF EXISTS '${String(r.u)}'@'%'`);
                    }
                }
            } catch { /* best-effort */ }
        }
        try { require('../../core/collab-rooms')._resetForTests(); } catch { /* */ }
        try { await database.closeSiteDatabases(); } catch { /* */ }
        try { await database.closeDatabase(); } catch { /* */ }
        try { network.closeNetworkStore(); } catch { /* */ }
        try { await require('../../core/cache').closeAll(); } catch { /* */ }
        for (const key of ENV_KEYS) {
            if (SAVED_ENV[key] === undefined) delete process.env[key];
            else process.env[key] = SAVED_ENV[key];
        }
        try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
        try { fs.rmSync(TMP_INSTALL, { recursive: true, force: true }); } catch { /* */ }
    });

    describe(`multisite on ${engine}: where each site's data lives`, () => {
        test('every site has its own namespace, with the core tables in it', async (t: any) => {
            if (skipped(t)) return;
            assert.ok(ids.two > 1 && ids.three > ids.two);
            if (engine === 'postgres') {
                const rows = await serverQuery(engine, `SELECT table_schema AS s FROM information_schema.tables WHERE table_name = 'posts' ORDER BY 1`);
                assert.deepStrictEqual(rows.map((r) => r.s), ['public', `wordjs_site_${ids.three}`, `wordjs_site_${ids.two}`].sort());
                const locks = await serverQuery(engine, `SELECT table_schema AS s FROM information_schema.tables WHERE table_name = 'wordjs_locks' ORDER BY 1`);
                assert.ok(locks.some((r) => r.s === `wordjs_site_${ids.two}`), 'the site keeps its own leases');
            } else if (engine === 'mysql') {
                const rows = await serverQuery(engine, `SELECT table_schema AS s FROM information_schema.tables WHERE table_name = 'posts' AND table_schema LIKE 'wordjs\\_msengine%' ORDER BY 1`);
                assert.deepStrictEqual(rows.map((r) => r.s).sort(), [DB, `${DB}_site_${ids.three}`, `${DB}_site_${ids.two}`].sort());
            } else {
                for (const id of [ids.two, ids.three]) assert.ok(fs.existsSync(path.join(DATA_DIR, 'sites', String(id), 'wordjs-native.db')));
            }
        });

        test("the network store is the engine's own, never a site's database", async (t: any) => {
            if (skipped(t)) return;
            if (engine === 'sqlite-native') {
                assert.ok(fs.existsSync(path.join(DATA_DIR, 'network.db')));
                return;
            }
            assert.ok(!fs.existsSync(path.join(DATA_DIR, 'network.db')), 'no SQLite network store on a server engine');
            const sql = engine === 'postgres'
                ? 'SELECT id, slug FROM wordjs_network.network_sites ORDER BY id'
                : `SELECT id, slug FROM \`${DB}_network\`.network_sites ORDER BY id`;
            assert.deepStrictEqual((await serverQuery(engine, sql)).map((r) => r.slug), ['main', 'two', 'three']);
            const main = engine === 'postgres'
                ? await serverQuery(engine, "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'network_sites'")
                : await serverQuery(engine, 'SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', [DB, 'network_sites']);
            assert.strictEqual(main.length, 0, "the main site's database holds no network record");
        });
    });

    describe(`multisite on ${engine}: isolation through the real routes`, () => {
        let twoPost = 0;
        let threePost = 0;
        test('each site answers with its own settings', async (t: any) => {
            if (skipped(t)) return;
            for (const [host, title] of [['main.example.com', 'WordJS'], [TWO, 'Site Two'], [THREE, 'Site Three']]) {
                const res = await direct('get', `${API}/settings`, host);
                assert.strictEqual(res.status, 200, host);
                assert.strictEqual(res.body.blogname, title, host);
            }
        });

        test('twin sites hand out the same post ids, and an id never reaches the other site', async (t: any) => {
            if (skipped(t)) return;
            const a = await bearer('post', `${API}/posts`, TWO, tokens.two).send({ title: 'Two private plans', content: 'two-secret-body', status: 'draft' });
            assert.strictEqual(a.status, 201, JSON.stringify(a.body));
            const b = await bearer('post', `${API}/posts`, THREE, tokens.three).send({ title: 'Three notes', content: 'three-body', status: 'draft' });
            assert.strictEqual(b.status, 201, JSON.stringify(b.body));
            twoPost = a.body.id;
            threePost = b.body.id;
            assert.strictEqual(twoPost, threePost, 'the IDOR precondition: same id on both sites');
            const onThree = await bearer('get', `${API}/posts/${twoPost}`, THREE, tokens.three);
            assert.strictEqual(onThree.status, 200);
            assert.notStrictEqual(onThree.body.title?.raw ?? onThree.body.title, 'Two private plans');
            const search = await bearer('get', `${API}/posts?status=draft&search=private`, THREE, tokens.three);
            assert.ok(!JSON.stringify(search.body).includes('two-secret-body'), 'search never crosses sites');
            if (engine === 'postgres') {
                const rows = await serverQuery(engine, `SELECT post_title FROM wordjs_site_${ids.two}.posts WHERE id = $1`, [twoPost]);
                assert.strictEqual(rows[0].post_title, 'Two private plans');
                assert.strictEqual((await serverQuery(engine, `SELECT 1 FROM public.posts WHERE post_title = 'Two private plans'`)).length, 0);
            } else if (engine === 'mysql') {
                const rows = await serverQuery(engine, `SELECT post_title FROM \`${DB}_site_${ids.two}\`.posts WHERE id = ?`, [twoPost]);
                assert.strictEqual(rows[0].post_title, 'Two private plans');
                assert.strictEqual((await serverQuery(engine, `SELECT 1 FROM \`${DB}\`.posts WHERE post_title = 'Two private plans'`)).length, 0);
            }
        });

        test("one site's session is refused on its twin and on the main site", async (t: any) => {
            if (skipped(t)) return;
            for (const [host, key] of [[THREE, 'two'], [TWO, 'three'], ['main.example.com', 'two']]) {
                const res = await bearer('get', `${API}/users/me`, host, tokens[key]);
                assert.strictEqual(res.status, 401, `${key} on ${host}`);
            }
        });

        test('an address no site declares is refused', async (t: any) => {
            if (skipped(t)) return;
            assert.strictEqual((await direct('get', `${API}/settings`, 'nowhere.example.com')).status, 421);
        });
    });

    describe(`multisite on ${engine}: a plugin's database principal is the site's`, () => {
        test('a site\'s principal reaches its own plugin tables only — not the core, not another site', async (t: any) => {
            if (skipped(t)) return;
            if (engine === 'sqlite-native') { t.skip('SQLite has no database principals (the SQL text-guard is the control)'); return; }
            const iso = require('../../core/plugin-db-isolation');
            const probe = 'msprobe';
            await siteContext.runWithSite(ids.two, async () => {
                await database.dbAsync.exec('CREATE TABLE IF NOT EXISTS wjp_msprobe_items (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)');
                await database.dbAsync.run('INSERT INTO wjp_msprobe_items (label) VALUES (?)', ['two-row']);
                await iso.provision(probe);
                assert.ok(iso.isProvisioned(probe), 'the principal was provisioned');
                assert.match(engine === 'postgres' ? iso.roleName(probe) : iso.userName(probe), new RegExp(`__s${ids.two}$`));
                const own = await iso.runScoped(probe, 'all', 'SELECT label FROM wjp_msprobe_items', []);
                assert.deepStrictEqual(own.map((r: any) => r.label), ['two-row']);
                await assert.rejects(iso.runScoped(probe, 'all', 'SELECT * FROM posts', []), 'the core tables of its own site are refused');
                const mainTable = engine === 'postgres' ? 'public.posts' : `\`${DB}\`.posts`;
                await assert.rejects(iso.runScoped(probe, 'all', `SELECT * FROM ${mainTable}`, []), "the main site's tables are refused");
            });
            await siteContext.runWithSite(ids.three, async () => {
                // Through run(), as a plugin's `db.run('CREATE TABLE …')` sends it: the SQLite dialect is
                // translated there too (it failed on Postgres with "syntax error at or near AUTOINCREMENT").
                await database.dbAsync.run('CREATE TABLE IF NOT EXISTS wjp_msprobe_items (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)');
                await iso.provision(probe);
                assert.deepStrictEqual(await iso.runScoped(probe, 'all', 'SELECT label FROM wjp_msprobe_items', []), [], "site three sees its own (empty) table");
                const twosTable = engine === 'postgres' ? `wordjs_site_${ids.two}.wjp_msprobe_items` : `\`${DB}_site_${ids.two}\`.wjp_msprobe_items`;
                await assert.rejects(iso.runScoped(probe, 'all', `SELECT * FROM ${twosTable}`, []), "another site's plugin table is refused to this site's principal");
            });
        });
    });

    describe(`multisite on ${engine}: real-time collaboration on a site other than the main one`, () => {
        test('the twins open the room of the same post id, and an operation reaches only its own site', async (t: any) => {
            if (skipped(t)) return;
            const twin = await bearer('post', `${API}/posts`, TWO, tokens.two).send({ title: 'Co-edited', content: 'x', status: 'draft' });
            const other = await bearer('post', `${API}/posts`, THREE, tokens.three).send({ title: 'Twin of co-edited', content: 'y', status: 'draft' });
            assert.strictEqual(twin.body.id, other.body.id, 'same post id on both sites');
            const postId = twin.body.id;
            const open = (host: string, token: string, nonce: string) => new Promise<any>((resolve, reject) => {
                const req = http.get({ host: '127.0.0.1', port: server.address().port, path: `${API}/collab/${postId}/stream?siteId=${nonce}`,
                    headers: { Host: host, Origin: `http://${host}`, Accept: 'text/event-stream', Authorization: `Bearer ${token}` } }, (res: any) => {
                    const events: any[] = [];
                    let buf = '';
                    res.setEncoding('utf8');
                    res.on('data', (chunk: string) => {
                        buf += chunk;
                        let i: number;
                        while ((i = buf.indexOf('\n\n')) !== -1) {
                            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
                            const ev = frame.split('\n').find((l) => l.startsWith('event: '));
                            const da = frame.split('\n').find((l) => l.startsWith('data: '));
                            if (ev && da) { try { events.push({ event: ev.slice(7), data: JSON.parse(da.slice(6)) }); } catch { /* */ } }
                        }
                    });
                    resolve({ status: res.statusCode, events, close: () => { req.destroy(); res.destroy(); } });
                });
                req.on('error', reject);
            });
            const waitFor = async (s: any, event: string, ms = 4000) => {
                const end = Date.now() + ms;
                while (Date.now() < end) {
                    const hit = s.events.find((e: any) => e.event === event);
                    if (hit) return hit.data;
                    await new Promise((r) => setTimeout(r, 25));
                }
                throw new Error(`no ${event}`);
            };
            const a = await open(TWO, tokens.two, 's_aaaaaaaaaaaaaaaa');
            const b = await open(TWO, tokens.two, 's_bbbbbbbbbbbbbbbb');
            const c = await open(THREE, tokens.three, 's_aaaaaaaaaaaaaaaa');
            try {
                assert.strictEqual(a.status, 200, 'collaboration answers on a site other than the main one');
                const wa = await waitFor(a, 'welcome');
                await waitFor(b, 'welcome');
                const wc = await waitFor(c, 'welcome');
                assert.notStrictEqual(wa.self.siteId, wc.self.siteId, 'the same user id and nonce get another replica on another site');
                const op = { k: 'propSet', id: { site: wa.self.siteId, counter: 1 }, hlc: { l: 101, c: 0, site: wa.self.siteId }, nodeId: 'n1', key: 'color', value: '#123456' };
                const pushed = await bearer('post', `${API}/collab/${postId}/ops`, TWO, tokens.two).send({ siteId: wa.self.siteId, epoch: wa.epoch, ops: [op] });
                assert.strictEqual(pushed.status, 200, JSON.stringify(pushed.body));
                const seen = await waitFor(b, 'ops');
                assert.ok(JSON.stringify(seen).includes('#123456'), 'the other member of the same site receives it');
                await new Promise((r) => setTimeout(r, 300));
                assert.ok(!c.events.some((e: any) => e.event === 'ops'), "the twin site's room of the same post id receives nothing");
            } finally {
                a.close(); b.close(); c.close();
            }
        });
    });

    describe(`multisite on ${engine}: a site's own backups`, () => {
        test("a site's administrator backs it up and restores it; the other sites are untouched", async (t: any) => {
            if (skipped(t)) return;
            if (engine !== 'sqlite-native') {
                const tool = require('../../core/db-dump');
                const name = engine === 'postgres' ? 'pg_dump' : 'mysqldump';
                if (!(await tool.isToolAvailable(name))) {
                    if (process.env.WORDJS_CI_DB === '1') assert.fail(`${name} is not installed: the backup of a ${engine} site cannot be certified`);
                    t.skip(`${name} not installed here`);
                    return;
                }
            }
            const keep = await bearer('post', `${API}/posts`, TWO, tokens.two).send({ title: 'Kept by the backup', content: 'k', status: 'draft' });
            assert.strictEqual(keep.status, 201);
            const made = await bearer('post', `${API}/backups`, TWO, tokens.two).send({});
            assert.strictEqual(made.status, 200, JSON.stringify(made.body));
            const list = await bearer('get', `${API}/backups`, TWO, tokens.two);
            assert.strictEqual(list.status, 200);
            const file = (list.body.backups || list.body)[0].filename;
            assert.ok(fs.existsSync(path.join(DATA_DIR, 'sites', String(ids.two), 'backups', file)), "the archive is kept with the site");
            const mainList = await bearer('get', `${API}/backups`, 'main.example.com', tokens.net);
            assert.ok(!JSON.stringify(mainList.body).includes(file), "the main site does not list another site's archive");
            assert.strictEqual((await bearer('delete', `${API}/posts/${keep.body.id}?force=true`, TWO, tokens.two)).status, 200);
            const threeBefore = await bearer('get', `${API}/posts?status=draft`, THREE, tokens.three);
            const restored = await bearer('post', `${API}/backups/${file}/restore`, TWO, tokens.two).send({ currentPassword: PASSWORD });
            assert.strictEqual(restored.status, 200, JSON.stringify(restored.body));
            assert.deepStrictEqual(restored.body.results.incidents, [], 'the physical restore of the site ran, complete');
            assert.strictEqual(restored.body.results.physical, true);
            const back = await bearer('get', `${API}/posts/${keep.body.id}`, TWO, tokens.two);
            assert.strictEqual(back.status, 200, 'the deleted post is back on its site');
            const threeAfter = await bearer('get', `${API}/posts?status=draft`, THREE, tokens.three);
            assert.deepStrictEqual(threeAfter.body.map((p: any) => p.id), threeBefore.body.map((p: any) => p.id), 'the twin site is untouched');
        });
    });

    describe(`multisite on ${engine}: a site's own certificate`, () => {
        test('a certificate for the site is validated, stored in the network store and listed — never its key', async (t: any) => {
            if (skipped(t)) return;
            const selfsigned = require('selfsigned');
            const pems = await selfsigned.generate([{ name: 'commonName', value: TWO }], { days: 30, keySize: 2048, extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: TWO }] }] });
            const wrong = await bearer('put', `${API}/network/sites/${ids.three}/certificate`, 'main.example.com', tokens.net)
                .send({ certPem: pems.cert, keyPem: pems.private, currentPassword: PASSWORD });
            assert.strictEqual(wrong.status, 400);
            assert.strictEqual(wrong.body.code, 'network_invalid_certificate', 'a certificate for another address is refused');
            const siteCerts = require('../../core/site-certs');
            const certManager = require('../../core/cert-manager');
            const pushed: string[] = [];
            const orig = certManager.pushSiteCertToEdge;
            certManager.pushSiteCertToEdge = async (host: string) => { pushed.push(host); return { success: true }; };
            try {
                const ok = await bearer('put', `${API}/network/sites/${ids.two}/certificate`, 'main.example.com', tokens.net)
                    .send({ certPem: pems.cert, keyPem: pems.private, currentPassword: PASSWORD });
                assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
                assert.deepStrictEqual(pushed, [TWO], 'the edge was given it');
                const listed = await bearer('get', `${API}/network/certificates`, 'main.example.com', tokens.net);
                const mine = listed.body.certificates.find((c: any) => c.siteId === ids.two);
                assert.strictEqual(mine.installed, true);
                assert.ok(!JSON.stringify(listed.body).includes('PRIVATE KEY'), 'never a key in the answer');
                pushed.length = 0;
                assert.strictEqual(await siteCerts.syncSiteCertificatesToEdge(), 1);
                assert.deepStrictEqual(pushed, [TWO], 'a new edge gets it back from the store');
            } finally {
                certManager.pushSiteCertToEdge = orig;
            }
        });

        test('an HTTP-01 answer recorded by one node is served by every node, on the site\'s address', async (t: any) => {
            if (skipped(t)) return;
            await require('../../core/site-certs').rememberChallenge('tok_multinode_1', 'tok_multinode_1.thumb');
            const res = await direct('get', '/.well-known/acme-challenge/tok_multinode_1', TWO);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.text, 'tok_multinode_1.thumb');
            assert.strictEqual((await direct('get', '/.well-known/acme-challenge/tok_unknown', TWO)).status, 404);
        });
    });

    describe(`multisite on ${engine}: deleting a site`, () => {
        test('an active site cannot be deleted, and the slug must be repeated', async (t: any) => {
            if (skipped(t)) return;
            const active = await bearer('delete', `${API}/network/sites/${ids.three}`, 'main.example.com', tokens.net).send({ currentPassword: PASSWORD, confirmSlug: 'three' });
            assert.strictEqual(active.status, 409);
            assert.strictEqual(active.body.code, 'network_site_active');
            assert.strictEqual((await bearer('post', `${API}/network/sites/${ids.three}/suspend`, 'main.example.com', tokens.net).send({ currentPassword: PASSWORD })).status, 200);
            const wrong = await bearer('delete', `${API}/network/sites/${ids.three}`, 'main.example.com', tokens.net).send({ currentPassword: PASSWORD, confirmSlug: 'two' });
            assert.strictEqual(wrong.status, 400);
            assert.strictEqual(wrong.body.code, 'network_confirm_mismatch');
        });

        test('a deleted site leaves no database, no files and no address; its id is never reused', async (t: any) => {
            if (skipped(t)) return;
            const res = await bearer('delete', `${API}/network/sites/${ids.three}`, 'main.example.com', tokens.net).send({ currentPassword: PASSWORD, confirmSlug: 'three' });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.strictEqual(network.getSite(ids.three), null);
            assert.ok(!fs.existsSync(path.join(DATA_DIR, 'sites', String(ids.three))), 'its directory is gone');
            if (engine === 'postgres') {
                assert.strictEqual((await serverQuery(engine, 'SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [`wordjs_site_${ids.three}`])).length, 0);
                const roles = await serverQuery(engine, 'SELECT rolname FROM pg_roles WHERE rolname = $1', [`wjp_role_msprobe__s${ids.three}`]);
                assert.strictEqual(roles.length, 0, "its plugins' principals are dropped");
            } else if (engine === 'mysql') {
                assert.strictEqual((await serverQuery(engine, 'SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [`${DB}_site_${ids.three}`])).length, 0);
            }
            assert.strictEqual((await direct('get', `${API}/settings`, THREE)).status, 421, 'its address is no longer answered');
            assert.strictEqual((await direct('get', `${API}/settings`, TWO)).status, 200, 'the other site still is');
            const four = await createSite('four', FOUR, 'Site Four');
            assert.ok(four.id > ids.three, `a new site gets a new id (${four.id} > ${ids.three})`);
        });
    });

    describe(`multisite on ${engine}: what another node wrote to the shared store`, () => {
        test('a site recorded by another node is answered here once the store is re-read', async (t: any) => {
            if (skipped(t)) return;
            if (engine === 'sqlite-native') { t.skip('one host: the SQLite store is not shared by nodes'); return; }
            // Another node's insert, straight into the shared store (what node B sees after node A writes).
            const table = engine === 'postgres' ? 'wordjs_network.network_sites' : `\`${DB}_network\`.network_sites`;
            const hosts = engine === 'postgres' ? 'wordjs_network.network_site_hosts' : `\`${DB}_network\`.network_site_hosts`;
            const now = new Date().toISOString();
            const p = engine === 'postgres' ? ['$1', '$2', '$3', '$4', '$5'] : ['?', '?', '?', '?', '?'];
            await serverQuery(engine, `INSERT INTO ${table} (id, slug, main_url, status, db_path, created_at, updated_at) VALUES (${p[0]}, ${p[1]}, ${p[2]}, 'active', NULL, ${p[3]}, ${p[4]})`, [99, 'remote', 'http://remote.example.com', now, now]);
            await serverQuery(engine, `INSERT INTO ${hosts} (host, site_id, kind) VALUES (${p[0]}, ${p[1]}, 'main')`, ['remote.example.com', 99]);
            assert.strictEqual((await direct('get', `${API}/settings`, 'remote.example.com')).status, 421, 'not yet: this node has not re-read');
            await network.reloadMirror();
            assert.ok(network.getSite(99), 'the mirror now has it');
            const res = await direct('get', `${API}/settings`, 'remote.example.com');
            assert.strictEqual(res.status, 200, `answered once re-read: ${res.status}`);
        });
    });
}

module.exports = { runMultisiteEngineSuite };
