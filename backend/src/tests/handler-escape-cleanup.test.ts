/**
 * WORK THAT ESCAPES ITS HANDLER — two defects the HTTP-boundary typing pass (f95f139f) surfaced.
 *
 * Both routes do work that the request's own error path never sees, so a failure is not turned into a
 * response and the side effect is never undone:
 *
 *   1. POST /api/v1/import (routes/export.ts) read the multer temp file, JSON.parse'd it, and only THEN
 *      unlinked it. A malformed upload throws at the parse, so the unlink never runs and the temp file
 *      stays under ./data/imports for ever. Every malformed import leaks up to the 50MB multer limit —
 *      an unbounded disk fill reachable by anyone who may import.
 *
 *   2. GET /api/v1/fonts (routes/fonts.ts) is wrapped in asyncHandler, but the listing is built inside
 *      the `fs.readdir` CALLBACK. asyncHandler only does `Promise.resolve(fn(...)).catch(next)` — it can
 *      only see a rejection of the promise the handler returned, and that promise resolves the moment
 *      `fs.readdir` is *called*. A throw in the callback therefore runs on an empty stack: it is an
 *      uncaughtException, not a 500. The request never gets a response, and in production index.ts's
 *      `process.on('uncaughtException')` handler does `process.exit(1)` — the whole server dies.
 *
 * HOW THE FONTS THROW IS REACHED FOR REAL: the callback calls `fs.statSync` on every name readdir
 * returned. Between the readdir and the stat there is a TOCTOU window, and DELETE /fonts/:filename
 * (which unlinks) plus the upload path both write into that directory. A font removed inside that window
 * makes statSync throw ENOENT. This test reproduces that state deterministically WITHOUT stubbing fs:
 * it plants a DANGLING link (a junction on Windows, a symlink elsewhere) named like a font. readdir
 * lists the name, statSync follows the link and throws the same real ENOENT the race produces. Nothing
 * about fs is faked — only the timing is made repeatable.
 *
 * The GET is behind optionalAuth, so that crash is reachable ANONYMOUSLY.
 *
 * The whole router tree is mounted at the real prefix behind supertest (fixture-vs-producer: the paths,
 * the middleware order and multer's own disk writes are the real ones). CWD is moved into a temp root
 * BEFORE anything is required, because both multer's `dest` (`path.resolve('./data/imports')`) and
 * `fontsDir` (`path.join(config.uploads.dir, 'fonts')`) are resolved from the CWD at module load.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-handler-escape-'));
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

// The two directories the routes resolve from the CWD at load time.
const IMPORT_DIR = path.join(TMP_ROOT, 'data', 'imports');
const FONTS_DIR = path.join(TMP_ROOT, 'uploads', 'fonts');

function listDir(dir: string): string[] {
    try {
        return fs.readdirSync(dir);
    } catch {
        return [];
    }
}

describe('work that escapes its handler', () => {
    let request: any;
    let app: any;
    let adminToken: string;

    before(async () => {
        request = require('supertest');

        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        const dbAsync = database.getDbAsync();
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@example.com', 'Administrator']
        );
        const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);
        await dbAsync.run(
            `INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`,
            [admin.id]
        );
        adminToken = jwt.sign(
            { userId: admin.id, username: 'admin' },
            config.jwt.secret,
            { algorithm: 'HS256', expiresIn: '1h' }
        );

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json());
        app.use(config.api.prefix, require('../routes'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        // A dangling junction is not removed by rmSync -r; take it out by hand first.
        for (const name of listDir(FONTS_DIR)) {
            const p = path.join(FONTS_DIR, name);
            try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch { /* ignore */ } }
        }
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    /**
     * DEFECT 1. The parse throws before the unlink, so the upload stays on disk. Assert the DIRECTORY,
     * not the response: the response was always an error, the leak is what nobody saw.
     */
    it('POST /import: a malformed upload leaves no multer temp file behind', async () => {
        const before = listDir(IMPORT_DIR).length;

        const res = await request(app)
            .post('/api/v1/import')
            .set('Authorization', `Bearer ${adminToken}`)
            .attach('file', Buffer.from('{ this is not valid json at all'), 'broken.json');

        assert.ok(res.status >= 400, `a malformed import must be an error, got ${res.status}`);

        const after = listDir(IMPORT_DIR);
        assert.strictEqual(
            after.length, before,
            `the multer temp file leaked: ${IMPORT_DIR} now holds ${JSON.stringify(after)}`
        );
    });

    /**
     * The happy path is the control: it proves the cleanup was not simply moved somewhere it never runs.
     */
    it('POST /import: a well-formed upload is imported AND its temp file is cleaned up', async () => {
        const before = listDir(IMPORT_DIR).length;

        const res = await request(app)
            .post('/api/v1/import')
            .set('Authorization', `Bearer ${adminToken}`)
            .attach('file', Buffer.from(JSON.stringify({ version: '1.0', content: {} })), 'good.json');

        assert.strictEqual(res.status, 200, `expected the import to succeed, got ${res.status} ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.success, true);

        const after = listDir(IMPORT_DIR);
        assert.strictEqual(
            after.length, before,
            `the multer temp file leaked on the SUCCESS path: ${JSON.stringify(after)}`
        );
    });

    /**
     * Control for defect 2: the listing itself must still be built correctly. The fix moves the whole
     * callback body inside a try, so this guards the reindent against having changed any of it.
     */
    it('GET /fonts: a healthy directory still lists parsed families and variants', async () => {
        fs.mkdirSync(FONTS_DIR, { recursive: true });
        fs.writeFileSync(path.join(FONTS_DIR, 'Roboto-Regular.ttf'), 'not-really-a-font');
        fs.writeFileSync(path.join(FONTS_DIR, 'MyBrand-Bold.woff2'), 'not-really-a-font');

        const res = await request(app).get('/api/v1/fonts');
        assert.strictEqual(res.status, 200, `expected the listing, got ${res.status} ${JSON.stringify(res.body)}`);

        const byFile: Record<string, any> = Object.fromEntries(res.body.map((f: any) => [f.filename, f]));
        assert.strictEqual(byFile['Roboto-Regular.ttf'].family, 'Roboto');
        assert.strictEqual(byFile['Roboto-Regular.ttf'].variant, 'Regular');
        assert.strictEqual(byFile['Roboto-Regular.ttf'].protected, true);
        assert.strictEqual(byFile['MyBrand-Bold.woff2'].family, 'MyBrand');
        assert.strictEqual(byFile['MyBrand-Bold.woff2'].variant, 'Bold');
        assert.strictEqual(byFile['MyBrand-Bold.woff2'].url, '/uploads/fonts/MyBrand-Bold.woff2');
        // Protected fonts sort first.
        assert.strictEqual(res.body[0].filename, 'Roboto-Regular.ttf');
    });

    /**
     * DEFECT 2. A font name readdir returns but statSync cannot stat — the exact state the
     * readdir -> statSync race leaves behind. The route must answer 500; today the throw leaves the
     * handler entirely as an uncaughtException and the request is never answered.
     *
     * The temporary uncaughtException listener is EVIDENCE, not a workaround: without it Node's default
     * would tear the test runner down (and production's own handler calls process.exit(1)). Its contents
     * are asserted to be empty, so the listener cannot mask the defect.
     */
    it('GET /fonts: an unstattable entry answers 500 instead of escaping as an uncaught exception', async () => {
        fs.mkdirSync(FONTS_DIR, { recursive: true });
        fs.writeFileSync(path.join(FONTS_DIR, 'Roboto-Regular.ttf'), 'not-really-a-font');

        // Plant a REAL dangling link: readdir lists it, statSync follows it and throws ENOENT.
        const decoy = path.join(FONTS_DIR, '_gone');
        const dangling = path.join(FONTS_DIR, 'Ghost-Bold.ttf');
        fs.mkdirSync(decoy, { recursive: true });
        fs.symlinkSync(decoy, dangling, 'junction');
        fs.rmdirSync(decoy);
        assert.ok(listDir(FONTS_DIR).includes('Ghost-Bold.ttf'), 'readdir must still list the dangling entry');
        assert.throws(() => fs.statSync(dangling), /ENOENT/, 'the planted entry must be unstattable');

        const escaped: any[] = [];
        const capture = (err: any) => escaped.push(err);
        process.on('uncaughtException', capture);

        let res: any;
        try {
            res = await Promise.race([
                request(app).get('/api/v1/fonts'),
                new Promise((resolve) => setTimeout(() => resolve({ status: 'NO RESPONSE (timed out)' }), 3000))
            ]);
        } finally {
            process.removeListener('uncaughtException', capture);
        }

        assert.deepStrictEqual(
            escaped.map((e: any) => `${e && e.code}: ${e && e.message}`), [],
            'the throw escaped the handler as an uncaughtException — in production that is process.exit(1)'
        );
        assert.strictEqual(res.status, 500, `expected a 500 from the error handler, got ${JSON.stringify(res.status)}`);
    });
});
