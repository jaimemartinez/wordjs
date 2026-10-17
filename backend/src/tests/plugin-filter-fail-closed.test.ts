/**
 * A failing isolated-plugin filter on a FAIL-CLOSED hook rejects; on any other hook it falls back.
 *
 * THE DEFECT THIS PINS. The isolate's hook shim turned every failure of a plugin's filter callback — a
 * throw, a crash, a timeout — into "return the value unchanged". Right for a content filter, inverted for
 * `comments:pre_insert`, whose contract (routes/comments COMMENT_PRE_INSERT_FILTER) says a callback that
 * throws refuses the comment: a broken anti-spam plugin let every comment through, and a captcha plugin's
 * deliberate refusal was dropped. Now (hook-access `failClosed`):
 *   · a throw carrying the plugin's own 4xx status and rest_* code rejects with exactly those;
 *   · any other throw rejects with a 503 `rest_plugin_check_failed`;
 *   · the same plugin throwing on an ordinary filter still falls back to the unchanged value;
 *   · a plugin that does not throw still decides normally.
 * Drives REAL isolates (same harness as plugin-hook-privacy.test.ts).
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

require('../config/app'); // preload (trusted context)
const express = require('express');
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('../core/plugin-isolate');
const { setApp } = require('../core/appRegistry');
const hooks = require('../core/hooks');
const perms = require('../core/plugin-permissions');

const PLUGINS_DIR = path.resolve(__dirname, '../../plugins');
const SLUG = 'failclosed-probe';
const COMMENT = { postId: 1, author: 'Alice', content: 'hello', status: '0' };

// The plugin's verdict is steered by the comment text, so one isolate covers every case.
const SOURCE =
    "module.exports = function (wordjs) {\n" +
    "  wordjs.hooks.addFilter('comments:pre_insert', (verdict, c) => {\n" +
    "    if (c.content === 'crash') throw new Error('internal detail: db password is hunter2');\n" +
    "    if (c.content === 'captcha') { const e = new Error('Solve the captcha first.'); e.status = 422; e.code = 'rest_captcha_required'; throw e; }\n" +
    "    if (c.content === 'spam') return false;\n" +
    "    return verdict;\n" +
    "  });\n" +
    "  wordjs.hooks.addFilter('failclosed_probe_content', (v) => { if (v === 'crash') throw new Error('boom'); return v + '!'; });\n" +
    "};\n";

describe('fail-closed plugin filters', () => {
    before(async () => {
        setApp(express());
        const dir = path.join(PLUGINS_DIR, SLUG);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
            name: SLUG, isolated: true, permissions: [{ scope: 'comments', access: 'read' }],
        }));
        fs.writeFileSync(path.join(dir, 'index.js'), SOURCE);
        perms._setGrantsInMemory(SLUG, ['comments:read']);
        await loadIsolatedPlugin(SLUG, path.join(dir, 'index.js'));
    });
    after(() => {
        try { unloadIsolatedPlugin(SLUG); } catch { /* */ }
        try { fs.rmSync(path.join(PLUGINS_DIR, SLUG), { recursive: true, force: true }); } catch { /* */ }
        perms._setGrantsInMemory(SLUG, []);
    });

    const preInsert = (content: string) => hooks.applyFilters('comments:pre_insert', true, { ...COMMENT, content });

    test('control: a passing and a spam verdict are decided by the plugin', async () => {
        assert.strictEqual(await preInsert('fine'), true);
        assert.strictEqual(await preInsert('spam'), false);
    });

    test('a callback that throws REJECTS comments:pre_insert (503, no plugin internals)', async () => {
        await assert.rejects(preInsert('crash'), (e: any) => {
            assert.strictEqual(e.status, 503);
            assert.strictEqual(e.code, 'rest_plugin_check_failed');
            assert.doesNotMatch(String(e.message), /hunter2/, 'the plugin\'s internal message must not reach the client');
            return true;
        });
    });

    test('a deliberate refusal keeps the plugin\'s own 4xx status and rest_* code', async () => {
        await assert.rejects(preInsert('captcha'), (e: any) => {
            assert.strictEqual(e.status, 422);
            assert.strictEqual(e.code, 'rest_captcha_required');
            assert.match(String(e.message), /captcha/);
            return true;
        });
    });

    test('NEGATIVE CONTROL: on an ordinary filter a throw still falls back to the unchanged value', async () => {
        assert.strictEqual(await hooks.applyFilters('failclosed_probe_content', 'ok'), 'ok!');
        assert.strictEqual(await hooks.applyFilters('failclosed_probe_content', 'crash'), 'crash');
    });
});
