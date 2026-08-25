/**
 * A CHILD THAT DIES MID-LINE MUST NOT DIE SILENTLY.
 *
 * plugin-isolate forwards an isolated plugin's piped stdout/stderr to the operator's log through a
 * LINE-BUFFERED, rate-limited sink: it emits on a newline, and force-flushes only past 64KB. So a short
 * write with no trailing newline — which is exactly what a launcher prints when it REFUSES, and what a
 * runtime prints when it aborts before its own newline — stayed in the buffer and was never seen. The
 * operator got an exit code and nothing else.
 *
 * That is how an isolated plugin came to fail on macOS with `exited during startup (code 1)` and no
 * output at all: the one message that explained it was sitting in this buffer when the stream closed.
 *
 * The sink is reached directly rather than through a real spawn, because reproducing this from outside
 * would mean arranging a plugin that crashes in exactly that shape on exactly that platform — the
 * arrangement that let the bug live. A fake stream makes the property testable everywhere.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const isolate = require('../core/plugin-isolate');

/** A writable that records what the host log would have received. */
function recorder(): { written: string[]; stream: any } {
    const written: string[] = [];
    return { written, stream: { write: (s: string) => { written.push(String(s)); return true; } } };
}

/** A child whose stdout/stderr are plain emitters, so the test drives the exact byte timing. */
function fakeChild(): any {
    return { stdout: new EventEmitter(), stderr: new EventEmitter() };
}

describe('isolated plugin log forwarding', () => {
    test('a complete line is forwarded, tagged with the plugin slug', (t: any) => {
        const child = fakeChild();
        const err = recorder();
        t.mock.method(process.stderr, 'write', err.stream.write);

        isolate.attachLogLimiter('demo-plugin', child);
        child.stderr.emit('data', Buffer.from('a whole line\n'));

        assert.ok(err.written.some((s) => s.includes('[plugin demo-plugin] a whole line')),
            `a terminated line was not forwarded: ${JSON.stringify(err.written)}`);
    });

    test('an UNTERMINATED final write is flushed when the stream ends', (t: any) => {
        const child = fakeChild();
        const err = recorder();
        t.mock.method(process.stderr, 'write', err.stream.write);

        isolate.attachLogLimiter('dying-plugin', child);
        // No newline: the shape a refusing launcher writes just before the process goes away.
        child.stderr.emit('data', Buffer.from('sandbox-exec: could not apply the profile'));

        assert.deepStrictEqual(err.written, [],
            'the sink emitted before the line was terminated, so it is no longer line-buffered');

        child.stderr.emit('end');

        assert.ok(err.written.some((s) => s.includes('sandbox-exec: could not apply the profile')),
            `the child's last words were lost when the stream ended: ${JSON.stringify(err.written)}`);
    });

    test('a killed child that only closes its pipe is flushed too', (t: any) => {
        const child = fakeChild();
        const err = recorder();
        t.mock.method(process.stderr, 'write', err.stream.write);

        isolate.attachLogLimiter('killed-plugin', child);
        child.stderr.emit('data', Buffer.from('partial diagnosis, no newline'));
        // A killed child can close without a clean 'end'; both paths must flush.
        child.stderr.emit('close');

        assert.ok(err.written.some((s) => s.includes('partial diagnosis, no newline')),
            `a close without end lost the buffer: ${JSON.stringify(err.written)}`);
    });

    test('flushing twice does not duplicate the line', (t: any) => {
        const child = fakeChild();
        const err = recorder();
        t.mock.method(process.stderr, 'write', err.stream.write);

        isolate.attachLogLimiter('twice-plugin', child);
        child.stderr.emit('data', Buffer.from('only once please'));
        // Node emits both on a normal end; the buffer must be cleared by the first flush.
        child.stderr.emit('end');
        child.stderr.emit('close');

        const hits = err.written.filter((s) => s.includes('only once please'));
        assert.strictEqual(hits.length, 1, `the tail was written ${hits.length} times: ${JSON.stringify(err.written)}`);
    });

    test('stdout is flushed on the same terms as stderr', (t: any) => {
        const child = fakeChild();
        const out = recorder();
        t.mock.method(process.stdout, 'write', out.stream.write);

        isolate.attachLogLimiter('stdout-plugin', child);
        child.stdout.emit('data', Buffer.from('unterminated stdout'));
        child.stdout.emit('end');

        assert.ok(out.written.some((s) => s.includes('unterminated stdout')),
            'stdout was left with the defect stderr had');
    });
});
