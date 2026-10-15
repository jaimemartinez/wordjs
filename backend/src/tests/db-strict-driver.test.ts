/**
 * Strict database driver mode ("dbStrictDriver" in wordjs-config.json / WORDJS_DB_STRICT).
 *
 * Off (the default), a SQLite driver that fails to load still falls back to the pure-JS 'sqlite-legacy'
 * driver, remembers the downgrade and publishes the 'db.sqlite-legacy-fallback' admin notice. On, the
 * same failure is a boot error that names the cause, what the fallback would have cost (no FTS5, LIKE
 * search) and the fix — and migration 0008's FTS5 probe refuses the same degradation the same way.
 *
 * better-sqlite3 cannot be made to vanish mid-suite, so the failing driver is a `sqlite-*` name with no
 * module behind it: loadDriver treats it exactly like a native driver whose binary will not load.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const config = require('../config/app');
const database = require('../config/database');
const { MIGRATIONS } = require('../core/schema-migrations');

const MISSING_DRIVER = 'sqlite-strict-mode-test-missing';
const NOTICE_ID = 'db.sqlite-legacy-fallback';

describe('strict database driver mode', () => {
    const tmp = path.join(os.tmpdir(), `wordjs-strict-${process.pid}-${Date.now()}.db`);
    const originalStrict = config.dbStrictDriver;

    after(async () => {
        config.dbStrictDriver = originalStrict;
        try { await database.closeDatabase(); } catch { /* ignore */ }
        for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
    });

    describe('resolving the setting', () => {
        const resolve = config.resolveDbStrictDriver;
        const saved = process.env.WORDJS_DB_STRICT;
        after(() => {
            if (saved === undefined) delete process.env.WORDJS_DB_STRICT;
            else process.env.WORDJS_DB_STRICT = saved;
        });

        it('is off unless the config file says true, when the env var is unset', () => {
            delete process.env.WORDJS_DB_STRICT;
            assert.strictEqual(resolve(undefined), false);
            assert.strictEqual(resolve(false), false);
            assert.strictEqual(resolve('true'), false, 'only a JSON boolean true turns it on');
            assert.strictEqual(resolve(true), true);
        });

        it('lets WORDJS_DB_STRICT win over the file in both directions', () => {
            for (const on of ['1', 'true', 'YES', ' on ']) {
                process.env.WORDJS_DB_STRICT = on;
                assert.strictEqual(resolve(false), true, `WORDJS_DB_STRICT=${on}`);
            }
            for (const off of ['0', 'false', 'No', 'off']) {
                process.env.WORDJS_DB_STRICT = off;
                assert.strictEqual(resolve(true), false, `WORDJS_DB_STRICT=${off}`);
            }
        });

        it('ignores an unrecognised env value instead of guessing', () => {
            process.env.WORDJS_DB_STRICT = 'maybe';
            assert.strictEqual(resolve(true), true);
            assert.strictEqual(resolve(undefined), false);
            process.env.WORDJS_DB_STRICT = '';
            assert.strictEqual(resolve(true), true, 'an empty value counts as unset');
        });
    });

    describe('loading a SQLite driver that fails', () => {
        it('strict on: refuses to fall back, with an error that explains the cause and the fix', async () => {
            config.dbStrictDriver = true;
            await assert.rejects(
                database.init({ driver: MISSING_DRIVER, dbPath: tmp }),
                (err: any) => {
                    assert.strictEqual(err.code, 'WORDJS_DB_STRICT_DRIVER');
                    assert.ok(err.cause, 'the original load error is kept as the cause');
                    const msg = String(err.message);
                    assert.ok(msg.includes(`'${MISSING_DRIVER}' driver failed to load`), msg);
                    assert.match(msg, /sqlite-legacy/);
                    assert.match(msg, /FTS5/);
                    assert.match(msg, /LIKE/);
                    // How to get out of it, both ways.
                    assert.match(msg, /WORDJS_DB_STRICT/);
                    assert.match(msg, /dbStrictDriver/);
                    return true;
                }
            );
            assert.strictEqual(database.getDriverDegradation(), null, 'a refusal is not recorded as a downgrade');
            assert.notStrictEqual(database.getDbType().driver, 'sqlite-legacy');
        });

        it('strict on: the native driver message tells the operator to rebuild better-sqlite3', () => {
            const err = database.strictDriverError('sqlite-native', new Error('Could not locate the bindings file'));
            assert.match(err.message, /Could not locate the bindings file/);
            assert.match(err.message, /npm rebuild better-sqlite3/);
        });

        it('strict off: falls back to sqlite-legacy and still publishes the admin notice', async () => {
            config.dbStrictDriver = false;
            await database.init({ driver: MISSING_DRIVER, dbPath: tmp });

            assert.strictEqual(database.getDbType().driver, 'sqlite-legacy');
            const degradation = database.getDriverDegradation();
            assert.ok(degradation, 'the downgrade is remembered');
            assert.strictEqual(degradation.driverRequested, MISSING_DRIVER);
            assert.strictEqual(degradation.driverActive, 'sqlite-legacy');
            assert.match(degradation.reason, /FTS5/);

            // The notice publisher is the real one; only its storage is captured.
            const notices = require('../core/admin-notices');
            const real = {
                push: notices.pushAdminNotice,
                clear: notices.clearAdminNotice,
                flush: notices.flushPendingAdminNotices,
            };
            const pushed: any[] = [];
            notices.pushAdminNotice = async (n: any) => { pushed.push(n); };
            notices.clearAdminNotice = async () => { throw new Error('a degraded boot must not retire the notice'); };
            notices.flushPendingAdminNotices = async () => {};
            try {
                await database.reportDriverDegradation();
            } finally {
                notices.pushAdminNotice = real.push;
                notices.clearAdminNotice = real.clear;
                notices.flushPendingAdminNotices = real.flush;
            }
            assert.strictEqual(pushed.length, 1);
            assert.strictEqual(pushed[0].id, NOTICE_ID);
        });
    });

    describe('migration 0008 (FTS5 probe)', () => {
        const fts = MIGRATIONS.find((m: any) => m.id === '0008_posts_fts5');
        let execs: string[];

        // A SQLite whose FTS5 is compiled out: the virtual table cannot be created.
        const ctxFor = (driverName: string) => {
            execs = [];
            return {
                isPostgres: false,
                driverName,
                exec: async (sql: string) => {
                    execs.push(sql);
                    if (/USING fts5/i.test(sql)) throw new Error('no such module: fts5');
                },
                run: async () => ({}),
                get: async () => undefined,
                all: async () => [],
            };
        };

        before(() => assert.ok(fts, '0008_posts_fts5 must be registered in MIGRATIONS'));

        it('strict off: keeps LIKE search and leaves the database untouched', async () => {
            config.dbStrictDriver = false;
            await fts.up(ctxFor('sqlite-native'));
            assert.strictEqual(execs.length, 1, 'nothing runs after the failed probe');
        });

        it('strict on: a native SQLite build without FTS5 fails the migration with the fix', async () => {
            config.dbStrictDriver = true;
            await assert.rejects(fts.up(ctxFor('sqlite-native')), (err: any) => {
                assert.match(err.message, /no such module: fts5/);
                assert.match(err.message, /ranked full-text search/);
                assert.match(err.message, /WORDJS_DB_STRICT/);
                assert.match(err.message, /dbStrictDriver/);
                return true;
            });
            assert.strictEqual(execs.length, 1);
        });

        it('strict on: an explicitly configured sqlite-legacy is not a degradation', async () => {
            config.dbStrictDriver = true;
            await fts.up(ctxFor('sqlite-legacy'));
            assert.strictEqual(execs.length, 1);
        });
    });
});
