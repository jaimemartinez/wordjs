/**
 * PURGE PATHS MUST NAME A ROUTE THAT EXISTS.
 *
 * A purge carries two things: cache TAGS and cache PATHS. The tags do the real work — Next
 * invalidates every route whose render consumed a tagged fetch, so `post:<slug>` reaches a post
 * wherever it is rendered. The paths are the belt to that pair of braces, and they were derived by
 * assumption rather than from the route map: `purgeForPost` emitted `/<postName>` for EVERY post
 * type.
 *
 * That is right for a post — frontend/src/app/(public)/[slug] serves it — and wrong for a PAGE,
 * whose route is (public)/pages/[slug]. Publishing "About" purged `/about` and never named
 * `/pages/about`, the URL the admin's own menu builder links to. Nothing visibly broke (the tag
 * covered it), which is exactly what makes it worth pinning: the emitted path was a claim in the
 * purge log that matched no route, waiting for someone to trust it.
 *
 * These tests drive the REAL derivation — the module's own `purgeForPost`, over real HTTP, against a
 * stub frontend — not a fixture of what the paths ought to be.
 *
 * MUTATION PROOF: against the pre-fix module `publicPathsForPost` does not exist (the destructure
 * yields undefined and the unit tests throw), and the end-to-end page test sees `['/', '/about']`
 * instead of `['/', '/pages/about', '/about']`. Collapse the page branch back to a single
 * `/<slug>` and both page tests fail; drop `/pages/` and the menu-URL assertion fails.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');

// ---------------------------------------------------------------------------------------------
// A stub frontend: records the { tags, paths } bodies delivered to /api/revalidate.
// ---------------------------------------------------------------------------------------------
function stubFrontend() {
    const received: any[] = [];
    const waiters: any[] = [];
    const server = http.createServer((req: any, res: any) => {
        let body = '';
        req.on('data', (c: any) => (body += c));
        req.on('end', () => {
            const hit = { url: req.url, body };
            received.push(hit);
            waiters.splice(0).forEach((w: any) => w(hit));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"revalidated":true}');
        });
    });
    // Always waits for the NEXT arrival, never one already seen.
    const next = (ms = 8000) => new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no purge arrived within ${ms}ms`)), ms);
        waiters.push((hit: any) => { clearTimeout(timer); resolve(hit); });
    });
    return { server, received, next };
}

const listen = (server: any) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server: any) => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));

/**
 * Stand in for backend/src/models/Post BEFORE frontend-purge requires it, so the derivation runs
 * against a known post without a database. `purgeForPost` does `require('../models/Post')` from
 * core/, which resolves to the very same file this test resolves from tests/.
 */
function installFakePostModel(posts: Record<string, any>) {
    const target = require.resolve('../models/Post');
    const m = new Module(target, null);
    m.filename = target;
    m.loaded = true;
    m.exports = { findById: async (id: any) => posts[String(id)] || null };
    require.cache[target] = m;
    return target;
}

describe('publicPathsForPost — one path per route that actually serves the post', () => {
    let dir = '';
    let cwd = '';
    let frontend: any;
    let publicPathsForPost: any;
    let purgeForPost: any;

    before(async () => {
        cwd = process.cwd();
        frontend = stubFrontend();
        const port = await listen(frontend.server);

        // A single-host split, so the DIRECT transport applies and the purge lands on our stub.
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-purge-paths-'));
        fs.writeFileSync(path.join(dir, 'wordjs-config.json'), JSON.stringify({
            installedAt: new Date().toISOString(),
            dbDriver: 'sqlite-native',
            siteUrl: 'http://localhost:3000',
            frontendUrl: `http://127.0.0.1:${port}`,
            revalidateSecret: 'lab-secret',
        }));

        installFakePostModel({
            7: { id: 7, postName: 'hello-world', postType: 'post' },
            8: { id: 8, postName: 'about', postType: 'page' },
            9: { id: 9, postName: 'espresso', postType: 'menu_item' },
            10: { id: 10, postName: '', postType: 'post' },
        });

        // configManager resolves its config path from the cwd at load time — chdir before requiring.
        // The certificate paths are anchored to the INSTALLATION, not to the cwd (frontend-purge's
        // BACKEND_ROOT), so a staged installation in a temp directory must say where it is.
        process.chdir(dir);
        process.env.WORDJS_BACKEND_ROOT = dir;
        ({ publicPathsForPost, purgeForPost } = require('../core/frontend-purge'));
    });

    after(async () => {
        process.chdir(cwd);
        await close(frontend.server);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    test('a post is served at /<slug> — that is the only path it gets', () => {
        assert.deepStrictEqual(publicPathsForPost({ postName: 'hello-world', postType: 'post' }), ['/hello-world']);
    });

    test('a PAGE names /pages/<slug> — the URL the admin menu builder links to', () => {
        const paths = publicPathsForPost({ postName: 'about', postType: 'page' });
        assert.ok(paths.includes('/pages/about'), 'the page route (public)/pages/[slug] must be named');
        // The catch-all /[slug] resolves a page too (the slug lookup is not type-filtered) and the
        // page's own <head> declares it canonical, so it is a real URL as well — not decoration.
        assert.deepStrictEqual(paths, ['/pages/about', '/about']);
    });

    test('a custom post type falls under the catch-all route, like a post', () => {
        assert.deepStrictEqual(publicPathsForPost({ postName: 'espresso', postType: 'menu_item' }), ['/espresso']);
    });

    test('no slug means no path — never a bare "/" duplicate or "/undefined"', () => {
        assert.deepStrictEqual(publicPathsForPost({ postName: '', postType: 'post' }), []);
        assert.deepStrictEqual(publicPathsForPost({ postType: 'post' }), []);
        assert.deepStrictEqual(publicPathsForPost(null), []);
    });

    test('END TO END: publishing a page delivers /pages/<slug>, not just /<slug>', async () => {
        await purgeForPost(8);
        const hit = await frontend.next();
        assert.strictEqual(hit.url, '/api/revalidate');
        const { tags, paths } = JSON.parse(hit.body);
        assert.deepStrictEqual(paths, ['/', '/pages/about', '/about']);
        assert.ok(tags.includes('post:about'), 'the tag that does the real work is still there');
        assert.ok(tags.includes('posts:page'), 'and the per-type list tag');
    });

    test('END TO END: publishing a post still delivers exactly / and /<slug>', async () => {
        await purgeForPost(7);
        const hit = await frontend.next();
        const { tags, paths } = JSON.parse(hit.body);
        assert.deepStrictEqual(paths, ['/', '/hello-world'], 'the post path was already correct — do not regress it');
        assert.ok(tags.includes('post:hello-world'));
    });
});
