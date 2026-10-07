/**
 * Hook privacy: a sandboxed plugin's hook subscriptions are READS of what the hook carries.
 *
 * Before the fix the isolate `register` IPC handler enforced only count caps and the raw-HTML denylist,
 * so a plugin with ZERO grants could subscribe to any core hook and the host serialized the full
 * arguments into its child: every commenter's email and IP (wp_insert_comment), every notification
 * including reset codes and tokens (notification_sent), every draft/private post body (wp_insert_post /
 * post_updated). These tests drive REAL isolates (the same harness as the PoC) and prove:
 *
 *   · a zero-permission plugin observes none of that data, nor a raw-HTML or reserved core hook;
 *   · a plugin holding the matching data grant does receive it — minimized: no commenter PII without
 *     comments:pii, no post password, no notification token/code/link, no protected option value;
 *   · comments:pii delivers the commenter's email/IP/agent; revoking a grant stops delivery at once;
 *   · the plugin's OWN hooks keep working, and first-party hook use (init) still registers;
 *   · every hook core fires is classified in core/hook-access (completeness scan of backend/src).
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
const hookAccess = require('../core/hook-access');

const PLUGINS_DIR = path.resolve(__dirname, '../../plugins');

// The spy subscribes to everything interesting and exposes what it saw through its OWN filter.
const SPY_SOURCE =
    "const seen = [];\n" +
    "const rec = (hook) => (...args) => { seen.push([hook, args]); return args[0]; };\n" +
    "exports.init = function (wordjs) {\n" +
    "  for (const h of ['wp_insert_comment', 'deleted_comment', 'notification_sent', 'wp_insert_post',\n" +
    "                   'post_updated', 'deleted_post', 'updated_option', 'init', 'wordjs_brand_new_core_hook'])\n" +
    "    wordjs.hooks.addAction(h, rec(h));\n" +
    "  for (const h of ['comments:pre_insert', 'dynamic_sidebar', 'wordjs_head'])\n" +
    "    wordjs.hooks.addFilter(h, rec(h));\n" +
    "  wordjs.hooks.addFilter('hookspy_own_filter', (v) => '[own]' + v);\n" +
    "  wordjs.hooks.addFilter('hookspy_dump', () => JSON.parse(JSON.stringify(seen.splice(0))));\n" +
    "};\n";

const SPIES: Record<string, string[]> = {
    'hookspy-zero': [],
    'hookspy-granted': ['comments:read', 'posts:read', 'notifications:read', 'settings:read'],
    'hookspy-pii': ['comments:read', 'comments:pii'],
};

const COMMENT = {
    postId: 1, author: 'Alice', authorEmail: 'alice@victim.example', authorUrl: 'https://alice.example',
    authorIp: '203.0.113.7', agent: 'Mozilla/5.0 Secret-UA', content: 'unapproved thoughts', status: '0',
};
const NOTIFICATION = {
    uuid: 'n1', user_id: 9, type: 'password_reset', title: 'Reset your password',
    message: 'Your code is 123456', data: { token: 'abc-reset-token', resetCode: '123456', note: 'kept' },
    action_url: '/reset-password?token=abc-reset-token&lang=en',
};
const DRAFT = { title: 'Unannounced merger', content: 'DRAFT BODY', status: 'draft', postPassword: 'pw-123' };

async function fireEverything() {
    await hooks.doAction('wp_insert_comment', 42, { ...COMMENT });
    await hooks.applyFilters('comments:pre_insert', true, { ...COMMENT });
    await hooks.doAction('deleted_comment', 42);
    await hooks.doAction('notification_sent', { ...NOTIFICATION, data: { ...NOTIFICATION.data } });
    await hooks.doAction('wp_insert_post', 7, { ...DRAFT });
    await hooks.doAction('post_updated', 7, { ...DRAFT }, 'draft');
    await hooks.doAction('deleted_post', 7, 'private');
    await hooks.doAction('updated_option', 'plugin_grants', { other: ['network'] });
    await hooks.doAction('updated_option', 'blogname', 'Public Name');
    await hooks.doAction('init');
    await hooks.doAction('wordjs_brand_new_core_hook', { email: 'x@y.z' });
    await hooks.applyFilters('dynamic_sidebar', '<p>w</p>', 'sidebar-1');
    await hooks.applyFilters('wordjs_head', []);
}

/** What the (single) loaded spy recorded, grouped by hook name. */
async function dump(): Promise<Record<string, any[][]>> {
    const out: Record<string, any[][]> = {};
    const raw = await hooks.applyFilters('hookspy_dump', null);
    for (const [hook, args] of raw || []) (out[hook] = out[hook] || []).push(args);
    return out;
}

