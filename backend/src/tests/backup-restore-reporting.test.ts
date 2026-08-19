/**
 * WordJS — a restore that could not do everything must SAY SO to its caller.
 *
 * THE CLASS: an operation here can finish PARTIALLY — an archive entry it could not write, a
 * physical snapshot it could not restore, a cache it could not flush — and every one of those used
 * to be reported to `console.warn` alone while the value handed back was shaped like a total
 * success. `POST /backups/:file/restore` then answered `{success:true}` and the operator concluded
 * that the disaster recovery had brought everything back. Round 1 asked for "a named warning in the
 * restore SUMMARY"; only the skipping half was built, so the lie moved rather than went away.
 *
 * The tests below drive the REAL restore over a REAL archive on disk and assert on what the CALLER
 * receives — never on the log, because the log is exactly what nobody sees during a recovery.
 *
 * They also lock the JOURNEY the skipping exists to protect: a backup carrying a name this
 * filesystem cannot represent must still RESTORE (that was audit #18's regression — a whole recovery
 * refused because of one file name), and every representable file must land.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-restore-report-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const BACKEND_ROOT = path.resolve(__dirname, '../../');
const BACKUPS_DIR = path.join(BACKEND_ROOT, 'backups');
const UPLOADS_DIR = path.join(BACKEND_ROOT, 'uploads');
const CONTENT_JSON = JSON.stringify({ version: '1', content: {}, settings: {} });

let database: any;
let restoreBackup: any;
const written: string[] = [];
const archives: string[] = [];

/** A zip whose entry names are EXACTLY as given (adm-zip normalizes on addFile; writers do not). */
function writeRawZip(filename: string, entries: Array<[string, string]>): string {
    const zip = new AdmZip();
    entries.forEach(([, data], i) => zip.addFile(`placeholder-${i}`, Buffer.from(data, 'utf8')));
    const written2 = zip.getEntries();
    entries.forEach(([name], i) => { written2[i].entryName = name; });
    const filepath = path.join(BACKUPS_DIR, filename);
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    zip.writeZip(filepath);
    archives.push(filepath);
    return filepath;
}

before(async () => {
    database = require('../config/database');
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    ({ restoreBackup } = require('../core/backup'));
});

after(async () => {
    for (const f of written) { try { fs.unlinkSync(f); } catch { /* */ } }
    for (const f of archives) { try { fs.unlinkSync(f); } catch { /* */ } }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* */ } }
});

// Names a restore cannot write here but that are perfectly legal inside an archive: resolveWithin
// refuses a ':' or a backslash segment (NTFS alternate data streams, separator ambiguity). One entry
// per member so the assertion is about the CLASS of unwritable name, not about one example.
const UNREPRESENTABLE = [
    'uploads/2026/08/design:2x.png',
    'plugins/demo/weird:name.js'
];
// NOT a member, and the difference matters: a backslash in an entry name is a SEPARATOR (the restore
// normalizes it before resolving), so such an entry is written as a nested path rather than skipped.
// Asserted below so "skipped" never quietly grows to cover names that can in fact be restored.
const BACKSLASH_ENTRY = 'uploads/__wordjs_report_dir__\\nested.txt';

test('a restore that skipped entries reports them TO THE CALLER, not only to the log', async () => {
    const good = path.join(UPLOADS_DIR, '__wordjs_restore_report_probe__.txt');
    written.push(good);
    const filename = `wordjs-restore-report-${process.pid}.zip`;
    const nested = path.join(UPLOADS_DIR, '__wordjs_report_dir__', 'nested.txt');
    written.push(nested);
    writeRawZip(filename, [
        ['wordjs-content.json', CONTENT_JSON],
        ['uploads/__wordjs_restore_report_probe__.txt', 'restored'],
        [BACKSLASH_ENTRY, 'nested'],
        ...UNREPRESENTABLE.map((n) => [n, 'x'] as [string, string])
    ]);

    const result = await restoreBackup(filename);

    // 1. THE JOURNEY: a disaster recovery is the one operation that must not refuse to run. The
    //    representable file is on disk and the call did not throw.
    assert.ok(fs.existsSync(good), 'every entry that CAN be written must be written');
    assert.strictEqual(fs.readFileSync(good, 'utf8'), 'restored');
    assert.ok(fs.existsSync(nested),
        'a backslash is a separator, not an unwritable character — this entry must be RESTORED, not counted as skipped');

    // 2. THE REPORT: what did not happen travels with the result.
    assert.strictEqual(result.complete, false,
        'a restore that dropped files is not complete, and the caller must be able to see that without reading stdout');
    assert.ok(Array.isArray(result.incidents) && result.incidents.length >= 1, 'the result carries an incident list');
    const files = result.incidents.find((i: any) => i.stage === 'files');
    assert.ok(files, `no 'files' incident in ${JSON.stringify(result.incidents)}`);
    // EVERY skipped entry is named — a count alone does not tell the operator which image is now
    // missing while the database still points at it.
    for (const name of UNREPRESENTABLE) {
        assert.ok(files.items.includes(name),
            `${name} was skipped but is not named in the report: ${JSON.stringify(files.items)}`);
    }
    assert.strictEqual(files.items.length, UNREPRESENTABLE.length, 'nothing else was silently dropped');
});

test('a restore that did everything reports complete, with an EMPTY incident list', async () => {
    const good = path.join(UPLOADS_DIR, '__wordjs_restore_clean_probe__.txt');
    written.push(good);
    const filename = `wordjs-restore-clean-${process.pid}.zip`;
    writeRawZip(filename, [
        ['wordjs-content.json', CONTENT_JSON],
        ['uploads/__wordjs_restore_clean_probe__.txt', 'restored']
    ]);

    const result = await restoreBackup(filename);

    assert.ok(fs.existsSync(good));
    assert.strictEqual(result.complete, true,
        'complete must MEAN something: if it is true when files were dropped, it is decoration');
    assert.deepStrictEqual(result.incidents, []);
    // …and the operation's own result is still there — the envelope adds, it does not replace.
    assert.ok(Object.keys(result).some((k) => k !== 'complete' && k !== 'incidents'),
        'the caller still receives what the restore produced');
});

test('an archive that is not a backup still ABORTS — partial reporting is not permission to continue', async () => {
    const filename = `wordjs-restore-notabackup-${process.pid}.zip`;
    writeRawZip(filename, [['uploads/only.txt', 'x']]);
    await assert.rejects(() => restoreBackup(filename), /wordjs-content\.json missing/i);
});

test('an entry that points OUTSIDE its content root still aborts the whole restore', async () => {
    // The difference this file must keep visible: "unrepresentable" is skipped and reported,
    // "hostile" is refused. Softening the second into the first is how the traversal fix would die.
    const filename = `wordjs-restore-hostile-${process.pid}.zip`;
    const probe = path.join(BACKEND_ROOT, 'dist', '__wordjs_report_probe__.js');
    writeRawZip(filename, [
        ['wordjs-content.json', CONTENT_JSON],
        ['themes/../dist/__wordjs_report_probe__.js', 'module.exports = "pwned";']
    ]);
    try {
        await assert.rejects(() => restoreBackup(filename), /path traversal/i);
        assert.ok(!fs.existsSync(probe), 'and nothing is written');
    } finally {
        try { fs.unlinkSync(probe); } catch { /* */ }
    }
});
