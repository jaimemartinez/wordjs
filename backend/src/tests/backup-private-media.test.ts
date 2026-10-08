/**
 * WordJS — PRIVATE media survives a backup round trip, and only into the configured private root.
 *
 * Private attachments (core/private-media.ts) live under config.uploads.privateDir — by default
 * data/private-uploads, deliberately OUTSIDE the uploads/ tree that is served statically. The backup
 * walked only uploads/, plugins/ and themes/, so a backup taken after the first private upload restored
 * attachment rows whose files were gone: the product a customer paid for answered 404 after a restore.
 *
 * Locked here, through the real createBackup()/restoreBackup() exports and real archives on disk:
 *   - createBackup() carries every private file under its own top-level name, `private-uploads/<rel>`,
 *     and never under uploads/ (which would make a restore drop it into the public tree);
 *   - restoreBackup() writes those entries back into the CONFIGURED private root — not next to the code
 *     as backend/private-uploads, where nothing would find them;
 *   - a `private-uploads/../…` entry aborts the whole restore before anything is written, like the other
 *     content roots (audit #4), and a bare `private-uploads` entry names no file and is skipped.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_DB = path.join(os.tmpdir(), `wordjs-backup-private-${STAMP}.db`);
const PRIVATE_ROOT = path.join(os.tmpdir(), `wordjs-private-uploads-${STAMP}`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
config.uploads.privateDir = PRIVATE_ROOT;

const BACKEND_ROOT = path.resolve(__dirname, '../../');
const BACKUPS_DIR = path.join(BACKEND_ROOT, 'backups');
const CONTENT_JSON = JSON.stringify({ version: '1', content: {}, settings: {} });
const S3_KEYS = ['WORDJS_S3_BUCKET', 'WORDJS_S3_ACCESS_KEY_ID', 'WORDJS_S3_SECRET_ACCESS_KEY',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'WORDJS_S3_ENDPOINT'];

let database: any;
let createBackup: any;
let restoreBackup: any;
let deleteBackup: any;
const archives: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

/** A zip whose entry names are EXACTLY as given (adm-zip normalizes on addFile; other writers do not). */
function writeRawZip(filename: string, entries: Array<[string, string]>): string {
    const zip = new AdmZip();
    entries.forEach(([, data], i) => zip.addFile(`placeholder-${i}`, Buffer.from(data, 'utf8')));
    const written = zip.getEntries();
    entries.forEach(([name], i) => { written[i].entryName = name; });
    const filepath = path.join(BACKUPS_DIR, filename);
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    zip.writeZip(filepath);
    archives.push(filepath);
    return filepath;
}

describe('backups carry private media and restore it into the private root', () => {
    before(async () => {
        // The pure on-host path: no S3 offload, no network.
        for (const k of S3_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
        database = require('../config/database');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        ({ createBackup, restoreBackup, deleteBackup } = require('../core/backup'));
    });

    after(async () => {
        for (const file of archives) { try { fs.unlinkSync(file); } catch { /* */ } }
        try { await database.closeDatabase(); } catch { /* */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* */ } }
        try { fs.rmSync(PRIVATE_ROOT, { recursive: true, force: true }); } catch { /* */ }
        try { fs.rmSync(path.join(BACKEND_ROOT, 'private-uploads'), { recursive: true, force: true }); } catch { /* */ }
        for (const k of S3_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    });

    test('createBackup() archives every private file under private-uploads/, never under uploads/', async () => {
        fs.mkdirSync(path.join(PRIVATE_ROOT, '2026', '10'), { recursive: true });
        fs.writeFileSync(path.join(PRIVATE_ROOT, '2026', '10', 'ebook.pdf'), 'paid content');
        fs.writeFileSync(path.join(PRIVATE_ROOT, 'top-level.bin'), 'second file');

        const result = await createBackup();
        const zipPath = path.join(BACKUPS_DIR, result.filename);
        archives.push(zipPath);
        try {
            const zip = new AdmZip(zipPath);
            const names = zip.getEntries().map((e: any) => e.entryName);
            assert.ok(names.includes('private-uploads/2026/10/ebook.pdf'), `nested private file missing from the backup: ${names.filter((n: string) => /private|ebook/.test(n)).join(', ') || '(none)'}`);
            assert.ok(names.includes('private-uploads/top-level.bin'), 'top-level private file missing from the backup');
            assert.strictEqual(zip.readAsText('private-uploads/2026/10/ebook.pdf'), 'paid content');
            assert.ok(!names.some((n: string) => n.startsWith('uploads/') && /ebook\.pdf$/.test(n)),
                'a private file was archived under uploads/ — a restore would publish it');
        } finally {
            try { deleteBackup(result.filename); } catch { /* */ }
        }
    });

    test('restoreBackup() writes private entries into the configured private root, not next to the code', async () => {
        const filename = `wordjs-private-restore-${STAMP}.zip`;
        writeRawZip(filename, [
            ['wordjs-content.json', CONTENT_JSON],
            ['private-uploads/2027/01/restored.pdf', 'restored bytes'],
        ]);
        const target = path.join(PRIVATE_ROOT, '2027', '01', 'restored.pdf');
        try { fs.rmSync(target, { force: true }); } catch { /* */ }

        await restoreBackup(filename);

        assert.ok(fs.existsSync(target), 'the private file was not restored into config.uploads.privateDir');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'restored bytes');
        assert.ok(!fs.existsSync(path.join(BACKEND_ROOT, 'private-uploads', '2027', '01', 'restored.pdf')),
            'the private file was restored next to the code (backend/private-uploads) instead of the private root');
    });

    test('a private-uploads entry that climbs out aborts the restore and writes nothing', async () => {
        const filename = `wordjs-private-traversal-${STAMP}.zip`;
        const escapeName = `wordjs-private-escape-${STAMP}.txt`;
        writeRawZip(filename, [
            ['wordjs-content.json', CONTENT_JSON],
            ['private-uploads/ok.bin', 'written only if the restore proceeds'],
            [`private-uploads/../${escapeName}`, 'escaped'],
        ]);
        await assert.rejects(() => restoreBackup(filename), /path traversal/i);
        assert.ok(!fs.existsSync(path.join(PRIVATE_ROOT, 'ok.bin')), 'an entry was written before the traversal aborted the restore');
        assert.ok(!fs.existsSync(path.join(BACKEND_ROOT, escapeName)), 'the traversing entry was written next to the code');
        assert.ok(!fs.existsSync(path.join(path.dirname(PRIVATE_ROOT), escapeName)), 'the traversing entry escaped the private root');
    });
});