describe('isolated plugin hook privacy', () => {
    before(async () => {
        setApp(express());
        for (const [slug, grants] of Object.entries(SPIES)) {
            const dir = path.join(PLUGINS_DIR, slug);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
                name: slug, isolated: true,
                permissions: grants.map((t) => { const [scope, access] = t.split(':'); return { scope, access }; }),
            }));
            fs.writeFileSync(path.join(dir, 'index.js'), SPY_SOURCE);
            perms._setGrantsInMemory(slug, grants);
        }
    });
    after(() => {
        for (const slug of Object.keys(SPIES)) {
            try { unloadIsolatedPlugin(slug); } catch { /* */ }
            try { fs.rmSync(path.join(PLUGINS_DIR, slug), { recursive: true, force: true }); } catch { /* */ }
            perms._setGrantsInMemory(slug, []);
        }
    });

    // One spy loaded at a time, so the shared `hookspy_dump` filter answers for exactly that plugin.
    async function observe(slug: string) {
        await loadIsolatedPlugin(slug, path.join(PLUGINS_DIR, slug, 'index.js'));
        try {
            await fireEverything();
            await new Promise((r) => setTimeout(r, 300)); // actions are fire-and-forget into the child
            assert.strictEqual(await hooks.applyFilters('hookspy_own_filter', 'x'), '[own]x',
                'the plugin\'s OWN hooks must keep working');
            return await dump();
        } finally {
            unloadIsolatedPlugin(slug);
        }
    }

    test('a ZERO-permission plugin observes no comment, notification, post or option data', async () => {
        const seen = await observe('hookspy-zero');
        const text = JSON.stringify(seen);
        for (const secret of ['alice@victim.example', '203.0.113.7', 'Secret-UA', 'unapproved thoughts',
            'abc-reset-token', '123456', 'DRAFT BODY', 'pw-123', 'Public Name']) {
            assert.ok(!text.includes(secret), `zero-permission plugin observed '${secret}': ${text}`);
        }
        for (const h of ['wp_insert_comment', 'comments:pre_insert', 'deleted_comment', 'notification_sent',
            'wp_insert_post', 'post_updated', 'deleted_post', 'updated_option', 'dynamic_sidebar', 'wordjs_head',
            'wordjs_brand_new_core_hook']) {
            assert.strictEqual(seen[h], undefined, `zero-permission plugin received '${h}'`);
        }
        // A public hook stays available to everyone (first-party plugins rely on `init`).
        assert.ok(seen['init'] && seen['init'].length === 1, 'public hook `init` must still be delivered');
    });

    test('a granted plugin receives the data, minimized: no PII, no secrets', async () => {
        const seen = await observe('hookspy-granted');
        const text = JSON.stringify(seen);

        const [cid, comment] = seen['wp_insert_comment'][0];
        assert.strictEqual(cid, 42);
        assert.strictEqual(comment.content, 'unapproved thoughts');
        assert.strictEqual(comment.author, 'Alice');
        for (const k of ['authorEmail', 'authorIp', 'agent']) {
            assert.ok(!(k in comment), `comment ${k} delivered without comments:pii`);
        }
        const [verdict, pre] = seen['comments:pre_insert'][0];
        assert.strictEqual(verdict, true);
        assert.ok(!('authorEmail' in pre) && !('authorIp' in pre), 'pre_insert leaked commenter PII');

        const [n] = seen['notification_sent'][0];
        assert.strictEqual(n.title, 'Reset your password');
        assert.strictEqual(n.data.note, 'kept');
        assert.strictEqual(n.data.token, '[redacted]');
        assert.strictEqual(n.data.resetCode, '[redacted]');

        const [pid, post] = seen['wp_insert_post'][0];
        assert.strictEqual(pid, 7);
        assert.strictEqual(post.content, 'DRAFT BODY');
        assert.ok(!('postPassword' in post), 'post password delivered to a plugin');
        assert.deepStrictEqual(seen['post_updated'][0].slice(2), ['draft']);
        assert.deepStrictEqual(seen['deleted_post'][0], [7, 'private']);

        const opts = Object.fromEntries(seen['updated_option'].map(([k, v]) => [k, v]));
        assert.strictEqual(opts['blogname'], 'Public Name');
        assert.strictEqual(opts['plugin_grants'], '[redacted]', 'protected option value leaked through the hook');

        for (const secret of ['alice@victim.example', '203.0.113.7', 'Secret-UA', 'abc-reset-token', '123456', 'pw-123']) {
            assert.ok(!text.includes(secret), `granted plugin still observed secret '${secret}'`);
        }
        // Grants never unlock the denied classes.
        assert.strictEqual(seen['dynamic_sidebar'], undefined);
        assert.strictEqual(seen['wordjs_head'], undefined);
    });

    test('comments:pii delivers the commenter\'s email, IP and agent', async () => {
        const seen = await observe('hookspy-pii');
        const [, comment] = seen['wp_insert_comment'][0];
        assert.strictEqual(comment.authorEmail, 'alice@victim.example');
        assert.strictEqual(comment.authorIp, '203.0.113.7');
        const [, pre] = seen['comments:pre_insert'][0];
        assert.strictEqual(pre.authorIp, '203.0.113.7');
        assert.strictEqual(seen['notification_sent'], undefined, 'no notifications:read grant');
        assert.strictEqual(seen['wp_insert_post'], undefined, 'no posts:read grant');
    });

    test('revoking a grant stops delivery immediately, without a reload', async () => {
        const slug = 'hookspy-pii';
        await loadIsolatedPlugin(slug, path.join(PLUGINS_DIR, slug, 'index.js'));
        try {
            perms._setGrantsInMemory(slug, []);
            await hooks.doAction('wp_insert_comment', 43, { ...COMMENT });
            await new Promise((r) => setTimeout(r, 200));
            const raw = await hooks.applyFilters('hookspy_dump', null);
            assert.deepStrictEqual((raw || []).filter(([h]: any) => h === 'wp_insert_comment'), []);
        } finally {
            unloadIsolatedPlugin(slug);
            perms._setGrantsInMemory(slug, SPIES[slug]);
        }
    });
});

