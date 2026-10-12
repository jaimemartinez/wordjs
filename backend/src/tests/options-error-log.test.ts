/**
 * WordJS — a failed option read is logged as ONE line that names the option literally.
 *
 * The option name can come from a request: routes/widgets.ts reads `widget_<id>` with the id taken
 * from the URL or the body. getOption used to put the name inside the console FORMAT string and pass
 * the error text as a second argument, so a name carrying '%s' swallowed that argument, and a name
 * carrying a line break wrote a second, made-up log line. The format string is now a constant and the
 * name and the error go in as arguments, each reduced to one line by core/log-safe.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

// Repoint the DB before anything loads the DB layer. No database is opened: the read fails first.
const config = require('../config/app');
config.dbPath = path.join(os.tmpdir(), `wordjs-options-error-log-${process.pid}-${Date.now()}.db`);
config.dbDriver = 'sqlite-native';

const cache = require('../core/cache');
const { getOption } = require('../core/options');

/** Run `fn` with process.stderr captured (and kept off the real stream); returns what it wrote. */
async function captureStderr(fn: () => Promise<any>): Promise<{ result: any; text: string }> {
    const chunks: string[] = [];
    const realWrite = process.stderr.write;
    (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
        chunks.push(String(chunk));
        const done = rest.find((a) => typeof a === 'function');
        if (done) done();
        return true;
    };
    try {
        const result = await fn();
        return { result, text: chunks.join('') };
    } finally {
        (process.stderr as any).write = realWrite;
    }
}

test('an option name with a format directive and a line break is logged literally, on one line', async () => {
    const realGet = cache.get;
    cache.get = async () => { throw new Error('cache unavailable'); };
    let captured: { result: any; text: string };
    try {
        captured = await captureStderr(() => getOption('widget_evil%s\nFORGED ENTRY', 'fallback'));
    } finally {
        cache.get = realGet;
    }

    assert.strictEqual(captured.result, 'fallback', 'a failed read still answers the default');
    const lines = captured.text.split('\n').filter((line) => line.length > 0);
    assert.deepStrictEqual(lines, ['Error getting option widget_evil%sFORGED ENTRY: cache unavailable'],
        'one line: the name keeps its %s, loses its line break, and the error text is not consumed');
});
