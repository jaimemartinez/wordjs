/**
 * WordJS — a failed option read is logged as ONE line that names the option literally.
 *
 * The option name can come from a request: routes/widgets.ts reads `widget_<id>` with the id taken
 * from the URL or the body. getOption used to put the name inside the console FORMAT string and pass
 * the error text as a second argument, so a name carrying '%s' swallowed that argument, and a name
 * carrying a line break wrote a second, made-up log line. The line is now a structured record: a
 * constant message, the name in its own `option` field (reduced to one line by core/log-safe) and the
 * error under `err` — what is asserted is the record the real logger emitted, read through its sink.
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

/** Run `fn` and return the log records the real logger emitted meanwhile. */
async function captureLog(fn: () => Promise<any>): Promise<{ result: any; records: any[] }> {
    const { addLogSink } = require('../core/logger');
    const records: any[] = [];
    const remove = addLogSink((line: string) => records.push(JSON.parse(line)));
    try {
        const result = await fn();
        return { result, records };
    } finally {
        remove();
    }
}

test('an option name with a format directive and a line break is logged literally, on one line', async () => {
    const realGet = cache.get;
    cache.get = async () => { throw new Error('cache unavailable'); };
    let captured: { result: any; records: any[] };
    try {
        captured = await captureLog(() => getOption('widget_evil%s\nFORGED ENTRY', 'fallback'));
    } finally {
        cache.get = realGet;
    }

    assert.strictEqual(captured.result, 'fallback', 'a failed read still answers the default');
    const records = captured.records.filter((r) => r.mod === 'core/options');
    assert.strictEqual(records.length, 1, 'one record');
    assert.strictEqual(records[0].msg, 'Error getting option');
    assert.strictEqual(records[0].option, 'widget_evil%sFORGED ENTRY',
        'the name keeps its %s and loses its line break');
    assert.strictEqual(records[0].err.message, 'cache unavailable', 'the error text is not consumed');
});

test('before installation a read that reaches the missing database is not an error line', async () => {
    // No database here, and the installer has not run (stubbed: the checkout may hold a config file). The
    // cache answers (a miss), the database read then fails — every request used to log that as an error.
    const configManager = require('../core/configManager');
    const realIsInstalled = configManager.isInstalled;
    configManager.isInstalled = () => false;
    let captured: { result: any; records: any[] };
    try {
        captured = await captureLog(() => getOption('mfa_policy', 'fallback'));
    } finally {
        configManager.isInstalled = realIsInstalled;
    }
    assert.strictEqual(captured.result, 'fallback');
    const errors = captured.records.filter((r) => r.mod === 'core/options' && r.level === 'error');
    assert.deepStrictEqual(errors, [], 'no error record before installation');
});
