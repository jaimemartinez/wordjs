/**
 * POST /db-migration/cleanup NEVER DELETES THE DATABASE THE SITE IS RUNNING ON.
 *
 * The cleanup removes a leftover database from data/ after an engine migration. It checked only that the
 * name was one of three (`wordjs.db`, `wordjs-native.db`, `postgres-embed`), never which one the site was
 * using: `{file: 'wordjs-native.db'}` unlinked the live default SQLite file and its -wal/-shm, and an
 * administrator's API token could send it. The status screen hid the live file only by DRIVER NAME, so
 * where the driver and the file name disagree — the pure-JS fallback the native driver degrades to reads
 * the same `wordjs-native.db`, and the installer pins dbPath — it even offered the live file for deletion.
 *
 * Now the files of the active database are worked out from what the site opened (the configured path and
 * the path the async driver holds) and compared under every spelling — a junction on the way, another
 * letter case on Windows — and a cleanup that would touch one is refused (409) before anything is deleted;
 * the route takes an interactive session (accountAuthorityOnly, as /migrate does). A stale file is still
 * cleaned, companions included. The twin: /migrate writes a SQLite target to data/<its default name> and
 * deletes what is there at the swap, so a target that is the live file is refused before anything runs.
 *
 * The live database here is a real SQLite file in a temporary directory that the process works from for
 * the duration (the handlers resolve data/ against the working directory), so nothing under backend/data
 * is ever touched. Deletions are recorded at fs.unlinkSync/fs.rmSync: on Windows the OS refuses to
 * unlink a file SQLite holds open, so "the file survived" alone would not show the attempt there.
 *
 * MUTATION PROOF: drop the belongsToActiveDatabase check from cleanup and the live-file tests record an
 * unlink of the live database (Linux: the file is gone); drop accountAuthorityOnly from the route and the
 * token deletes the stale file; go back to the driver-name rule in getStatus and the degraded-driver test
 * is offered the live file; drop the /migrate check and the migration starts (and writes its .tmp).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const ORIGINAL_CWD = process.cwd();
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-dbclean-')));
const SITE = path.join(ROOT, 'site');
const DATA = path.join(SITE, 'data');
const ALIAS = path.join(ROOT, 'alias'); // a junction (a directory symlink elsewhere) to SITE
fs.mkdirSync(DATA, { recursive: true });
const LIVE = path.join(DATA, 'wordjs-native.db');

const config = require('../config/app');
config.dbPath = LIVE;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const { csrfProtection } = require('../middleware/auth');
const configManager = require('../core/configManager');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const B = config.api.prefix;
const SECRET = config.jwt.secret;
const PASSWORD = 'Correct-Horse-9!';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(B, csrfProtection);
require('../core/db-admin').register(app);
app.use(B, require('../routes'));

let dbAsync: any;
let ownerId = 0;
let token = '';
const session = () => `Bearer ${jwt.sign({ userId: ownerId, username: 'owner' }, SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
const cleanup = (auth: string, file: string) => request(app).post(`${B}/db-migration/cleanup`).set('Authorization', auth).send({ file });

/** Every path fs.unlinkSync / fs.rmSync was asked to delete while `fn` ran. */
async function deletionsDuring(fn: () => Promise<any>): Promise<{ result: any; deleted: string[] }> {
    const deleted: string[] = [];
    const { unlinkSync, rmSync } = fs;
    fs.unlinkSync = (p: any, ...rest: any[]) => { deleted.push(path.resolve(String(p))); return unlinkSync.call(fs, p, ...rest); };
    fs.rmSync = (p: any, ...rest: any[]) => { deleted.push(path.resolve(String(p))); return rmSync.call(fs, p, ...rest); };
    try { return { result: await fn(), deleted }; }
    finally { fs.unlinkSync = unlinkSync; fs.rmSync = rmSync; }
}

