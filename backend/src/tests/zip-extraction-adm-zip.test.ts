/**
 * WordJS — every path that READS a zip, after adm-zip 0.6.1.
 *
 * adm-zip 0.6.1 is a security release (decompression-bomb cap that a declared size of 0 can no
 * longer switch off, async inflate errors routed to the callback, duplicate entry names refused,
 * symlinks neither written through on extraction nor followed when archiving, SUID/SGID bits
 * dropped). Each of those is a behaviour change in a library that sits under four product paths:
 *
 *   · POST /themes/upload            → adm-zip's own extractAllTo()
 *   · installPluginFromZip()         → getEntries() + entry.getData(), written by us
 *   · restoreBackup()                → getEntries() + getEntry() + getData(), written by us
 *   · GET /plugins/:slug/download    → addLocalFolder() (archiving, not extracting)
 *
 * What this file pins, and why each case is here:
 *
 *  1. ARCHIVES FROM OTHER WRITERS STILL INSTALL. Our own tests build every zip with adm-zip, which
 *     STORES empty files and writes sizes in the local header. A zip from a streaming writer (the
 *     `zip` CLI on a pipe, archiver, Java's ZipOutputStream, .NET) DEFLATEs everything, puts the CRC
 *     and sizes in a trailing data descriptor and — the case 0.6.1 actually changed — deflates an
 *     EMPTY file to a 2-byte stream with a declared uncompressed size of 0. 0.6.0 skipped the output
 *     cap for size 0; 0.6.1 caps it at 1 byte. A legitimate empty file must still come out as an
 *     empty file on both the extractAllTo path and the getData path.
 *  2. DUPLICATE ENTRY NAMES ARE NOW REFUSED, AND REFUSED BEFORE ANYTHING IS WRITTEN. 0.6.0 kept both
 *     entries: getEntry() answered with the last one while the entry list held both, so a check run
 *     on one could approve different bytes than the ones written. 0.6.1 throws on open. Each of the
 *     three read paths must turn that into a refusal that leaves the disk untouched.
 *  3. ARCHIVING DOES NOT FOLLOW A LINK OUT OF THE FOLDER. The plugin download zips the plugin's
 *     directory; a symlink/junction inside it pointing elsewhere used to be dereferenced and its
 *     target's bytes shipped in the download. (Skipped only where no directory link can be created.)
 *
 * The zips for (1) and (2) are written byte by byte below, NOT with adm-zip: adm-zip's own writer
 * cannot produce either shape (it stores empty files and de-duplicates names on addFile), so a test
 * that built them with adm-zip would prove nothing about the archives this code receives.
 *
 * CWD sandbox first (PLUGINS_DIR and THEMES_DIR resolve from the CWD at module load), then the temp
 * DB, then the routers — the ordering used by plugin-orphaned-active.test.ts and
 * theme-upload-identity.test.ts.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const AdmZip = require('adm-zip');

// 1. Sandbox the process CWD FIRST.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-zip-paths-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
fs.mkdirSync(path.join(TMP_ROOT, 'plugins'), { recursive: true });
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer / routers load.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

const THEMES_DIR = path.join(TMP_ROOT, 'themes');
const PLUGINS_DIR = path.join(TMP_ROOT, 'plugins');
const ZIP_DIR = path.join(TMP_ROOT, 'zips');
// restoreBackup() reads from and writes under the REAL backend root, not the CWD.
const BACKEND_ROOT = path.resolve(__dirname, '../../');
const BACKUPS_DIR = path.join(BACKEND_ROOT, 'backups');

// ── A minimal STREAMING-WRITER zip, byte by byte ─────────────────────────────────────────────────────

const CRC_TABLE: Uint32Array = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build a zip the way a streaming writer does: every file DEFLATEd (an empty file included), the
 * local header's CRC/sizes zeroed with general-purpose bit 3 set, and the real values in a data
 * descriptor after the data; the central directory carries the real values. `null` content is a
 * directory entry. Names are written EXACTLY as given — duplicates included.
 */
