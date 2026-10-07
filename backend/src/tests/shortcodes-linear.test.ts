/**
 * SHORTCODE PARSING IS LINEAR — a contributor cannot freeze the event loop with a post body.
 *
 * The matcher used to be the regex `\[(tags)([^\]]*?)(?:\/\]|\](?:([^\[]*?)\[\/\1\]|))` (g flag). Its
 * attribute run is unbounded, so every `[tag` with no `]` after it scanned to the end of the document
 * before failing, and the engine then retried at the next `[tag`. "[gallery ".repeat(n) was O(n²):
 * ~0.35 s at 90 KB, ~5.4 s at 360 KB, ~87 s at 1.4 MB — on EVERY Post.toJSON of that post (content via
 * doShortcodeAsync, excerpt via stripShortcodes), from a draft any contributor can save.
 *
 * This suite pins:
 *   1. the observable output for valid shortcodes is unchanged (self-closing, bare, enclosing, the
 *      no-nesting rule, tag-prefix matching, unregistered tags, attribute forms);
 *   2. adversarial bodies of 1–2 MB serialize through the REAL Post.toJSON path, and go through
 *      stripShortcodes, in well under a second, with roughly linear growth;
 *   3. the per-document cap: past MAX_SHORTCODES_PER_DOCUMENT the remaining text is left as written.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// CWD in a temp dir and config.dbPath repointed BEFORE the DB layer / models load.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-shortcodes-linear-'));
process.chdir(TMP_ROOT);
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const { doShortcode, doShortcodeAsync, stripShortcodes, addShortcode, removeShortcode, MAX_SHORTCODES_PER_DOCUMENT } = require('../core/shortcodes');

// Generous on purpose (shared CI runners); the pre-fix code needed tens of seconds for these inputs.
const BOUND_MS = 1500;
const MB = 1024 * 1024;

function timed<T>(fn: () => T): { ms: number; out: T } {
    const t = process.hrtime.bigint();
    const out = fn();
    return { ms: Number(process.hrtime.bigint() - t) / 1e6, out };
}

// Each builder yields ~`bytes` of hostile body.
const ADVERSARIAL: Record<string, (bytes: number) => string> = {
    'no closing bracket ("[gallery " repeated)': (b) => '[gallery '.repeat(Math.ceil(b / 9)),
    'no whitespace, no closing bracket ("[gallery" repeated)': (b) => '[gallery'.repeat(Math.ceil(b / 8)),
    'many openings that never close ("[caption]x" repeated)': (b) => '[caption]x'.repeat(Math.ceil(b / 10)),
    'nested unclosed tags ("[columns][column " repeated)': (b) => '[columns][column '.repeat(Math.ceil(b / 17)),
    'one very long attribute run': (b) => '[gallery ' + 'ids=1,'.repeat(Math.ceil(b / 6)),
    'long attribute run with stray openings': (b) => '[button url="'.repeat(Math.ceil(b / 13)),
};

describe('shortcodes: unchanged output for valid content', () => {
    it('renders self-closing, bare and enclosing forms exactly as before', () => {
        assert.strictEqual(doShortcode('a [gallery ids="1,2" columns=4 /] b'),
            'a <div class="gallery gallery-columns-4" data-ids="1,2" data-size="thumbnail"></div> b');
        assert.strictEqual(doShortcode('[gallery ids="7"]'),
            '<div class="gallery gallery-columns-3" data-ids="7" data-size="thumbnail"></div>');
        assert.strictEqual(doShortcode('[caption id="c1" caption="Hi"]<img src="x.png">[/caption]'),
            '<figure id="c1" class="wp-caption alignnone" style="width:autopx"><img src="x.png"><figcaption class="wp-caption-text">Hi</figcaption></figure>');
        assert.strictEqual(doShortcode('[button url="https://example.com/"]Go[/button]'),
            '<a href="https://example.com/" target="_self" class="wp-button">Go</a>');
    });

    it('keeps the historical matching rules (no nesting, prefix tags, unregistered tags, stray brackets)', () => {
        // Inner content cannot contain '[': the outer tag renders empty, the inner one renders, the
        // outer closer stays as text.
        assert.strictEqual(doShortcode('[columns count=2][column]A[/column][/columns]'),
            '<div class="wp-columns columns-2"></div><div class="wp-column" >A</div>[/columns]');
        // No word boundary after the tag: "[columnsX]" is [columns] with attribute "X".
        assert.strictEqual(doShortcode('[columnsX]'), '<div class="wp-columns columns-2"></div>');
        assert.strictEqual(doShortcode('[unknown a=1] [gallery'), '[unknown a=1] [gallery');
        assert.strictEqual(doShortcode('[[gallery]]'),
            '[<div class="gallery gallery-columns-3" data-ids="" data-size="thumbnail"></div>]');
        // The attribute run ends at the FIRST ']' and may contain '['.
        assert.strictEqual(stripShortcodes('x[gallery a=[1] y]z'), 'x y]z');
        assert.strictEqual(stripShortcodes('[caption]keep[/caption]-[embed]u[/embed]-[video /]'), '--');
    });

    it('doShortcodeAsync matches doShortcode and awaits async handlers', async () => {
        const body = 'p [gallery ids="1"] q [caption]c[/caption] r [audio src="https://e.x/a.mp3"]';
        assert.strictEqual(await doShortcodeAsync(body), doShortcode(body));
        addShortcode('lin_async', async (a: any, c: string) => `<${a.v}:${c}>`);
        try {
            assert.strictEqual(await doShortcodeAsync('[lin_async v=1]in[/lin_async]!'), '<1:in>!');
        } finally { removeShortcode('lin_async'); }
    });
});

describe('shortcodes: adversarial bodies are processed in linear time', () => {
    let Post: any;

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        Post = require('../models/Post');
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); } catch { /* ignore */ }
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    for (const [name, build] of Object.entries(ADVERSARIAL)) {
        it(`stripShortcodes / doShortcode: ${name}, ~2 MB`, () => {
            const body = build(2 * MB);
            const strip = timed(() => stripShortcodes(body));
            const render = timed(() => doShortcode(body));
            assert.ok(strip.ms < BOUND_MS, `stripShortcodes took ${strip.ms.toFixed(0)} ms on ${body.length} bytes`);
            assert.ok(render.ms < BOUND_MS, `doShortcode took ${render.ms.toFixed(0)} ms on ${body.length} bytes`);
        });
    }

    it('growth is roughly linear (4x the input costs nowhere near 16x the time)', () => {
        const build = ADVERSARIAL['no closing bracket ("[gallery " repeated)'];
        const small = build(256 * 1024), large = build(1024 * 1024);
        stripShortcodes(small); // warm-up (regex compilation, JIT)
        const ts = timed(() => stripShortcodes(small)).ms;
        const tl = timed(() => stripShortcodes(large)).ms;
        // A floor keeps sub-millisecond noise from failing the ratio; quadratic behaviour blows far past both.
        assert.ok(tl < Math.max(ts * 8, 100), `256 KB: ${ts.toFixed(1)} ms, 1 MB: ${tl.toFixed(1)} ms`);
    });

    it('Post.toJSON (content + excerpt) of a ~1.5 MB hostile post stays well under the bound', async () => {
        for (const [name, build] of Object.entries(ADVERSARIAL)) {
            const body = build(1.5 * MB);
            const post = await Post.create({ title: `hostile ${name}`, content: body, excerpt: body, authorId: 1, status: 'draft', type: 'post' });
            const fresh = await Post.findById(post.id);
            const t = process.hrtime.bigint();
            const json = await fresh.toJSON();
            const ms = Number(process.hrtime.bigint() - t) / 1e6;
            assert.ok(ms < BOUND_MS, `Post.toJSON took ${ms.toFixed(0)} ms for "${name}" (${fresh.postContent.length} bytes)`);
            assert.strictEqual(typeof json.content, 'string');
            assert.strictEqual(typeof json.excerpt, 'string');
        }
    });

    it('caps the shortcodes processed per document and leaves the rest as written', async () => {
        const extra = 5;
        const body = '[video /]'.repeat(MAX_SHORTCODES_PER_DOCUMENT + extra);
        const out = await doShortcodeAsync(body);
        assert.strictEqual(out.split('<video controls').length - 1, MAX_SHORTCODES_PER_DOCUMENT);
        assert.ok(out.endsWith('[video /]'.repeat(extra)), 'text past the cap is left untouched, not dropped');
        assert.strictEqual(stripShortcodes(body), '[video /]'.repeat(extra));
    });
});