const LIVE_FILES = () => ['', '-wal', '-shm'].map((s) => LIVE + s);
const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
function assertLiveUntouched(deleted: string[], label: string) {
    const real = (p: string) => { try { return fs.realpathSync.native(p); } catch { return p; } };
    for (const d of deleted) {
        for (const f of LIVE_FILES()) {
            assert.ok(!same(real(d), f) && !same(d, f), `${label}: a delete of the live database was attempted (${d})`);
        }
    }
    for (const f of LIVE_FILES()) assert.ok(fs.existsSync(f), `${label}: ${path.basename(f)} is gone`);
}
/** The site still reads and writes its database. */
async function assertDatabaseAnswers(label: string) {
    await dbAsync.run("INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, 'no') ON CONFLICT (option_name) DO UPDATE SET option_value = excluded.option_value", ['dbclean_probe', label]);
    const row = await dbAsync.get("SELECT option_value FROM options WHERE option_name = 'dbclean_probe'");
    assert.strictEqual(row && row.option_value, label, `${label}: the database no longer answers`);
}
function writeStale(name: string, companions = ['-wal', '-shm', '-journal']) {
    fs.writeFileSync(path.join(DATA, name), 'stale database');
    for (const s of companions) fs.writeFileSync(path.join(DATA, name + s), 'stale');
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await roles.loadRoles();
    const r = await dbAsync.run('INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)',
        ['owner', bcrypt.hashSync(PASSWORD, 10), 'owner@example.com', 'owner']);
    ownerId = r.lastID;
    await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')", [ownerId]);
    const minted = await request(app).post(`${B}/auth/tokens`).set('Authorization', session()).send({ name: 'ci', scopes: 'write' });
    assert.strictEqual(minted.status, 201, JSON.stringify(minted.body));
    token = minted.body.token;
    fs.symlinkSync(SITE, ALIAS, 'junction');
    process.chdir(SITE);
    for (const f of LIVE_FILES()) assert.ok(fs.existsSync(f), `precondition: ${path.basename(f)} exists (WAL mode)`);
});

after(async () => {
    process.chdir(ORIGINAL_CWD);
    try { await database.closeDatabase(); } catch { /* */ }
    // The junction first, on its own: a recursive delete must never walk through it.
    try { fs.rmdirSync(ALIAS); } catch { /* */ }
    if (!fs.existsSync(ALIAS)) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ } }
});

describe('the live database is never deleted', () => {
    it('{file: wordjs-native.db} while the site runs on it: refused, nothing deleted, the site keeps working', async () => {
        const { result: res, deleted } = await deletionsDuring(() => cleanup(session(), 'wordjs-native.db'));
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'db_cleanup_active_database');
        assertLiveUntouched(deleted, 'default path');
        await assertDatabaseAnswers('after the default-path attempt');
    });

    it('reached through another spelling of data/ (a junction): still the live database', async () => {
        process.chdir(ALIAS);
        try {
            assert.notStrictEqual(path.resolve('./data', 'wordjs-native.db'), LIVE, 'precondition: the request names the file differently');
            const { result: res, deleted } = await deletionsDuring(() => cleanup(session(), 'wordjs-native.db'));
            assert.strictEqual(res.status, 409, JSON.stringify(res.body));
            assertLiveUntouched(deleted, 'junction');
        } finally { process.chdir(SITE); }
        await assertDatabaseAnswers('after the junction attempt');
    });

    it('reached through another letter case (Windows): still the live database', { skip: process.platform !== 'win32' }, async () => {
        process.chdir(SITE.toUpperCase());
        try {
            assert.notStrictEqual(path.resolve('./data', 'wordjs-native.db'), LIVE, 'precondition: spelled differently');
            const { result: res, deleted } = await deletionsDuring(() => cleanup(session(), 'wordjs-native.db'));
            assert.strictEqual(res.status, 409, JSON.stringify(res.body));
            assertLiveUntouched(deleted, 'case');
        } finally { process.chdir(SITE); }
    });

    it('the driver fell back to the pure-JS one, which reads the same wordjs-native.db: not offered, not deleted', async () => {
        // database.ts: when better-sqlite3 cannot load, 'sqlite-legacy' runs on config.dbPath — the
        // native driver's file. The status screen judged by driver name and offered that file for cleanup.
        const original = database.getDbType;
        database.getDbType = () => ({ ...original(), driver: 'sqlite-legacy' });
        try {
            const status = await request(app).get(`${B}/db-migration/status`).set('Authorization', session());
            assert.strictEqual(status.status, 200, JSON.stringify(status.body));
            assert.strictEqual(status.body.currentDriver, 'sqlite-legacy', 'precondition: the degraded driver');
            assert.ok(!status.body.legacyFiles.includes('wordjs-native.db'), `the live file is offered for deletion: ${JSON.stringify(status.body.legacyFiles)}`);
            const { result: res, deleted } = await deletionsDuring(() => cleanup(session(), 'wordjs-native.db'));
            assert.strictEqual(res.status, 409, JSON.stringify(res.body));
            assertLiveUntouched(deleted, 'degraded driver');
        } finally { database.getDbType = original; }
        await assertDatabaseAnswers('after the degraded-driver attempt');
    });
});

