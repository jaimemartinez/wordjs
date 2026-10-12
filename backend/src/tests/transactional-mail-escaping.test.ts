/**
 * VALUES INTERPOLATED INTO A TRANSACTIONAL EMAIL ARE HTML-ESCAPED.
 *
 * Found by a red-team pass. The verification mail of POST /auth/register and the reset mail of POST
 * /auth/forgot-password put the account's login and the site name into their `html` body raw, and the
 * Auctions marketplace plugin did the same with a bidder's name and the auction title in its "you have
 * been outbid" mail. Any of those values can carry markup — `</code><a href="https://evil.example">…` —
 * which then arrives as a working link inside a message the site itself sent: phishing with the site's
 * own sender. The core mails now go through one helper (core/formatting escHtml); the plugin uses the
 * same local escHtml the other marketplace plugins (bookings, job-board, donations) already had.
 *
 * MUTATION PROOF: drop escHtml() around siteName (or the login) in routes/auth.ts, or around
 * prevTop.bidder_name / a.title in marketplace/plugins/auctions/index.js, and the matching case fails
 * with the raw <a href> in the captured mail.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-mail-escaping-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');

const PAYLOAD = '</code><a href="https://evil.example/login">Sign in again</a><code>';

/** The mail carries the payload as TEXT (escaped), never as markup. */
function assertEscaped(html: string, label: string) {
    assert.ok(!html.includes('<a href="https://evil.example'), `${label}: the injected link reached the mail html raw:\n${html}`);
    assert.ok(html.includes('&lt;a href=&quot;https://evil.example/login&quot;&gt;'), `${label}: the payload should appear escaped:\n${html}`);
}

describe('core transactional mails escape what they interpolate', () => {
    let request: any;
    let app: any;
    let sent: any[] = [];

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        const { updateOption } = require('../core/options');
        await updateOption('users_can_register', '1');
        await updateOption('blogname', `Acme ${PAYLOAD}`);
        (global as any).wordjs_send_mail = (m: any) => { sent.push(m); return { queued: true }; };
        await updateOption('mail_delivery_ready', '1');

        const express = require('express');
        const cookieParser = require('cookie-parser');
        app = express();
        app.use(express.json());
        app.use(cookieParser());
        app.use('/api/v1/auth', require('../routes/auth'));
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { delete (global as any).wordjs_send_mail; } catch { /* ignore */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
            try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* ignore */ }
        }
    });

    it('the verification mail escapes the site name', async () => {
        const { updateOption } = require('../core/options');
        await updateOption('require_email_verification', '1');
        sent = [];
        const res = await request(app).post('/api/v1/auth/register')
            .send({ username: 'newreader', email: 'newreader@gmail.com', password: 'whatever123' });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        assert.strictEqual(sent.length, 1);
        assertEscaped(String(sent[0].html), 'verification mail');
        assert.match(String(sent[0].html), /href="[^"]*\/verify-email\?token=[a-f0-9]{64}"/, 'the real link survives escaping');
    });

    it('the password-reset mail escapes the login and the site name', async () => {
        // New logins cannot carry markup any more (models/User.ts username rule); a row from before that
        // rule — or an import — still can, so the mail must not trust it.
        const { dbAsync } = require('../config/database');
        await dbAsync.run(
            'INSERT INTO users (user_login, user_pass, user_email, display_name, user_nicename, user_registered) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
            [`legacy${PAYLOAD}`, 'x', 'legacy-reset@gmail.com', 'Legacy', 'legacy-reset']);
        sent = [];
        const res = await request(app).post('/api/v1/auth/forgot-password').send({ login: 'legacy-reset@gmail.com' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(sent.length, 1, 'the reset mail must be sent');
        const html = String(sent[0].html);
        assertEscaped(html, 'reset mail');
        assert.ok(html.includes('legacy&lt;/code&gt;'), 'the login must appear escaped');
    });
});

describe('the Auctions plugin\'s outbid mail escapes the bidder name and the auction title', () => {
    it('a bidder name and a title carrying markup arrive as text', async () => {
        const Database = require('better-sqlite3');
        const mem = new Database(':memory:');
        const routes: Record<string, (req: any, res: any) => Promise<void>> = {};
        const mails: any[] = [];
        // The smallest wordjs surface the plugin's init + public bid route touch.
        const wordjs = {
            db: {
                tablePrefix: 'wjp_auctions_',
                async createTable(name: string, cols: string[]) {
                    const ddl = cols.map((c) => c.replace(/\bINT_PK\b/, 'INTEGER PRIMARY KEY AUTOINCREMENT').replace(/\bINT\b/g, 'INTEGER'));
                    mem.exec(`CREATE TABLE IF NOT EXISTS ${name} (${ddl.join(', ')})`);
                },
                async run(sql: string, params: any[] = []) {
                    const r = mem.prepare(sql).run(...params);
                    return { changes: r.changes, lastID: Number(r.lastInsertRowid) };
                },
                async get(sql: string, params: any[] = []) { return mem.prepare(sql).get(...params); },
                async all(sql: string, params: any[] = []) { return mem.prepare(sql).all(...params); },
            },
            http: {
                route(method: string, p: string, a: any, b?: any) { routes[`${method} ${p}`] = typeof a === 'function' ? a : b; },
            },
            adminMenu: { add() { /* not exercised */ } },
            mail: async (m: any) => { mails.push(m); },
        };

        const pluginPath = path.resolve(__dirname, '..', '..', '..', 'marketplace', 'plugins', 'auctions', 'index.js');
        delete require.cache[pluginPath];
        const plugin = require(pluginPath);
        const savedLog = console.log;
        console.log = () => {};
        try { await plugin.init(wordjs); } finally { console.log = savedLog; }

        const ends = new Date(Date.now() + 24 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
        const ins = await wordjs.db.run(
            `INSERT INTO wjp_auctions_auctions (title, slug, start_price_cents, min_increment_cents, ends_at, anti_snipe_min, status, is_published, created_at)
             VALUES (?, 'lot', 1000, 100, ?, 0, 'active', 1, ?)`, [`Lot ${PAYLOAD}`, ends, ends]);

        const bid = async (name: string, email: string, cents: number) => {
            let status = 200; let body: any = null;
            const res = { status(s: number) { status = s; return res; }, json(b: any) { body = b; return res; } };
            await routes['post /public/bid']({ body: { auction_id: ins.lastID, bidder_name: name, bidder_email: email, amount_cents: cents, elapsed: 5000 } }, res);
            return { status, body };
        };

        const first = await bid(`Mallory ${PAYLOAD}`, 'first@gmail.com', 1100);
        assert.strictEqual(first.status, 200, JSON.stringify(first.body));
        const second = await bid('Bob', 'second@gmail.com', 1300);
        assert.strictEqual(second.status, 200, JSON.stringify(second.body));

        assert.strictEqual(mails.length, 1, 'the previous top bidder gets one outbid mail');
        assert.strictEqual(mails[0].to, 'first@gmail.com');
        const html = String(mails[0].html);
        assertEscaped(html, 'outbid mail');
        assert.ok(html.includes('Hola Mallory &lt;/code&gt;'), 'the bidder name must appear escaped');
        assert.ok(html.includes('"Lot &lt;/code&gt;'), 'the title must appear escaped');
        try { if (plugin.deactivate) plugin.deactivate(); } catch { /* best effort */ }
        mem.close();
    });
});
