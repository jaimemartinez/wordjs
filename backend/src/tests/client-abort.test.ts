/**
 * A browser that cancels a request must not end the process (FALLOS 117).
 *
 * Node emits a request's `Error: aborted` only if the request has an 'error' listener when it checks, and
 * emits it one tick later. A handler that removes its listener in between — cleanup queued with nextTick
 * from the response's 'close', which fires in the same socket close — leaves the error with no listener:
 * an uncaught exception, and every WordJS entry point exited on it (monolith dev and prod, backend,
 * frontend server, gateway workers). Each case runs in a child process, so a crash is observed, not
 * suffered by the test runner.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const SOURCE = path.join(REPO_ROOT, 'backend', 'src', 'core', 'client-abort.js');
const COPIES = [path.join(REPO_ROOT, 'gateway', 'src', 'client-abort.js'), path.join(REPO_ROOT, 'frontend', 'client-abort.js')];

/**
 * A server whose handler has the racing cleanup, and a client that resets its connection mid-body.
 * Prints SURVIVED when the process is still up afterwards. `setup` runs first (guard, crash handlers).
 */
function runAbortedRequest(setup: string, handler = ''): { status: number | null; stdout: string; stderr: string } {
    const script = `
        const http = require('http');
        const net = require('net');
        ${setup}
        const server = http.createServer((req, res) => {
            const cleanup = () => {};
            req.on('error', cleanup);
            res.on('close', () => process.nextTick(() => req.removeListener('error', cleanup)));
            ${handler}
        });
        if (typeof guard === 'function') guard(server);
        server.listen(0, '127.0.0.1', () => {
            const s = net.connect(server.address().port, '127.0.0.1', () => {
                s.write('POST / HTTP/1.1\\r\\nHost: x\\r\\nContent-Length: 1000\\r\\n\\r\\nabc');
                setTimeout(() => (s.resetAndDestroy ? s.resetAndDestroy() : s.destroy()), 50);
            });
            s.on('error', () => {});
            setTimeout(() => { process.stdout.write('SURVIVED'); process.exit(0); }, 600);
        });
    `;
    const out = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
        cwd: path.join(REPO_ROOT, 'backend'),
        encoding: 'utf8',
        timeout: 60_000,
    });
    return { status: out.status, stdout: out.stdout || '', stderr: out.stderr || '' };
}

test('the gateway and frontend copies are byte-identical to backend/src/core/client-abort.js', () => {
    const source = fs.readFileSync(SOURCE);
    for (const copy of COPIES) {
        assert.ok(fs.readFileSync(copy).equals(source), `${path.relative(REPO_ROOT, copy)} drifted: copy backend/src/core/client-abort.js over it`);
    }
    const required = [...source.toString('utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.deepStrictEqual(required, [], 'built-ins only: each copy must load in its own service install');
});

test('isClientAbort recognises Node\'s aborted-request error and nothing else', () => {
    const { isClientAbort } = require('../core/client-abort');
    const aborted = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    assert.strictEqual(isClientAbort(aborted), true);
    assert.strictEqual(isClientAbort(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), false);
    assert.strictEqual(isClientAbort(Object.assign(new Error('aborted'), { code: 'EOTHER' })), false);
    assert.strictEqual(isClientAbort(new TypeError('x')), false);
    assert.strictEqual(isClientAbort(null), false);
    assert.strictEqual(isClientAbort('aborted'), false);
});

test('without the guard, the aborted request is an uncaught exception (the bug, reproduced)', () => {
    const r = runAbortedRequest(`process.on('uncaughtException', (e) => { process.stdout.write('UNCAUGHT ' + e.code + ' ' + e.message); process.exit(3); });`);
    assert.strictEqual(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /UNCAUGHT ECONNRESET aborted/);
});

test('a guarded server delivers the abort to its own listener: the process stays up', () => {
    const r = runAbortedRequest(`
        process.on('uncaughtException', (e) => { process.stdout.write('UNCAUGHT ' + e.message); process.exit(3); });
        const guard = require('./src/core/client-abort').installClientAbortGuard;
    `);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.stdout, 'SURVIVED');
});

test('a guarded request whose listeners a framework wiped still drops the abort (listeners rebuilt without removeListener)', () => {
    const r = runAbortedRequest(`
        process.on('uncaughtException', (e) => { process.stdout.write('UNCAUGHT ' + e.message); process.exit(3); });
        const guard = require('./src/core/client-abort').installClientAbortGuard;
    `, "res.on('close', () => { req._events = Object.create(null); req._eventsCount = 0; req.on('error', cleanup); process.nextTick(() => req.removeListener('error', cleanup)); });");
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(r.stdout, 'SURVIVED');
});

test('the crash guard keeps serving when a client abort still escapes (no guard on that stream)', () => {
    const r = runAbortedRequest(`require('./src/core/crash-guard').installRuntimeBlameHandlers();`);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /SURVIVED/);
});

test('the crash guard still exits on a real uncaught exception', () => {
    const script = `
        require('./src/core/crash-guard').installRuntimeBlameHandlers();
        setTimeout(() => { throw new Error('a real bug'); }, 10);
        setTimeout(() => { process.stdout.write('SURVIVED'); process.exit(0); }, 1500);
    `;
    const out = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
        cwd: path.join(REPO_ROOT, 'backend'),
        encoding: 'utf8',
        timeout: 60_000,
    });
    assert.strictEqual(out.status, 1, out.stdout + out.stderr);
    assert.doesNotMatch(out.stdout || '', /SURVIVED/);
});