function streamingWriterZip(entries: Array<[string, Buffer | null]>): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, content] of entries) {
        const isDir = content === null;
        const raw = isDir ? Buffer.alloc(0) : content;
        const method = isDir ? 0 : 8;
        const data: Buffer = isDir ? Buffer.alloc(0) : zlib.deflateRawSync(raw);
        const crc = crc32(raw);
        const nameBuf = Buffer.from(name, 'utf8');
        const flags = 0x0800 | (isDir ? 0 : 0x0008); // UTF-8 names; data descriptor for files

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10);          // time
        local.writeUInt16LE(0x5b21, 12);     // date (2025-09-01)
        if (isDir) local.writeUInt32LE(crc, 14); // a file's CRC and sizes stay 0 here: they are in the descriptor
        local.writeUInt16LE(nameBuf.length, 26);
        const parts: Buffer[] = [local, nameBuf, data];
        if (!isDir) {
            const dd = Buffer.alloc(16);
            dd.writeUInt32LE(0x08074b50, 0);
            dd.writeUInt32LE(crc, 4);
            dd.writeUInt32LE(data.length, 8);
            dd.writeUInt32LE(raw.length, 12);
            parts.push(dd);
        }
        const localRecord = Buffer.concat(parts);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(0x0314, 4);    // made by: UNIX
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0x5b21, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(((isDir ? 0o040755 : 0o100644) << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);

        locals.push(localRecord);
        centrals.push(Buffer.concat([central, nameBuf]));
        offset += localRecord.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}

const STYLE_CSS = Buffer.from('body { color: #222; }\n'.repeat(40));
const BENIGN_INDEX = Buffer.from("'use strict';\nmodule.exports = { register() {} };\n");

/** Every file entry of `entries` must be on disk under `root`, byte for byte. */
function assertExtracted(root: string, entries: Array<[string, Buffer | null]>) {
    for (const [name, content] of entries) {
        if (content === null) continue;
        const onDisk = path.join(root, ...name.split('/'));
        assert.ok(fs.existsSync(onDisk), `${name} was not extracted`);
        assert.ok(fs.readFileSync(onDisk).equals(content), `${name} is not byte-identical after extraction`);
    }
}

