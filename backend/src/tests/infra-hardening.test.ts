/**
 * INFRASTRUCTURE HARDENING — database TLS, the readiness probe, and secret-bearing file modes.
 *
 *  1. DATABASE TLS. Every Postgres/MySQL connection hard-coded `rejectUnauthorized: false`, so `dbSsl`
 *     encrypted traffic without authenticating the server. drivers/db-tls.ts is the one builder now:
 *     verified by default, `dbSslCa` for a private CA, `dbSslRejectUnauthorized: false` as an explicit,
 *     logged opt-out. The source gate keeps the hard-coded form from coming back at any call site.
 *  2. /readyz. Unauthenticated and rate-limit exempt, yet every call read the config file and queried
 *     the database, and a failure echoed the exception text. core/readiness.ts caches the verdict for
 *     ~1 s, shares one in-flight evaluation and sends a generic error.
 *  3. FILE MODES. configManager created new config files 0o666 (minus umask) and kept "other" bits on
 *     rewrite; the setup orchestrator wrote private keys and configs with default modes. POSIX-only
 *     assertions (Windows has no such bits) — CI runs them on Linux.
 *
 * MUTATION PROOF: hard-code `rejectUnauthorized: false` in dbTlsOptions (or at any driver call site),
 * drop the TTL check or the in-flight sharing in createReadinessProbe, return `e.message` from its catch,
 * or put `0o666` / `& 0o777` back in writeFileAtomic — the matching test below fails.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { dbTlsOptions, resolveCa, isCertificateError } = require('../drivers/db-tls');
const { createReadinessProbe } = require('../core/readiness');

const SRC = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const POSIX = process.platform !== 'win32';

describe('database TLS options', () => {
    test('off unless ssl is on', () => {
        assert.equal(dbTlsOptions(undefined), undefined);
        assert.equal(dbTlsOptions({ ssl: false }), undefined);
    });
    test('verified by default; only an explicit false opts out', () => {
        assert.deepEqual(dbTlsOptions({ ssl: true }), { rejectUnauthorized: true });
        assert.deepEqual(dbTlsOptions({ ssl: true, sslRejectUnauthorized: undefined }), { rejectUnauthorized: true });
        assert.deepEqual(dbTlsOptions({ ssl: true, sslRejectUnauthorized: false }), { rejectUnauthorized: false });
    });
    test('a CA is taken inline or from a file; a missing file is an error, not "no CA"', () => {
        const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
        assert.equal(dbTlsOptions({ ssl: true, sslCa: pem })!.ca, pem);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-dbtls-'));
        fs.writeFileSync(path.join(dir, 'ca.pem'), pem);
        assert.equal(resolveCa('ca.pem', dir), pem);
        assert.equal(resolveCa(path.join(dir, 'ca.pem')), pem);
        assert.throws(() => dbTlsOptions({ ssl: true, sslCa: path.join(dir, 'missing.pem') }));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    test('certificate failures are recognised for the boot hint', () => {
        assert.ok(isCertificateError({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }));
        assert.ok(isCertificateError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }));
        assert.ok(!isCertificateError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }));
    });
    test('config/app.ts reads both settings, verified unless explicitly false', () => {
        const src = read('config/app.ts');
        assert.ok(/sslCa:\s*fileConfig\.dbSslCa\s*\|\|\s*fileConfig\.db\?\.sslCa/.test(src));
        assert.ok(/sslRejectUnauthorized:\s*!\(fileConfig\.dbSslRejectUnauthorized === false \|\| fileConfig\.db\?\.sslRejectUnauthorized === false\)/.test(src));
    });
    test('no connection site hard-codes an unverified TLS option', () => {
        for (const rel of ['drivers/postgres.ts', 'drivers/mysql.ts', 'routes/setup.ts']) {
            const src = read(rel);
            assert.ok(!/rejectUnauthorized:\s*false/.test(src), `${rel} must build TLS options with drivers/db-tls.ts`);
            assert.ok(/dbTlsOptions\(/.test(src), `${rel} uses dbTlsOptions`);
        }
    });
});

describe('readiness probe', () => {
    const deps = (over: any = {}) => {
        const calls = { db: 0, installed: 0 };
        let t = 1000;
        const d = {
            isInstalled: () => { calls.installed++; return true; },
            isBooted: () => true,
            checkDatabase: async () => { calls.db++; return { status: 'OK' }; },
            now: () => t,
            ...over,
        };
        return { d, calls, tick: (ms: number) => { t += ms; } };
    };

    test('ready, and cached within the TTL', async () => {
        const { d, calls, tick } = deps();
        const probe = createReadinessProbe(d);
        const a = await probe();
        assert.equal(a.statusCode, 200);
        assert.equal(a.body.status, 'ready');
        for (let i = 0; i < 50; i++) await probe();
        assert.equal(calls.db, 1, 'one database check per TTL, however many requests');
        assert.equal(calls.installed, 1, 'one config read per TTL');
        tick(1000);
        await probe();
        assert.equal(calls.db, 2, 'a new evaluation after the TTL');
    });

    test('concurrent callers share one evaluation', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => { release = r; });
        const { d, calls } = deps({ checkDatabase: async () => { calls.db++; await gate; return { status: 'OK' }; } });
        const probe = createReadinessProbe(d);
        const all = Promise.all(Array.from({ length: 20 }, () => probe()));
        release();
        const results = await all;
        assert.equal(calls.db, 1);
        assert.ok(results.every((r: any) => r.statusCode === 200));
    });

    test('states: setup_required, starting, not_ready', async () => {
        assert.equal((await createReadinessProbe(deps({ isInstalled: () => false }).d)()).body.status, 'setup_required');
        assert.equal((await createReadinessProbe(deps({ isBooted: () => false }).d)()).body.status, 'starting');
        const nr = await createReadinessProbe(deps({ checkDatabase: async () => ({ status: 'ERROR' }) }).d)();
        assert.equal(nr.statusCode, 503);
        assert.equal(nr.body.status, 'not_ready');
    });

    test('a thrown error is logged, never sent', async () => {
        const logged: unknown[] = [];
        const secret = 'connect ECONNREFUSED 10.1.2.3:5432 /srv/wordjs/internal';
        const r = await createReadinessProbe(deps({
            checkDatabase: async () => { throw new Error(secret); },
            onError: (e: unknown) => logged.push(e),
        }).d)();
        assert.equal(r.statusCode, 503);
        assert.ok(!JSON.stringify(r.body).includes('10.1.2.3'), 'no exception text in the body');
        assert.equal(r.body.error, 'Readiness check failed.');
        assert.equal(logged.length, 1);
    });

    test('index.ts serves /readyz from the cached probe', () => {
        const src = read('index.ts');
        const route = src.slice(src.indexOf("app.get('/readyz'"), src.indexOf("app.get('/readyz'") + 300);
        assert.ok(/await readiness\(\)/.test(route), '/readyz must use the cached probe');
        assert.ok(!/e\.message/.test(route), '/readyz must not send an exception message');
    });
});

describe('secret-bearing files are not readable by other users', () => {
    test('configManager: a new config is 0600; a rewrite clears the bits for others', { skip: !POSIX && 'POSIX modes only' }, () => {
        const { writeFileAtomic } = require('../core/configManager');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-cfgmode-'));
        const f = path.join(dir, 'wordjs-config.json');
        writeFileAtomic(f, '{}');
        assert.equal(fs.statSync(f).mode & 0o777, 0o600);
        fs.chmodSync(f, 0o644);
        writeFileAtomic(f, '{"a":1}');
        assert.equal(fs.statSync(f).mode & 0o777, 0o640, 'owner/group bits kept, other bits cleared');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('configManager source: never creates with 0o666 nor keeps the other bits', () => {
        const src = read('core/configManager.ts');
        assert.ok(!/0o666/.test(src));
        assert.ok(/statSync\(real\)\.mode & 0o770/.test(src));
    });

    test('setup orchestrator writes keys and configs owner-only and re-chmods copied keys', () => {
        const src = fs.readFileSync(path.join(SRC, '..', '..', 'setup', 'index.js'), 'utf8');
        assert.ok(!/fs\.writeFile\([^)]*\.key/.test(src), 'no private key written without a mode');
        assert.ok(!/fs\.writeJson\(/.test(src.replace(/async function writeSecretJson[\s\S]*?\n}/, '')), 'configs go through writeSecretJson');
        assert.ok(/fs\.copy\(src, dest\);\s*\r?\n\s*if \(file\.endsWith\('\.key'\)\) await restrictMode\(dest\);/.test(src));
    });
});

describe('config/app.ts boot rewrite of generated secrets', () => {
    const { spawnSync } = require('child_process');
    // config/app.ts resolves wordjs-config.json against its own location (two levels up), so it is
    // booted from a throwaway copy of the tree — never against this checkout's real config file. Its one
    // project import is stubbed; nothing else is loaded.
    const stage = () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-appboot-'));
        fs.mkdirSync(path.join(root, 'src', 'config'), { recursive: true });
        fs.mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
        fs.copyFileSync(path.join(SRC, 'config', 'app.ts'), path.join(root, 'src', 'config', 'app.ts'));
        fs.writeFileSync(path.join(root, 'src', 'core', 'content-rollout.js'), 'module.exports = { normalizeContentValidationConfig: (v) => v };');
        return { root, file: path.join(root, 'wordjs-config.json') };
    };
    const boot = (root: string) => spawnSync(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), '-e', `require(${JSON.stringify(path.join(root, 'src', 'config', 'app.ts'))})`], {
        cwd: root, encoding: 'utf8', env: { ...process.env, TS_NODE_PROJECT: path.join(SRC, '..', 'tsconfig.json') }, timeout: 120000,
    });

    test('a loaded config with a placeholder password is rewritten in place, readable by no other user', () => {
        const { root: dir, file: f } = stage();
        fs.writeFileSync(f, JSON.stringify({ dbPassword: 'password', siteUrl: 'http://localhost:3000' }));
        if (POSIX) fs.chmodSync(f, 0o644);
        const r = boot(dir);
        assert.equal(r.status, 0, r.stderr);
        const after = JSON.parse(fs.readFileSync(f, 'utf8'));
        assert.notEqual(after.dbPassword, 'password', 'a real password was generated and persisted');
        assert.equal(after.siteUrl, 'http://localhost:3000', 'the rest of the file is kept');
        if (POSIX) assert.equal(fs.statSync(f).mode & 0o777, 0o640, 'other bits cleared, owner/group kept');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('a config that cannot be parsed is never overwritten', () => {
        const { root: dir, file: f } = stage();
        fs.writeFileSync(f, '{ "dbPassword": "password", oops');
        boot(dir);
        assert.equal(fs.readFileSync(f, 'utf8'), '{ "dbPassword": "password", oops', 'the operator\'s file is left for them to fix');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('no path check gates the rewrite', () => {
        const src = read('config/app.ts');
        assert.ok(/if \(configLoaded\) \{/.test(src));
        assert.ok(/fs\.openSync\(configPath, 'r\+'\)/.test(src) && /fs\.fchmodSync\(fd,/.test(src));
        assert.ok(!/chmodSync\(configPath/.test(src));
    });
});
