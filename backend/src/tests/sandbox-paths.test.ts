import { describe, test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';

const { sandboxPaths, storageKey } = require('../core/sandbox-paths');

describe('shared native sandbox filesystem authority', () => {
    const root = path.resolve(path.join(path.sep, 'srv', 'wordjs', 'backend'));
    const core = path.join(root, 'dist', 'core');

    test('never grants the install root or shared mutable roots', () => {
        const p = sandboxPaths(root, 'alpha', core);
        assert.deepStrictEqual(p.readOnly, [core, path.join(root, 'node_modules'), path.join(root, 'plugins', 'alpha')]);
        assert.ok(!p.readOnly.includes(root));
        for (const shared of ['uploads', 'data', 'logs', 'os-tmp', 'themes']) {
            assert.ok(!p.writable.includes(path.join(root, shared)), `${shared} root must not be writable`);
        }
        assert.ok(!p.readOnly.some((entry: string) => /wordjs-config|\.sqlite|\.db$/i.test(entry)));
    });

    test('private storage is deterministic, collision-resistant and disjoint between plugins', () => {
        const a = sandboxPaths(root, 'alpha', core);
        const a2 = sandboxPaths(root, 'alpha', core);
        const b = sandboxPaths(root, 'beta', core);
        assert.deepStrictEqual(a.storage, a2.storage);
        assert.strictEqual(new Set(a.storage).size, 3);
        assert.ok(!a.storage.some((entry: string) => b.storage.includes(entry)));
        assert.notStrictEqual(storageKey('theme:alpha'), storageKey('theme-alpha'));
        for (const entry of a.storage) assert.ok(entry.includes(`${path.sep}plugins${path.sep}${storageKey('alpha')}`));
    });

    test('plugin and theme ownership remain narrow and traversal is not read authority', () => {
        const plugin = sandboxPaths(root, 'alpha', core);
        const theme = sandboxPaths(root, 'theme:aurora', core);
        assert.strictEqual(plugin.own, path.join(root, 'plugins', 'alpha'));
        assert.strictEqual(theme.own, path.join(root, 'themes', 'aurora'));
        assert.ok(plugin.traverse.includes(root));
        assert.ok(!plugin.readOnly.includes(root));
        assert.ok(!plugin.writable.includes(theme.own));
    });

    test('multisite: another site\'s worker has its own storage and never writes the shared code directory', () => {
        const main = sandboxPaths(root, 'alpha', core);
        const two = sandboxPaths(root, 'alpha', core, 2);
        const three = sandboxPaths(root, 'alpha', core, 3);
        assert.strictEqual(main.ownWritable, true);
        assert.ok(!main.writable.includes(main.own), 'the code directory is read-only on every site');
        assert.ok(main.writable.includes(main.ownData), 'site 1 writes its own data directory instead');
        assert.deepStrictEqual(sandboxPaths(root, 'alpha', core, 1), main, 'site 1 is exactly the single-site answer');
        assert.strictEqual(two.own, main.own, 'the code is shared');
        assert.ok(two.readOnly.includes(two.own), 'and readable');
        assert.strictEqual(two.ownWritable, false);
        assert.ok(!two.writable.includes(two.own), 'but never writable from another site');
        // Every site has a non-empty write set: the native launch needs at least one zone to exist.
        assert.ok(two.writable.length > 0);
        assert.ok(!two.storage.some((e: string) => main.storage.includes(e) || three.storage.includes(e)), 'storage never shared across sites');
    });

    test('invalid internal identities fail closed before becoming kernel paths', () => {
        for (const bad of ['', '.', '..', '../alpha', 'alpha/beta', 'alpha\\beta', '/absolute', 'theme:', 'theme:../x']) {
            assert.throws(() => sandboxPaths(root, bad, core), /invalid isolated-plugin slug/);
        }
    });
});

test('storage keys are unchanged for every bundled plugin and theme, and linear on any input', () => {
    // Keys name folders on disk (private storage, the plugins' own data): any change orphans existing data.
    const GOLDEN: Record<string, string> = {
        "analytics-tag": "analytics-tag-021aa901e1c6",
        "auctions": "auctions-facaa4e27a22",
        "bookings": "bookings-5cc6c019278a",
        "breadcrumbs": "breadcrumbs-ad89596effb5",
        "card-gallery": "card-gallery-79cdc2c9db71",
        "conference-manager": "conference-manager-de745200bf26",
        "contact-forms": "contact-forms-59edf292b91c",
        "cookie-consent": "cookie-consent-bb50d0ba4726",
        "digital-downloads": "digital-downloads-56b565b5570c",
        "donations": "donations-ff7c3633b08f",
        "event-tickets": "event-tickets-ebf975ba431e",
        "events-calendar": "events-calendar-934505c61fdb",
        "faq": "faq-30de18cc4ea2",
        "image-lightbox": "image-lightbox-711735186565",
        "invoices": "invoices-491dabd42b00",
        "job-board": "job-board-6411dbcf2d9d",
        "mail-server": "mail-server-dacf587c09e0",
        "memberships": "memberships-5050625e7d19",
        "newsletter": "newsletter-dd6f465f6810",
        "notification-bar": "notification-bar-21c05862ba91",
        "online-store": "online-store-c92fe99b2aeb",
        "photo-carousel": "photo-carousel-a0cf9d6e5614",
        "polls": "polls-77f48a0505bd",
        "popup-builder": "popup-builder-7b5b9acc0aae",
        "related-posts": "related-posts-9b76316f3243",
        "restaurant-menu": "restaurant-menu-c73512fad617",
        "social-share": "social-share-13213eceb891",
        "table-of-contents": "table-of-contents-aba21f3f4dbd",
        "testimonials": "testimonials-e9358dc482ae",
        "vendor-marketplace": "vendor-marketplace-8c818f58d1f9",
        "video-gallery": "video-gallery-c2e4ccdb31f1",
        "youtube-videos": "youtube-videos-f2115c2993dd",
        "theme:circuito": "theme-circuito-46e255f13e71",
        "theme:default": "theme-default-a4b2108ed322",
        "theme:gaceta": "theme-gaceta-d8dc5f09f09a",
        "theme:vergel": "theme-vergel-8bc9200ee833",
        "s2:mail-server": "s2-mail-server-0131ef8b0c4f",
        "s17:conference-manager": "s17-conference-manager-2de437a93eef",
        "s2:theme:default": "s2-theme-default-b223d3b3ffdd",
        "": "plugin-5e689e2b0167",
        "Mixed_Case.Slug": "mixed_case.slug-c2c5fbb51fa9",
        "--edge--": "edge-38e00fb273e8",
        "theme:": "theme-f15fd3df9642",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-ffe054fe7ae0",
    };
    for (const [slug, key] of Object.entries(GOLDEN)) assert.strictEqual(storageKey(slug), key, JSON.stringify(slug));
    // Every bundled plugin and theme is pinned above, so a new one fails here until its key is recorded.
    const repo = path.resolve(__dirname, '..', '..', '..');
    const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
    const bundled = [
        ...fs.readdirSync(path.join(repo, 'marketplace', 'plugins')).filter((d: string) => isDir(path.join(repo, 'marketplace', 'plugins', d))),
        ...fs.readdirSync(path.join(repo, 'backend', 'themes')).filter((d: string) => isDir(path.join(repo, 'backend', 'themes', d))).map((d: string) => `theme:${d}`),
    ];
    for (const slug of bundled) assert.ok(slug in GOLDEN, `${slug} is pinned`);
    // A long run of '-' that does not reach the end (the old `^-+|-+$` rescanned it from every position:
    // about 4 s at 80,000 dashes, quadrupling with each doubling) finishes at once, and the readable part
    // is still trimmed of its dashes.
    const t0 = Date.now();
    const key = storageKey('x' + '-'.repeat(200000) + 'x');
    assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
    assert.match(key, /^x-[0-9a-f]{12}$/, 'the first 256 characters are "x" and dashes, trimmed to "x"');
    assert.match(storageKey('---abc---'), /^abc-[0-9a-f]{12}$/);
});