describe('zip read/write paths on adm-zip 0.6.1', () => {
    let request: any;
    let app: any;
    let adminToken: string;
    let installPluginFromZip: any, createInstallTmp: any;
    let restoreBackup: any;
    const installTmps: Array<{ dispose: () => void }> = [];
    const archives: string[] = [];
    const asAdmin = (r: any) => r.set('Authorization', `Bearer ${adminToken}`);

    const writeZip = (fileName: string, buf: Buffer): string => {
        fs.mkdirSync(ZIP_DIR, { recursive: true });
        const p = path.join(ZIP_DIR, fileName);
        fs.writeFileSync(p, buf);
        return p;
    };
    const pluginZipPath = (buf: Buffer): string => {
        const t = createInstallTmp();
        installTmps.push(t);
        fs.writeFileSync(t.zipPath, buf);
        return t.zipPath;
    };

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

        ({ installPluginFromZip, createInstallTmp } = require('../routes/plugins'));
        ({ restoreBackup } = require('../core/backup'));

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json());
        app.use('/api/v1/themes', require('../routes/themes'));
        app.use('/api/v1/plugins', require('../routes/plugins'));
        app.use(errorHandler);
    });

    after(async () => {
        for (const t of installTmps) { try { t.dispose(); } catch { /* */ } }
        for (const a of archives) { try { fs.unlinkSync(a); } catch { /* */ } }
        try { await database.closeDatabase(); } catch { /* */ }
        // Windows refuses to remove the CWD — step out of the temp root first.
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    // ── 1. archives from other writers ────────────────────────────────────────────────────────────────

    it('the fixture really is the shape adm-zip changed: a DEFLATEd empty file declaring size 0', () => {
        // Guard the guard: if the builder ever emitted a STORED empty file, the cases below would pass
        // on any adm-zip version and pin nothing.
        const buf = streamingWriterZip([['probe/empty.txt', Buffer.alloc(0)]]);
        const [entry] = new AdmZip(buf).getEntries();
        assert.strictEqual(entry.header.method, 8, 'the empty file must be DEFLATEd');
        assert.strictEqual(entry.header.size, 0, 'with a declared uncompressed size of 0');
        assert.ok(entry.header.compressedSize > 0, 'and a non-empty compressed stream');
        assert.strictEqual(entry.getData().length, 0);
    });

    it('theme upload (extractAllTo): a streaming-writer archive installs byte-exact, empty file included', async () => {
        const entries: Array<[string, Buffer | null]> = [
            ['streamed-theme/', null],
            ['streamed-theme/theme.json', Buffer.from(JSON.stringify({ name: 'streamed-theme', version: '1.0.0' }))],
            ['streamed-theme/style.css', STYLE_CSS],
            ['streamed-theme/assets/', null],
            ['streamed-theme/assets/.gitkeep', Buffer.alloc(0)],
        ];
        const zip = writeZip('streamed-theme.zip', streamingWriterZip(entries));
        const res = await asAdmin(request(app).post('/api/v1/themes/upload')).attach('theme', zip);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.slug, 'streamed-theme');
        assertExtracted(THEMES_DIR, entries);
        assert.strictEqual(fs.statSync(path.join(THEMES_DIR, 'streamed-theme', 'assets', '.gitkeep')).size, 0);
    });

    it('plugin install (getData): a streaming-writer archive installs byte-exact, empty file included', async () => {
        const slug = 'streamed-plugin';
        const entries: Array<[string, Buffer | null]> = [
            [`${slug}/`, null],
            [`${slug}/manifest.json`, Buffer.from(JSON.stringify({ name: slug, version: '1.0.0', isolated: true }))],
            [`${slug}/index.js`, BENIGN_INDEX],
            [`${slug}/README.md`, Buffer.from('# streamed\n'.repeat(30))],
            [`${slug}/data/.keep`, Buffer.alloc(0)],
        ];
        const r = await installPluginFromZip(pluginZipPath(streamingWriterZip(entries)), `${slug}.zip`);
        assert.strictEqual(r.ok, true, JSON.stringify(r.body));
        assert.strictEqual(r.body.slug, slug);
        assertExtracted(PLUGINS_DIR, entries);
        assert.strictEqual(fs.statSync(path.join(PLUGINS_DIR, slug, 'data', '.keep')).size, 0);
    });

    // ── 2. duplicate entry names ──────────────────────────────────────────────────────────────────────

    it('theme upload: a zip that names the same entry twice is refused and creates no theme directory', async () => {
        const before = fs.readdirSync(THEMES_DIR).sort();
        const zip = writeZip('dup-theme.zip', streamingWriterZip([
            ['dup-theme/theme.json', Buffer.from(JSON.stringify({ name: 'dup-theme', version: '1.0.0' }))],
            ['dup-theme/style.css', Buffer.from('/* the bytes a reviewer saw */')],
            ['dup-theme/style.css', Buffer.from('/* the bytes that would have landed */')],
        ]));
        const res = await asAdmin(request(app).post('/api/v1/themes/upload')).attach('theme', zip);
        assert.notStrictEqual(res.status, 200, JSON.stringify(res.body));
        assert.ok(!res.body || res.body.success !== true, JSON.stringify(res.body));
        assert.deepStrictEqual(fs.readdirSync(THEMES_DIR).sort(), before, 'no theme directory may appear');
    });

    it('plugin install: a zip that names the same entry twice is refused and writes nothing', async () => {
        const slug = 'dup-plugin';
        // Both copies are BENIGN on purpose: a hostile second copy would be refused by the AST scan on
        // any adm-zip version, and this case would then pin nothing about duplicates.
        const r = await installPluginFromZip(pluginZipPath(streamingWriterZip([
            [`${slug}/manifest.json`, Buffer.from(JSON.stringify({ name: slug, version: '1.0.0', isolated: true }))],
            [`${slug}/index.js`, BENIGN_INDEX],
            [`${slug}/index.js`, Buffer.from("'use strict';\nmodule.exports = { register() {}, copy: 2 };\n")],
        ])), `${slug}.zip`);
        assert.strictEqual(r.ok, false, JSON.stringify(r.body));
        assert.ok(r.status >= 400, `refusal must be an error status, got ${r.status}`);
        assert.strictEqual(fs.existsSync(path.join(PLUGINS_DIR, slug)), false, 'no plugin directory may appear');
    });

    it('backup restore: an archive that names the same entry twice aborts before writing anything', async () => {
        const probeName = `__wordjs_dup_entry_probe_${process.pid}__.txt`;
        const probe = path.join(BACKEND_ROOT, 'uploads', probeName);
        const filename = `wordjs-dup-entry-${process.pid}.zip`;
        fs.mkdirSync(BACKUPS_DIR, { recursive: true });
        const filepath = path.join(BACKUPS_DIR, filename);
        archives.push(filepath);
        fs.writeFileSync(filepath, streamingWriterZip([
            ['wordjs-content.json', Buffer.from(JSON.stringify({ version: '1', content: {}, settings: {} }))],
            [`uploads/${probeName}`, Buffer.from('first')],
            [`uploads/${probeName}`, Buffer.from('second')],
        ]));
        try {
            await assert.rejects(() => restoreBackup(filename), /duplicate entry/i);
            assert.strictEqual(fs.existsSync(probe), false, 'nothing may be restored from an ambiguous archive');
        } finally {
            try { fs.unlinkSync(probe); } catch { /* */ }
        }
    });

    // ── 3. archiving does not follow a symlink out of the folder ──────────────────────────────────────

    it('plugin download: a directory link pointing outside the plugin directory is not dereferenced into the zip', async (t: any) => {
        const slug = 'symlinked-plugin';
        const dir = path.join(PLUGINS_DIR, slug);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: slug, version: '1.0.0', isolated: true }));
        fs.writeFileSync(path.join(dir, 'index.js'), BENIGN_INDEX);
        const SECRET = `outside-secret-${process.pid}`;
        const outsideDir = path.join(TMP_ROOT, 'outside');
        fs.mkdirSync(outsideDir, { recursive: true });
        fs.writeFileSync(path.join(outsideDir, 'secret.txt'), SECRET);
        try {
            // A DIRECTORY link: 'junction' on Windows needs no privilege (a file symlink does), and the
            // type argument is ignored elsewhere, where this is an ordinary symlink. Both lstat as links.
            fs.symlinkSync(outsideDir, path.join(dir, 'leak'), 'junction');
        } catch (e: any) {
            t.skip(`cannot create a directory link here (${e.code || e.message})`);
            return;
        }
        const res = await asAdmin(request(app).get(`/api/v1/plugins/${slug}/download`))
            .buffer(true)
            .parse((r: any, cb: any) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
        assert.strictEqual(res.status, 200, String(res.body));
        const zip = new AdmZip(res.body);
        const names = zip.getEntries().map((e: any) => e.entryName);
        assert.ok(names.includes(`${slug}/index.js`), `the plugin's own files must be in the download: ${JSON.stringify(names)}`);
        assert.ok(!names.some((n: string) => n.includes('leak') || n.endsWith('secret.txt')),
            `the escaping link must not be archived: ${JSON.stringify(names)}`);
        for (const e of zip.getEntries()) {
            if (e.isDirectory) continue;
            assert.ok(!e.getData().toString('utf8').includes(SECRET), `${e.entryName} carries the outside file's bytes`);
        }
    });
});
