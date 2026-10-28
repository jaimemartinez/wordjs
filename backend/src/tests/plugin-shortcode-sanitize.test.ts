/**
 * A PLUGIN'S SHORTCODE HTML PASSES THE HOST'S SANITIZER (like its widgets do).
 *
 * A shortcode a plugin or theme registers renders inside a post, on public pages. Its return value is
 * plugin-controlled, so the host sanitizes it on its own side — once, in core/shortcodes.ts, for every
 * kind of owner: an in-process plugin, an isolated plugin (whose registration is a host shim resolving
 * the worker's reply over RPC) and a theme. Core shortcodes (owner null) are host code and untouched.
 *
 * The allowance on top of sanitizeContent is inert accessibility/loading markup only (role, aria-*,
 * tabindex, img loading/decoding): the bundled photo-carousel's output must come through unchanged,
 * which is pinned here by running that plugin's real shortcode handler.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

require('../config/app'); // preload (trusted context)
const express = require('express');
const { addShortcode, removeShortcode, doShortcode, doShortcodeAsync } = require('../core/shortcodes');
const { runWithContext } = require('../core/plugin-context');
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('../core/plugin-isolate');
const { setApp } = require('../core/appRegistry');
const { sanitizeShortcodeOutput } = require('../core/formatting');

const HOSTILE = '<p class="note">ok</p><script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">x</a><iframe src="https://evil.example"></iframe>';

function assertNoScriptChannel(out: string) {
    assert.doesNotMatch(out, /<script/i, out);
    assert.doesNotMatch(out, /onerror/i, out);
    assert.doesNotMatch(out, /javascript:/i, out);
    assert.doesNotMatch(out, /<iframe/i, out);
    assert.match(out, /<p class="note">ok<\/p>/, 'benign markup survives');
}

const ISO_SLUG = 'test-shortcode-sanitize-iso';
const isoDir = path.join(path.resolve(__dirname, '../../plugins'), ISO_SLUG);

before(async () => {
    setApp(express());
    fs.mkdirSync(isoDir, { recursive: true });
    fs.writeFileSync(path.join(isoDir, 'manifest.json'), JSON.stringify({ name: ISO_SLUG, isolated: true }));
    fs.writeFileSync(path.join(isoDir, 'index.js'),
        "exports.init = function (wordjs) {\n" +
        `  wordjs.shortcodes.add('iso_hostile', async () => ${JSON.stringify(HOSTILE)});\n` +
        "};\n");
    await loadIsolatedPlugin(ISO_SLUG, path.join(isoDir, 'index.js'));
});

after(() => {
    try { unloadIsolatedPlugin(ISO_SLUG); } catch { /* */ }
    try { fs.rmSync(isoDir, { recursive: true, force: true }); } catch { /* */ }
});

test('an in-process plugin shortcode (sync) is sanitized: no <script>, no on* handler, no javascript: URL', () => {
    runWithContext('sc-plugin-sync', () => addShortcode('sc_sync_hostile', () => HOSTILE));
    try {
        assertNoScriptChannel(doShortcode('[sc_sync_hostile]'));
    } finally { runWithContext('sc-plugin-sync', () => removeShortcode('sc_sync_hostile')); }
});

test('an in-process plugin shortcode (async) is sanitized through doShortcodeAsync', async () => {
    runWithContext('sc-plugin-async', () => addShortcode('sc_async_hostile', async () => HOSTILE));
    try {
        const out = await doShortcodeAsync('before [sc_async_hostile] after');
        assert.ok(out.startsWith('before ') && out.endsWith(' after'), out);
        assertNoScriptChannel(out);
    } finally { runWithContext('sc-plugin-async', () => removeShortcode('sc_async_hostile')); }
});

test('an ISOLATED plugin shortcode is sanitized where the host receives the worker reply', async () => {
    const out = await doShortcodeAsync('[iso_hostile]');
    assert.notStrictEqual(out, '[iso_hostile]', 'the isolated shortcode is registered');
    assertNoScriptChannel(out);
});

test('a THEME shortcode (owner theme:<x>) is sanitized too', async () => {
    runWithContext('theme:sc-theme', () => addShortcode('sc_theme_hostile', () => HOSTILE));
    try {
        assertNoScriptChannel(await doShortcodeAsync('[sc_theme_hostile]'));
    } finally { runWithContext('theme:sc-theme', () => removeShortcode('sc_theme_hostile')); }
});