describe('hook-access policy', () => {
    test('decisions: public, data-by-grant, denied, reserved, own', () => {
        perms._setGrantsInMemory('policy-probe', ['comments:read']);
        const ok = (h: string) => hookAccess.checkHookSubscription('policy-probe', h).ok;
        assert.strictEqual(ok('init'), true);
        assert.strictEqual(ok('wp_insert_comment'), true);
        assert.strictEqual(ok('wp_insert_post'), false);
        assert.strictEqual(ok('notification_sent'), false);
        assert.strictEqual(ok('wordjs_footer'), false);
        assert.strictEqual(ok('dynamic_sidebar'), false);
        assert.strictEqual(ok('wordjs_future_core_hook'), false);
        assert.strictEqual(ok('users:registered'), false);
        assert.strictEqual(ok('my_plugin_event'), true);
        assert.strictEqual(ok('the_content'), true, 'backend/plugins/hello-world subscribes to it (unclassified, not core-fired)');
        assert.strictEqual(ok('constructor'), true, 'a magic name is just an unclassified own hook');
        assert.strictEqual(ok(''), false);
        // admin does not imply pii (explicit only).
        perms._setGrantsInMemory('policy-probe', ['comments:admin']);
        const [, c] = hookAccess.argsForPlugin('policy-probe', 'wp_insert_comment', [1, { ...COMMENT }]);
        assert.ok(!('authorIp' in c));
        perms._setGrantsInMemory('policy-probe', []);
    });

    test('the in-process bridge refuses ungranted data hooks too', () => {
        const { createPluginApi } = require('../core/plugin-api');
        perms._setGrantsInMemory('bridge-probe', []);
        const api = createPluginApi('bridge-probe');
        assert.throws(() => api.hooks.addAction('wp_insert_comment', () => {}), /comments:read/);
        assert.throws(() => api.hooks.addFilter('wordjs_head', () => []), /not available to plugins/);
    });

    test('notifications.send redacts the notification_sent payload at the source', async () => {
        const notifications = require('../core/notifications');
        let got: any = null;
        const listener = (n: any) => { got = n; };
        hooks.addAction('notification_sent', listener);
        try {
            const sent = await notifications.send({ ...NOTIFICATION, transports: [] });
            await new Promise((r) => setTimeout(r, 50));
            assert.strictEqual(sent.data.token, 'abc-reset-token', 'the sender keeps the real notification');
        } finally {
            hooks.removeAction('notification_sent', listener);
        }
        assert.ok(got, 'notification_sent fired');
        assert.strictEqual(got.data.token, '[redacted]');
        assert.strictEqual(got.message, '[redacted]', 'a reset notification\'s text is the secret');
        assert.strictEqual(got.action_url, '[redacted]');
        // A non-sensitive type keeps its text; secret query params are still stripped from its link.
        const plain = hookAccess.redactNotificationForHook({ type: 'info', message: 'hi', action_url: '/x?token=t&a=1#f' });
        assert.strictEqual(plain.message, 'hi');
        assert.strictEqual(plain.action_url, '/x?token=[redacted]&a=1');
    });

    test('every hook core fires is classified in CORE_HOOK_POLICY', () => {
        const SRC = path.resolve(__dirname, '..');
        const files: string[] = [];
        const walk = (d: string) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) { if (!/^(tests|tests-integration|node_modules)$/.test(e.name)) walk(p); }
                else if (/\.(ts|js)$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(p);
            }
        };
        walk(SRC);
        // String constants anywhere in src (HOOK, AUDIT_PRUNE_HOOK, COMMENT_PRE_INSERT_FILTER, …).
        const consts = new Map<string, string>();
        for (const f of files) {
            for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/g)) consts.set(m[1], m[2]);
        }
        consts.set('ANALYTICS_PRUNE_HOOK', consts.get('HOOK')!); // index.ts: const { HOOK: ANALYTICS_PRUNE_HOOK }
        const resolve = (expr: string): string | null => {
            const e = expr.trim();
            const lit = e.match(/^['"`]([^'"`$]+)['"`]$/);
            if (lit) return lit[1];
            if (consts.has(e)) return consts.get(e)!;
            return null;
        };
        // Reviewed non-literal call sites: a dynamic name core dispatches. Each entry says where the names
        // come from; those names are checked below via the scheduleEvent scan.
        const REVIEWED_DYNAMIC = new Set(['core/cron.ts:event.hook']);
        const fired = new Set<string>();
        const unresolved: string[] = [];
        for (const f of files) {
            const rel = path.relative(SRC, f).split(path.sep).join('/');
            if (rel === 'core/hooks.ts' || rel === 'core/plugin-api.ts') continue; // the hook system / plugin-own doAction
            const lines = fs.readFileSync(f, 'utf8').split('\n');
            for (const line of lines) {
                const t = line.trim();
                if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
                for (const m of line.matchAll(/\b(?:doAction|applyFilters|doActionSync|applyFiltersSync)\(\s*([^,)]+)/g)) {
                    const name = resolve(m[1]);
                    if (name) fired.add(name);
                    else if (!REVIEWED_DYNAMIC.has(`${rel}:${m[1].trim()}`)) unresolved.push(`${rel}: ${t}`);
                }
                for (const m of line.matchAll(/\bschedule(Single)?Event\(([^;]*)\)/g)) {
                    if (rel === 'core/cron.ts' && /async function/.test(line)) continue;
                    const args = m[2].split(',');
                    const hookArg = args[m[1] ? 1 : 2];
                    if (hookArg === undefined) continue;
                    const name = resolve(hookArg);
                    if (name) fired.add(name);
                    else unresolved.push(`${rel}: ${t}`);
                }
            }
        }
        assert.deepStrictEqual(unresolved, [],
            'core fires a hook whose name this scan cannot resolve — classify it in core/hook-access and teach this test');
        assert.ok(fired.size >= 20, `scan found only ${fired.size} core hooks — the scan is no longer reading call sites`);
        const unclassified = [...fired].filter((h) => !hookAccess.getHookPolicy(h));
        assert.deepStrictEqual(unclassified, [],
            `core fires hooks missing from CORE_HOOK_POLICY (core/hook-access.ts): ${unclassified.join(', ')}`);
    });
});
