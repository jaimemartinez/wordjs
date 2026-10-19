/**
 * core/module-logger — the logger backend modules log through instead of `console.*`.
 *
 * What is asserted is what was actually EMITTED (the lines the real root logger writes, read back
 * through its sink), not what a logger built by the test would do. The properties under test are the
 * ones the migration off the console bridge must not lose:
 *
 *   · every line names its module (`mod`) and, inside a request, carries that request's `requestId`;
 *   · a credential in the MESSAGE is still scrubbed (the bridge did that; a migrated line must too);
 *   · `{ err }` is serialized by allow-list, so an HTTP-client error carrying its request headers
 *     cannot put an Authorization header into the log;
 *   · loading the module does not load core/logger (the config cycle the laziness exists for);
 *   · a logging call never throws into its caller.
 *
 * MUTATION PROOF: drop `scrubSecrets` from moduleLogger and the scrub case fails; derive the child from
 * the root logger instead of getRequestLogger() and the requestId case fails; remove the `err`
 * serializer from core/logger and the Authorization case fails.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

describe('core/module-logger', () => {
    it('does not load core/logger until the first line is logged', () => {
        const loggerPath = path.resolve(__dirname, '../core/logger.ts');
        const { moduleLogger } = require('../core/module-logger');
        moduleLogger('tests/lazy');
        assert.strictEqual(require.cache[loggerPath], undefined, 'core/logger was loaded eagerly');
    });

    function capture(fn: () => void): any[] {
        const { addLogSink } = require('../core/logger');
        const lines: any[] = [];
        const remove = addLogSink((line: string) => lines.push(JSON.parse(line)));
        try { fn(); } finally { remove(); }
        return lines;
    }

    it('tags each line with its module and keeps structured fields', () => {
        const { moduleLogger } = require('../core/module-logger');
        const log = moduleLogger('core/example');
        const lines = capture(() => log.warn({ slug: 'demo', attempt: 2 }, 'retrying'));
        assert.strictEqual(lines.length, 1);
        assert.strictEqual(lines[0].mod, 'core/example');
        assert.strictEqual(lines[0].level, 'warn');
        assert.strictEqual(lines[0].msg, 'retrying');
        assert.strictEqual(lines[0].slug, 'demo');
        assert.strictEqual(lines[0].attempt, 2);
        assert.strictEqual(lines[0].legacy, undefined, 'a migrated line is not a bridged one');
    });

    it('carries the requestId of the request being served', () => {
        const { logger, runWithRequestContext } = require('../core/logger');
        const { moduleLogger } = require('../core/module-logger');
        const log = moduleLogger('core/example');
        const reqLogger = logger.child({ requestId: 'req-1234abcd' });
        const lines = capture(() => {
            runWithRequestContext({ requestId: 'req-1234abcd', startedAt: Date.now(), logger: reqLogger }, () => log.info('inside'));
            log.info('outside');
        });
        assert.strictEqual(lines[0].requestId, 'req-1234abcd');
        assert.strictEqual(lines[0].mod, 'core/example');
        assert.strictEqual(lines[1].requestId, undefined);
    });

    it('scrubs credentials out of the message, as the console bridge does', () => {
        const { moduleLogger } = require('../core/module-logger');
        const log = moduleLogger('core/example');
        const lines = capture(() => {
            log.info('login with password=hunter2 failed');
            log.info({ user: 'a' }, 'token=wjt_abcdefghijkl rejected');
        });
        assert.ok(!JSON.stringify(lines).includes('hunter2'));
        assert.ok(!JSON.stringify(lines).includes('wjt_abcdefghijkl'));
        assert.match(lines[0].msg, /password=\[redacted\]/);
    });

    it('serializes errors by allow-list: no request headers, no foreign properties', () => {
        const { moduleLogger } = require('../core/module-logger');
        const log = moduleLogger('core/example');
        const err: any = new Error('upstream said no');
        err.code = 'ECONNRESET';
        err.status = 502;
        err.config = { headers: { Authorization: 'Bearer abcdefghijklmnop' } };
        err.response = { data: { secret: 'leak-me' } };
        err.cause = new Error('socket hang up');
        const lines = capture(() => {
            log.error({ err }, 'fetch failed');
            log.error(err);
        });
        for (const line of lines) {
            const text = JSON.stringify(line);
            assert.ok(!text.includes('abcdefghijklmnop'), 'Authorization header leaked through err');
            assert.ok(!text.includes('leak-me'), 'response body leaked through err');
            assert.strictEqual(line.err.message, 'upstream said no');
            assert.strictEqual(line.err.code, 'ECONNRESET');
            assert.strictEqual(line.err.status, 502);
            assert.strictEqual(line.err.type, 'Error');
            assert.match(line.err.stack, /upstream said no/);
            assert.strictEqual(line.err.cause.message, 'socket hang up');
        }
        assert.strictEqual(lines[0].msg, 'fetch failed');
    });

    it('never throws into the caller', () => {
        const { moduleLogger } = require('../core/module-logger');
        const log = moduleLogger('core/example');
        const circular: any = {};
        circular.self = circular;
        const hostile = { get boom(): never { throw new Error('getter'); } };
        assert.doesNotThrow(() => log.info(circular, 'circular'));
        assert.doesNotThrow(() => log.info(hostile, 'hostile'));
        assert.strictEqual(typeof log.isLevelEnabled('info'), 'boolean');
    });

    it('WORDJS_LOG_TO_STDERR=1 sends every line to stderr, leaving stdout to a CLI command output', () => {
        const { spawnSync } = require('child_process');
        const backend = path.resolve(__dirname, '../..');
        const script = [
            "require('ts-node').register({ transpileOnly: true });",
            "require('./src/core/module-logger').moduleLogger('tests/stderr').info('a backend log line');",
            "process.stdout.write(JSON.stringify({ ok: true }));",
        ].join('');
        const env: Record<string, string> = { ...process.env, WORDJS_LOG_TO_STDERR: '1', NODE_ENV: 'production' } as any;
        delete env.NODE_TEST_CONTEXT;
        const r = spawnSync(process.execPath, ['-e', script], { cwd: backend, env, encoding: 'utf8', timeout: 60_000 });
        assert.strictEqual(r.status, 0, r.stderr);
        assert.deepStrictEqual(JSON.parse(r.stdout), { ok: true }, 'stdout carries only the command output');
        assert.match(r.stderr, /a backend log line/);
    });

    it('WORDJS_LOG_TO_STDERR=1 also sends the config boot notes to stderr', () => {
        const { spawnSync } = require('child_process');
        const backend = path.resolve(__dirname, '../..');
        // Pretend backend/wordjs-config.json exists (without touching the real file), with a database
        // password missing so the auto-generation notes print too; writing it back is intercepted.
        const script = [
            "const fs = require('fs'); const real = { e: fs.existsSync, r: fs.readFileSync, w: fs.writeFileSync };",
            "const isCfg = (p) => String(p).split(String.fromCharCode(92)).join('/').endsWith('backend/wordjs-config.json');",
            "fs.existsSync = (p) => isCfg(p) || real.e(p);",
            "fs.readFileSync = (p, ...a) => isCfg(p) ? JSON.stringify({ jwtSecret: 'a'.repeat(64) + 'b'.repeat(64) }) : real.r(p, ...a);",
            "fs.writeFileSync = (p, ...a) => isCfg(p) ? undefined : real.w(p, ...a);",
            "require('ts-node').register({ transpileOnly: true });",
            "require('./src/config/app');",
            "process.stdout.write(JSON.stringify({ ok: true }));",
        ].join('');
        const env: Record<string, string> = { ...process.env, WORDJS_LOG_TO_STDERR: '1', NODE_ENV: 'production' } as any;
        delete env.NODE_TEST_CONTEXT;
        const r = spawnSync(process.execPath, ['-e', script], { cwd: backend, env, encoding: 'utf8', timeout: 60_000 });
        assert.strictEqual(r.status, 0, r.stderr);
        assert.deepStrictEqual(JSON.parse(r.stdout), { ok: true }, 'stdout carries only the command output');
        assert.match(r.stderr, /Config loaded from wordjs-config\.json/);
        assert.match(r.stderr, /Generated secure Database password/);
    });
});
