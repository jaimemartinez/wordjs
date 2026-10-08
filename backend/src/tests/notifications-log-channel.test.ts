/**
 * core/notifications.ts must never write to STDOUT.
 *
 * Under `node --test` a test file's stdout is the runner's report pipe. Notification transports register
 * (and notifications fan out) from asynchronous callbacks, and on Windows a pipe write is asynchronous:
 * a `console.log` there can land inside one of the runner's serialized frames and fail the whole file
 * with "Unable to deserialize cloned data due to invalid or unsupported version" — which is how
 * sandbox-escape-e2e died on the Windows sandbox-parity runner, right after
 * "📦 Notification Transport Registered". core/cache.ts was fixed for the same reason; this pins the
 * notification service to the same rule.
 */
const { test } = require('node:test');
const assert = require('node:assert');

test('registering and unregistering a transport writes nothing to stdout', () => {
    const notifications = require('../core/notifications');
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    const out: string[] = [];
    const err: string[] = [];
    (process.stdout as any).write = (chunk: any, ...rest: any[]) => { out.push(String(chunk)); return true; };
    (process.stderr as any).write = (chunk: any, ...rest: any[]) => { err.push(String(chunk)); return true; };
    try {
        notifications.registerTransport('wjs-log-channel-probe', () => undefined);
        notifications.transports.get('wjs-log-channel-probe').pluginSlug = 'log-channel-probe';
        notifications.unregisterPluginTransports('log-channel-probe');
    } finally {
        (process.stdout as any).write = realOut;
        (process.stderr as any).write = realErr;
    }
    assert.deepStrictEqual(out.filter((s) => /Transport/.test(s)), [], `the notification service wrote to stdout: ${out.join('')}`);
    assert.ok(err.some((s) => /Transport Registered: wjs-log-channel-probe/.test(s)), 'the registration line no longer reaches stderr either');
});

test('no console.* call remains in the notification service', () => {
    // A structural backstop for the lines the behavioural test above does not drive (send, broadcast, SSE).
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'notifications.ts'), 'utf8');
    assert.deepStrictEqual(src.match(/console\.(log|info|warn|error)\(/g) || [], [], 'use the module\'s stderr log() instead');
});