describe('a stale database is still cleaned — by an interactive session only', () => {
    it('an API token is refused before anything is deleted', async () => {
        writeStale('wordjs.db');
        const { result: res, deleted } = await deletionsDuring(() => cleanup(`Bearer ${token}`, 'wordjs.db'));
        assert.strictEqual(res.status, 403, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'rest_token_management_forbidden');
        assert.deepStrictEqual(deleted, [], 'nothing was deleted');
        assert.ok(fs.existsSync(path.join(DATA, 'wordjs.db')), 'the stale file is still there');
    });

    it('the status lists the stale file, and the cleanup removes it with its -wal, -shm and -journal', async () => {
        writeStale('wordjs.db');
        const status = await request(app).get(`${B}/db-migration/status`).set('Authorization', session());
        assert.deepStrictEqual(status.body.legacyFiles, ['wordjs.db'], 'only the stale file is offered');
        const res = await cleanup(session(), 'wordjs.db');
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        for (const s of ['', '-wal', '-shm', '-journal']) {
            assert.strictEqual(fs.existsSync(path.join(DATA, 'wordjs.db' + s)), false, `wordjs.db${s} is still there`);
        }
        assertLiveUntouched([], 'after the stale cleanup');
        await assertDatabaseAnswers('after the stale cleanup');
    });
});

describe('POST /db-migration/migrate: a SQLite target that is the live file is refused (the twin)', () => {
    it('config names the pure-JS driver on wordjs-native.db; migrating to sqlite-native would replace that file', async () => {
        // A configuration the cleanup's rule also covers: { dbDriver: 'sqlite-legacy', dbPath: './data/wordjs-native.db' }.
        // The native target is written to data/wordjs-native.db.tmp and swapped over data/wordjs-native.db.
        const savedDriver = config.dbDriver;
        const saved = { saveConfig: configManager.saveConfig, exit: process.exit };
        const effects: string[] = [];
        configManager.saveConfig = () => { effects.push('saveConfig'); };
        (process as any).exit = () => { effects.push('exit'); };
        config.dbDriver = 'sqlite-legacy';
        let res: any;
        try {
            const out = await deletionsDuring(() => request(app).post(`${B}/db-migration/migrate`).set('Authorization', session()).send({ targetDriver: 'sqlite-native' }));
            res = out.result;
            assertLiveUntouched(out.deleted, 'migrate');
        } finally {
            config.dbDriver = savedDriver;
            configManager.saveConfig = saved.saveConfig;
            // A migration that started schedules process.exit a second after answering: outlive it.
            if (!res || res.status !== 409) await new Promise((r) => setTimeout(r, 1500));
            (process as any).exit = saved.exit;
        }
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'db_migration_target_is_active');
        assert.deepStrictEqual(effects, [], 'the configuration was not rewritten');
        assert.strictEqual(fs.existsSync(LIVE + '.tmp'), false, 'no migration target was written');
        await assertDatabaseAnswers('after the migration attempt');
    });
});
