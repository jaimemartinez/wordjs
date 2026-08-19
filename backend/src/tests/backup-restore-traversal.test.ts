/**
 * WordJS — restoring a backup may not write outside the content roots (audit #4).
 *
 * The old guard checked ONE string and used ANOTHER: `name.startsWith('themes/')` on the RAW entry
 * name, then `path.resolve(backendRoot, name)` for the write, with containment proved against
 * backendRoot instead of the content root the prefix claimed. `themes/../dist/index.js` satisfies
 * both and lands on compiled code — an admin→RCE primitive from an archive received from a third
 * party (there is no upload endpoint; the operator drops the file in backend/backups/).
 *
 * The zip here is a REAL archive on disk, written with the entry name the attacker controls. That
 * matters: `AdmZip.addFile()` normalizes names, so a bundle built the ordinary way could never carry
 * this entry — the name is set on the entry afterwards, which is what a non-adm-zip writer does. And
 * restoreBackup() is called through its real export, so the archive travels the real read path
 * (adm-zip does not canonicalize entry names on READ).
 *
 * Second property locked here: wordjs-content.json is validated BEFORE the extraction loop, so an
 * archive that turns out not to be a backup cannot already have dropped files on disk.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const BACKEND_ROOT = path.resolve(__dirname, '../../');
const BACKUPS_DIR = path.join(BACKEND_ROOT, 'backups');

const CONTENT_JSON = JSON.stringify({ version: '1', content: {}, settings: {} });

/**
 * Write a zip whose entry names are EXACTLY as given (bypassing addFile's normalization, which is how
 * any non-adm-zip writer emits them).
 */
function writeRawZip(filename: string, entries: Array<[string, string]>): string {
    const zip = new AdmZip();
    entries.forEach(([, data], i) => zip.addFile(`placeholder-${i}`, Buffer.from(data, 'utf8')));
    const written = zip.getEntries();
    entries.forEach(([name], i) => { written[i].entryName = name; });
    const filepath = path.join(BACKUPS_DIR, filename);
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    zip.writeZip(filepath);
    return filepath;
}

test('audit #4: a backup entry that escapes its content root aborts the restore and writes nothing', async () => {
    const { restoreBackup } = require('../core/backup');
    const filename = `wordjs-traversal-test-${process.pid}.zip`;
    // `dist/` is what production actually runs, so this is the practical target named in the audit.
    const probe = path.join(BACKEND_ROOT, 'dist', '__wordjs_traversal_probe__.js');
    const filepath = writeRawZip(filename, [
        ['wordjs-content.json', CONTENT_JSON],
        ['themes/../dist/__wordjs_traversal_probe__.js', 'module.exports = "pwned";']
    ]);

    try {
        // Sanity: the entry really did survive into the archive un-normalized.
        const names = new AdmZip(filepath).getEntries().map((e: any) => e.entryName);
        assert.ok(names.includes('themes/../dist/__wordjs_traversal_probe__.js'),
            'the test archive must carry the raw traversing name, or it proves nothing');

        await assert.rejects(
            () => restoreBackup(filename),
            /path traversal/i,
            'the restore must abort, not skip the entry and carry on');
        assert.ok(!fs.existsSync(probe), 'nothing may be written outside <backendRoot>/{uploads,plugins,themes}');
    } finally {
        try { fs.unlinkSync(filepath); } catch { /* */ }
        try { fs.unlinkSync(probe); } catch { /* */ }
    }
});

test('audit #4: the abort happens before ANY entry is written, whatever order the archive puts them in', async () => {
    // The entry order is the ARCHIVE AUTHOR'S choice. Validating and writing in one pass meant a
    // hostile zip could put legitimate entries in FRONT of its traversal entry: those landed on disk
    // and only then did the restore abort — so "the restore was rejected" and "nothing was written"
    // stopped being the same statement, with plugin code already planted under backend/plugins/.
    const { restoreBackup } = require('../core/backup');
    const filename = `wordjs-partial-write-test-${process.pid}.zip`;
    const planted = path.join(BACKEND_ROOT, 'plugins', '__wordjs_planted_probe__', 'index.js');
    const probe = path.join(BACKEND_ROOT, 'dist', '__wordjs_traversal_probe2__.js');
    const filepath = writeRawZip(filename, [
        ['wordjs-content.json', CONTENT_JSON],
        // 1. Perfectly legitimate, and FIRST.
        ['plugins/__wordjs_planted_probe__/index.js', 'module.exports = "planted";'],
        // 2. A file name a colon makes unrepresentable here, but that is NOT an attack (see below).
        //    NOTE adm-zip returns entries SORTED, so this really is examined before the traversal:
        //    'plugins/…' < 'themes/…'. If a colon still aborted the restore, the error below would
        //    name THIS entry.
        ['plugins/__wordjs_planted_probe__/design:2x.png', 'PNG'],
        // 3. The traversal, LAST.
        ['themes/../dist/__wordjs_traversal_probe2__.js', 'module.exports = "pwned";']
    ]);

    try {
        await assert.rejects(
            () => restoreBackup(filename),
            (err: any) => {
                assert.match(err.message, /path traversal/i);
                assert.match(err.message, /themes\/\.\.\/dist/, 'the entry named must be the one that actually escapes');
                assert.doesNotMatch(err.message, /design:2x\.png/,
                    "a colon is legal in a POSIX file name — an entry that merely cannot be written here is not a hostile archive, and calling it one aborts a disaster recovery");
                return true;
            });
        assert.ok(!fs.existsSync(probe), 'nothing may be written outside the content roots');
        assert.ok(!fs.existsSync(planted),
            'an entry that precedes the hostile one must NOT be on disk: validation is a whole pass, writing is the next one');
    } finally {
        try { fs.unlinkSync(filepath); } catch { /* */ }
        try { fs.unlinkSync(probe); } catch { /* */ }
        try { fs.rmSync(path.join(BACKEND_ROOT, 'plugins', '__wordjs_planted_probe__'), { recursive: true, force: true }); } catch { /* */ }
    }
});

test('audit #4: an archive that is not a backup is rejected BEFORE any file is written', async () => {
    const { restoreBackup } = require('../core/backup');
    const filename = `wordjs-nobackup-test-${process.pid}.zip`;
    const dropped = path.join(BACKEND_ROOT, 'uploads', '__wordjs_premature_write_probe__.txt');
    const filepath = writeRawZip(filename, [
        // A perfectly legal content-root entry — but no wordjs-content.json anywhere.
        ['uploads/__wordjs_premature_write_probe__.txt', 'should never reach disk']
    ]);

    try {
        await assert.rejects(() => restoreBackup(filename), /wordjs-content\.json missing/i);
        assert.ok(!fs.existsSync(dropped),
            'validation must precede the extraction loop, or a rejected archive still lands on disk');
    } finally {
        try { fs.unlinkSync(filepath); } catch { /* */ }
        try { fs.unlinkSync(dropped); } catch { /* */ }
    }
});
