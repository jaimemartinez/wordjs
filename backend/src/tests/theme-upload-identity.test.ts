/**
 * POST /api/v1/themes/upload — WHICH directory does an uploaded zip become?
 *
 * THE DEFECT THIS PINS. The handler derived the theme's identity from `req.file.originalname` —
 * the multipart filename, a request field — while extraction is driven by the zip's ENTRIES. Two
 * consequences, and the second is the one that bites:
 *
 *   · a request value chose a path (`path.parse('...zip').name` is `..`; the parser dropping the
 *     directory part is a property of path.parse, not a containment proof); and
 *   · THE GUARD WAS NOT LOOKING AT THE WRITE. `astra-4.1.2.zip` containing `astra/` was checked for
 *     "already exists" against `themes/astra-4.1.2` — absent, so the upload proceeded — and then
 *     `extractAllTo(THEMES_DIR, true)` overwrote the INSTALLED `themes/astra` with overwrite=true.
 *     An admin uploading a theme could silently replace a different one, and no check could have
 *     stopped it because none of them named that directory.
 *
 * The Zip Slip loop had the matching gap: it proved containment in THEMES_DIR, so an entry could
 * legally land in a SIBLING theme's directory.
 *
 * These tests drive the real router through supertest and assert on the FILESYSTEM. Against the
 * pre-fix handler, "does not overwrite a different installed theme" and "a mismatched filename does
 * not decide the slug" go red; the plain-upload control is green on both sides.
 *
 * CWD-sandbox ordering copied from safe-path.test.ts: chdir into a temp root BEFORE requiring
 * anything that resolves paths from the CWD at module load (THEMES_DIR = path.resolve('./themes')).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the process CWD FIRST.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-theme-upload-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer / routers load.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

const THEMES_DIR = path.join(TMP_ROOT, 'themes');
const ZIP_DIR = path.join(TMP_ROOT, 'zips');

describe('POST /themes/upload — the zip\'s root folder is the theme, not the upload\'s filename', () => {
    let request: any;
    let app: any;
    let adminToken: string;
    const asAdmin = (r: any) => r.set('Authorization', `Bearer ${adminToken}`);

    /** Build a zip on disk and return its path. `entries` is {entryName: contents}. */
    const makeZip = (fileName: string, entries: Record<string, string>): string => {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        for (const [name, body] of Object.entries(entries)) zip.addFile(name, Buffer.from(body));
        fs.mkdirSync(ZIP_DIR, { recursive: true });
        const p = path.join(ZIP_DIR, fileName);
        zip.writeZip(p);
        return p;
    };

    const themeEntries = (root: string, marker: string) => ({
        [`${root}/theme.json`]: JSON.stringify({ name: root, version: '1.0.0' }),
        [`${root}/style.css`]: `/* ${marker} */\n`,
    });

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        const dbAsync = database.getDbAsync();
        await dbAsync.run('INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)',
            ['admin', 'x', 'admin@example.com', 'Administrator']);
        const admin = await dbAsync.get("SELECT id FROM users WHERE user_login = 'admin'");
        await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')", [admin.id]);
        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json({ limit: '2mb' }));
        app.use('/api/v1/themes', require('../routes/themes'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('installs a normal theme zip (the control)', async () => {
        const zip = makeZip('plain-theme.zip', themeEntries('plain-theme', 'original'));
        const res = await asAdmin(request(app).post('/api/v1/themes/upload')).attach('theme', zip);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.slug, 'plain-theme');
        assert.ok(fs.existsSync(path.join(THEMES_DIR, 'plain-theme', 'theme.json')));
    });

    it('a zip whose FILENAME differs from its root folder installs under the ROOT FOLDER', async () => {
        // The everyday case that used to report the wrong slug: a versioned download name.
        const zip = makeZip('versioned-1.2.3.zip', themeEntries('versioned', 'v123'));
        const res = await asAdmin(request(app).post('/api/v1/themes/upload')).attach('theme', zip);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.slug, 'versioned', 'the slug reported must be the directory created');
        assert.ok(fs.existsSync(path.join(THEMES_DIR, 'versioned', 'style.css')));
        assert.strictEqual(fs.existsSync(path.join(THEMES_DIR, 'versioned-1.2.3')), false);
    });

    it('CANNOT silently overwrite a DIFFERENT installed theme by renaming the zip', async () => {
        // `plain-theme` is installed (first test). Post a zip called something else whose root
        // folder IS plain-theme: pre-fix the "already exists" probe looked at themes/decoy-name,
        // found nothing, and extractAllTo(…, true) clobbered themes/plain-theme.
        const zip = makeZip('decoy-name.zip', themeEntries('plain-theme', 'REPLACED'));
        const res = await asAdmin(request(app).post('/api/v1/themes/upload')).attach('theme', zip);
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.match(res.body.error, /already exists/);
        const css = fs.readFileSync(path.join(THEMES_DIR, 'plain-theme', 'style.css'), 'utf8');
        assert.ok(css.includes('original'), 'the installed theme must be byte-intact');
        assert.ok(!css.includes('REPLACED'), 'the upload must not have overwritten it');
    });

    it('an entry that escapes its own theme directory is refused, and writes nothing', async () => {
        const before = fs.readdirSync(THEMES_DIR).sort();
        const cases: Array<[string, Record<string, string>]> = [
            ['sibling write', { 'evil/theme.json': '{}', 'evil/../plain-theme/style.css': '/* HIJACKED */' }],
            ['parent escape', { 'evil/theme.json': '{}', '../escaped.css': '/* out */' }],
            ['absolute entry', { 'evil/theme.json': '{}', '/tmp/wordjs-escaped.css': '/* out */' }],
        ];
        for (const [label, entries] of cases) {
            const zip = makeZip(`escape-${label.replace(/\W+/g, '-')}.zip`, entries);
            const res = await asAdmin(request(app).post('/api/v1/themes/upload')).attach('theme', zip);
            assert.strictEqual(res.status, 400, `${label}: ${JSON.stringify(res.body)}`);
        }
        assert.deepStrictEqual(fs.readdirSync(THEMES_DIR).sort(), before, 'no theme directory may appear');
        assert.strictEqual(fs.existsSync(path.join(TMP_ROOT, 'escaped.css')), false);
        assert.ok(fs.readFileSync(path.join(THEMES_DIR, 'plain-theme', 'style.css'), 'utf8').includes('original'));
    });

    it('a root folder that is not a valid theme directory name is refused', async () => {
        for (const root of ['-leading-dash', '_leading-underscore', 'has space', 'dot.in.name']) {
            const zip = makeZip(`bad-root-${root.replace(/\W+/g, '-')}.zip`, themeEntries(root, 'x'));
            const res = await asAdmin(request(app).post('/api/v1/themes/upload')).attach('theme', zip);
            assert.strictEqual(res.status, 400, `${root}: ${JSON.stringify(res.body)}`);
            assert.match(res.body.error, /Invalid theme folder/);
        }
    });

    it('a zip with more than one root folder is refused rather than half-installed', async () => {
        const zip = makeZip('two-roots.zip', { ...themeEntries('root-a', 'a'), ...themeEntries('root-b', 'b') });
        const res = await asAdmin(request(app).post('/api/v1/themes/upload')).attach('theme', zip);
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.match(res.body.error, /exactly one top-level folder/);
        assert.strictEqual(fs.existsSync(path.join(THEMES_DIR, 'root-a')), false);
        assert.strictEqual(fs.existsSync(path.join(THEMES_DIR, 'root-b')), false);
    });
});
