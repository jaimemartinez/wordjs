/**
 * WordJS — Backup completeness (FRENTE G-1) tests.
 *
 * Covers the data-loss trap the audit found: a Postgres/MySQL backup that silently omitted the database
 * (no pg_dump / mysqldump), and the opt-in S3 offload. Proves:
 *   - captureDump FAILS LOUD when the vendor tool is missing (never a silent, incomplete archive), and
 *     does NOT even spawn it — mutation-proof: delete the guard and this test's "spawn not called" +
 *     "rejects" assertions both break.
 *   - captureDump spawns the RIGHT tool with the right argv + password env when the tool IS present.
 *   - restoreDump likewise fails loud when its tool is missing.
 *   - offloadBackup is INVOKED when S3 is configured and SKIPPED when not (upload mocked — no real bucket),
 *     and a failed upload keeps the local copy and reports.
 *   - uploadToS3 emits a SigV4-signed PUT and rejects on a non-2xx status.
 *   - the SQLite backup still works end-to-end (physical .db + logical json in the zip).
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbdump = require('../core/db-dump');
const s3mod = require('../core/s3-offload');

// A fake child process that emits `close` with the given code on the next tick (and, for pg_dump-style
// callers, exposes a readable-ish stderr). start-up 'error' when code === 'ENOENT-ish' is simulated by
// passing errorFirst.
function fakeSpawn(records: any[], opts: any = {}) {
    return (cmd: string, args: string[], spawnOpts: any) => {
        records.push({ cmd, args, spawnOpts });
        const child: any = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = new EventEmitter();
        child.stdin.end = () => {};
        child.stdin.on = child.stdin.on || (() => {});
        // pipe() target: swallow
        child.stdin.write = () => true;
        process.nextTick(() => {
            if (opts.error) child.emit('error', new Error('ENOENT'));
            else child.emit('close', opts.code == null ? 0 : opts.code);
        });
        return child;
    };
}

describe('db-dump: fail-loud + correct invocation', () => {
    const PG = { host: 'db.example', port: 5432, user: 'pguser', password: 'pgsecret', name: 'wordjs' };
    const MY = { host: 'db.example', port: 3306, user: 'myuser', password: 'mysecret', name: 'wordjs' };

    test('captureDump(postgres) FAILS LOUD and never spawns when pg_dump is missing', async () => {
        const spawnCalls: any[] = [];
        await assert.rejects(
            () => dbdump.captureDump('postgres', '/tmp/x.dump', PG, {
                isToolAvailable: async () => false,
                spawn: fakeSpawn(spawnCalls),
            }),
            /pg_dump.*not found|not found.*pg_dump/i,
        );
        // Mutation guard: if the missing-tool check were removed, captureDump would spawn pg_dump.
        assert.strictEqual(spawnCalls.length, 0, 'must abort BEFORE spawning pg_dump');
    });

    test('captureDump(mysql) FAILS LOUD when mysqldump is missing', async () => {
        const spawnCalls: any[] = [];
        await assert.rejects(
            () => dbdump.captureDump('mysql', '/tmp/x.sql', MY, {
                isToolAvailable: async () => false,
                spawn: fakeSpawn(spawnCalls),
            }),
            /mysqldump/i,
        );
        assert.strictEqual(spawnCalls.length, 0);
    });

    test('captureDump(postgres) spawns pg_dump with -Fc + dbname + PGPASSWORD when present', async () => {
        const spawnCalls: any[] = [];
        await dbdump.captureDump('postgres', '/tmp/out.dump', PG, {
            isToolAvailable: async () => true,
            spawn: fakeSpawn(spawnCalls, { code: 0 }),
        });
        assert.strictEqual(spawnCalls.length, 1);
        const call = spawnCalls[0];
        assert.strictEqual(call.cmd, 'pg_dump');
        assert.ok(call.args.includes('-Fc'), 'custom format');
        assert.ok(call.args.includes('-f') && call.args.includes('/tmp/out.dump'), 'writes to dest');
        assert.ok(call.args.includes('wordjs'), 'dbname positional');
        assert.strictEqual(call.spawnOpts.env.PGPASSWORD, 'pgsecret', 'password via env, not argv');
        assert.ok(!call.args.includes('pgsecret'), 'password NEVER on argv');
    });

    test('captureDump(mysql) spawns mysqldump with --result-file + MYSQL_PWD env', async () => {
        const spawnCalls: any[] = [];
        await dbdump.captureDump('mysql', '/tmp/out.sql', MY, {
            isToolAvailable: async () => true,
            spawn: fakeSpawn(spawnCalls, { code: 0 }),
        });
        const call = spawnCalls[0];
        assert.strictEqual(call.cmd, 'mysqldump');
        assert.ok(call.args.some((a: string) => a.startsWith('--result-file=')), 'result-file');
        assert.strictEqual(call.spawnOpts.env.MYSQL_PWD, 'mysecret');
        assert.ok(!call.args.some((a: string) => a.includes('mysecret')), 'password NEVER on argv');
    });

    test('captureDump rejects when the tool exits non-zero (captured stderr surfaced)', async () => {
        const spawnCalls: any[] = [];
        await assert.rejects(
            () => dbdump.captureDump('postgres', '/tmp/out.dump', PG, {
                isToolAvailable: async () => true,
                spawn: fakeSpawn(spawnCalls, { code: 1 }),
            }),
            /pg_dump exited with code 1/,
        );
    });

    test('restoreDump(postgres) FAILS LOUD and never spawns when pg_restore is missing', async () => {
        const spawnCalls: any[] = [];
        await assert.rejects(
            () => dbdump.restoreDump('postgres', '/tmp/x.dump', PG, {
                isToolAvailable: async () => false,
                spawn: fakeSpawn(spawnCalls),
            }),
            /pg_restore.*not found|not found.*pg_restore/i,
        );
        assert.strictEqual(spawnCalls.length, 0);
    });

    test('argv builders carry the connection params', () => {
        const pg = dbdump.buildPgDumpArgs(PG, '/d');
        assert.deepStrictEqual(
            [pg.includes('db.example'), pg.includes('5432'), pg.includes('pguser')],
            [true, true, true],
        );
        const my = dbdump.buildMysqldumpArgs(MY, '/d');
        assert.ok(my.includes('--single-transaction') && my.includes('--databases'));
        assert.strictEqual(dbdump.passwordEnv('postgres', PG).PGPASSWORD, 'pgsecret');
        assert.strictEqual(dbdump.passwordEnv('mysql', MY).MYSQL_PWD, 'mysecret');
    });

    test('usesExternalDump / dumpEntryName map only pg + mysql', () => {
        assert.ok(dbdump.usesExternalDump('postgres') && dbdump.usesExternalDump('mysql'));
        assert.ok(!dbdump.usesExternalDump('sqlite-native'));
        assert.strictEqual(dbdump.dumpEntryName('postgres'), 'postgres.dump');
        assert.strictEqual(dbdump.dumpEntryName('mysql'), 'mysql.sql');
        assert.strictEqual(dbdump.dumpEntryName('sqlite-native'), null);
    });
});

describe('s3-offload: config-gated + failure-safe', () => {
    const S3_ENV = {
        WORDJS_S3_BUCKET: 'my-bucket',
        WORDJS_S3_ACCESS_KEY_ID: 'AKIDEXAMPLE',
        WORDJS_S3_SECRET_ACCESS_KEY: 'secretkey',
        WORDJS_S3_REGION: 'us-west-2',
    };

    test('getS3Config returns null when unconfigured, a config when env is set', () => {
        assert.strictEqual(s3mod.getS3Config({}, {}), null);
        assert.strictEqual(s3mod.getS3Config({ WORDJS_S3_BUCKET: 'b' }, {}), null, 'partial config = null');
        const cfg = s3mod.getS3Config(S3_ENV, {});
        assert.strictEqual(cfg.bucket, 'my-bucket');
        assert.strictEqual(cfg.region, 'us-west-2');
    });

    test('offloadBackup is SKIPPED (upload never called) when S3 is not configured', async () => {
        let uploadCalls = 0;
        const res = await s3mod.offloadBackup('/tmp/backup.zip', 'backup.zip', {
            env: {}, config: {},
            uploadToS3: async () => { uploadCalls++; },
        });
        assert.strictEqual(res.offloaded, false);
        assert.strictEqual(res.reason, 'not-configured');
        assert.strictEqual(uploadCalls, 0, 'must not attempt an upload with no config');
    });

    test('offloadBackup INVOKES upload exactly once when configured', async () => {
        const uploaded: any[] = [];
        const res = await s3mod.offloadBackup('/tmp/backup.zip', 'backup.zip', {
            env: S3_ENV, config: {},
            uploadToS3: async (localPath: string, key: string) => { uploaded.push({ localPath, key }); },
        });
        assert.strictEqual(res.offloaded, true);
        assert.strictEqual(uploaded.length, 1);
        assert.strictEqual(uploaded[0].localPath, '/tmp/backup.zip');
        assert.ok(uploaded[0].key.endsWith('backup.zip'));
        assert.ok(uploaded[0].key.includes('wordjs-backups/'), 'default prefix applied');
    });

    test('offloadBackup keeps local + reports when the upload fails (never throws)', async () => {
        const res = await s3mod.offloadBackup('/tmp/backup.zip', 'backup.zip', {
            env: S3_ENV, config: {},
            uploadToS3: async () => { throw new Error('network down'); },
        });
        assert.strictEqual(res.offloaded, false);
        assert.strictEqual(res.reason, 'upload-failed');
        assert.match(res.error, /network down/);
    });

    test('uploadToS3 signs a PUT (SigV4) and resolves on 2xx / rejects on non-2xx', async () => {
        const cfg = s3mod.getS3Config(S3_ENV, {});
        const captured: any = {};
        const makeReq = (status: number) => (options: any, cb: any) => {
            captured.options = options;
            const res: any = new EventEmitter();
            res.statusCode = status;
            const req: any = new EventEmitter();
            req.end = (_body: any) => { cb(res); process.nextTick(() => res.emit('end')); };
            return req;
        };
        const ok = await s3mod.uploadToS3('irrelevant', 'wordjs-backups/backup.zip', cfg, {
            request: makeReq(200),
            readFile: () => Buffer.from('zipbytes'),
            now: new Date('2026-08-14T10:20:30.000Z'),
        });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(captured.options.method, 'PUT');
        assert.strictEqual(captured.options.host, 'my-bucket.s3.us-west-2.amazonaws.com');
        assert.match(captured.options.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
        assert.match(captured.options.headers.Authorization, /Signature=[0-9a-f]{64}$/);
        assert.strictEqual(captured.options.headers['X-Amz-Content-Sha256'], require('crypto').createHash('sha256').update(Buffer.from('zipbytes')).digest('hex'));

        await assert.rejects(
            () => s3mod.uploadToS3('irrelevant', 'k', cfg, {
                request: makeReq(403),
                readFile: () => Buffer.from('x'),
                now: new Date('2026-08-14T10:20:30.000Z'),
            }),
            /S3 PUT failed: HTTP 403/,
        );
    });
});

// ── SQLite backup still works end-to-end (physical .db + logical json in the zip) ─────────────────────
describe('SQLite backup still produces a complete archive', () => {
    const config = require('../config/app');
    const TMP_DB = path.join(os.tmpdir(), `wordjs-backupg1-${process.pid}-${Date.now()}.db`);
    const savedEnv: Record<string, string | undefined> = {};
    const S3_KEYS = ['WORDJS_S3_BUCKET', 'WORDJS_S3_ACCESS_KEY_ID', 'WORDJS_S3_SECRET_ACCESS_KEY',
        'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'WORDJS_S3_ENDPOINT'];
    let database: any;
    let createBackup: any, deleteBackup: any;
    let made: string | null = null;

    before(async () => {
        // Ensure S3 is NOT configured so this backup takes the pure on-host path (no network).
        for (const k of S3_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
        config.dbDriver = 'sqlite-native';
        config.dbPath = TMP_DB;
        database = require('../config/database');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        ({ createBackup, deleteBackup } = require('../core/backup'));
    });

    after(async () => {
        try { if (made) deleteBackup(made); } catch { /* */ }
        try { await database.closeDatabase(); } catch { /* */ }
        for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch { /* */ } }
        for (const k of S3_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    });

    test('createBackup() ships database/wordjs.db + wordjs-content.json; S3 not-configured', async () => {
        const AdmZip = require('adm-zip');
        const result = await createBackup();
        made = result.filename;
        assert.ok(result.filename && result.size > 0);
        assert.strictEqual(result.s3.offloaded, false);
        assert.strictEqual(result.s3.reason, 'not-configured');

        const zipPath = path.resolve(__dirname, '../../backups', result.filename);
        const zip = new AdmZip(zipPath);
        assert.ok(zip.getEntry('wordjs-content.json'), 'logical export present');
        assert.ok(zip.getEntry('database/wordjs.db'), 'physical SQLite snapshot present');
    });
});