test('a CORE shortcode (host code, owner null) is not rewritten', async () => {
    const markup = '<div data-core="1"><button type="button">x</button></div>';
    addShortcode('sc_core_markup', () => markup);
    try {
        assert.strictEqual(await doShortcodeAsync('[sc_core_markup]'), markup);
    } finally { removeShortcode('sc_core_markup'); }
});

test('a handler returning null/undefined still renders empty, and a rejecting handler leaves the tag', async () => {
    runWithContext('sc-plugin-edge', () => {
        addShortcode('sc_null', () => null);
        addShortcode('sc_throw', async () => { throw new Error('boom'); });
    });
    try {
        assert.strictEqual(await doShortcodeAsync('a[sc_null]b'), 'ab');
        assert.strictEqual(await doShortcodeAsync('[sc_throw]'), '[sc_throw]');
    } finally { runWithContext('sc-plugin-edge', () => { removeShortcode('sc_null'); removeShortcode('sc_throw'); }); }
});

test('accessibility and loading attributes are kept; style tags, forms and data-* follow sanitizeContent', () => {
    const out = sanitizeShortcodeOutput('<div role="region" aria-label="Slides" tabindex="0" data-x="1" onclick="x()"><img src="/a.jpg" alt="a" loading="lazy" decoding="async"></div><style>body{}</style><form action="/x"><input name="q"></form>');
    assert.match(out, /role="region"/);
    assert.match(out, /aria-label="Slides"/);
    assert.match(out, /tabindex="0"/);
    assert.match(out, /loading="lazy"/);
    assert.match(out, /decoding="async"/);
    assert.doesNotMatch(out, /onclick|<style|<form|<input|data-x/);
});

test('the bundled photo-carousel shortcode renders unchanged through the sanitizer', async () => {
    const pluginEntry = path.resolve(__dirname, '../../../marketplace/plugins/photo-carousel/index.js');
    const carousel = {
        images: [
            { url: '/uploads/2026/10/a.jpg', caption: 'First & "best"', alt: 'A' },
            '/uploads/2026/10/b.jpg',
        ],
    };
    let handler: any = null;
    const bridge = {
        // Key-agnostic on purpose: the plugin may namespace its option names (photo_carousel_…).
        options: { get: async (key: string, def: any = null) => (String(key).endsWith('carousel_home') ? carousel : def), set: async () => true, update: async () => true, delete: async () => true },
        http: new Proxy({}, { get: () => () => undefined }),
        shortcodes: { add: (tag: string, fn: any) => { if (tag === 'carousel') handler = fn; } },
        adminMenu: { add: () => undefined },
    };
    const mod = require(pluginEntry);
    // Its init() logs a banner with console.log; keep the node:test result channel (stdout) clean.
    const log = console.log;
    console.log = () => undefined;
    try { mod.init(bridge); } finally { console.log = log; }
    assert.ok(handler, 'photo-carousel registers [carousel]');
    const raw = await handler({ id: 'home' });
    assert.match(raw, /aria-roledescription="carousel"/, 'precondition: the plugin emits its a11y markup');

    runWithContext('photo-carousel', () => addShortcode('carousel', handler));
    try {
        const out = await doShortcodeAsync('[carousel id="home"]');
        assert.strictEqual(out, raw.replace(/<img ([^>]*)>/g, '<img $1 />'), 'only the void-tag spelling changes');
    } finally { runWithContext('photo-carousel', () => removeShortcode('carousel')); }
});

test("the bundled video-gallery shortcode's placeholder survives (the public page resolves it)", async () => {
    runWithContext('video-gallery', () => addShortcode('vgallery', (attrs: any) => `[vgallery id="${attrs.id || 'default'}"]`));
    try {
        // Shortcodes are expanded once (spliced, not re-scanned), so the placeholder comes back as text.
        assert.strictEqual(await doShortcodeAsync('[vgallery id="trips"]'), '[vgallery id="trips"]');
    } finally { runWithContext('video-gallery', () => removeShortcode('vgallery')); }
});
