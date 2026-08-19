/**
 * THE `class` ATTRIBUTE AT THE WRITE BOUNDARY OF post_content AND COMMENTS.
 *
 * This is the backend half of the class-channel gate. Its twin,
 * `frontend/src/components/blocks/__tests__/classAttributeChannel.test.tsx`, derives the whole emitter
 * population (every sanitizer configuration in either package that admits a `class` attribute) and
 * pins the read boundary plus the `_puck_data` write boundary. This half exists because
 * `core/formatting.ts` cannot be executed from the frontend suite: vitest hands the module to Node's
 * own `require`, which cannot resolve its `./sanitize-meta` sibling without a `.ts` extension, while
 * ts-node — this suite — can.
 *
 * WHY THIS BOUNDARY IS THE WORST ONE. `POST /comments` is `optionalAuth`; the body goes through
 * `Comment.create` → `sanitizeContent` (this file's subject) and lands `status='0'`, i.e. in the
 * moderation queue WITHOUT any approval. `frontend/src/app/admin/comments/page.tsx` paints that queue
 * with dangerouslySetInnerHTML, and the admin document loads the same Tailwind bundle the public site
 * does. So `<div class="fixed inset-0 z-50 w-full h-full bg-white"><a href="…">…</a></div>` from a
 * visitor with NO ACCOUNT rendered a full-screen, opaque, attacker-linked overlay inside /admin, in
 * front of the one session whose capabilities are worth phishing.
 *
 * The payload corpus is DERIVED from the refused vocabulary itself (CSS_POSITION_KEYWORDS, imported
 * from the criterion), so adding a keyword adds cases here rather than waiting for a test author.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';

const sanitizeHtml = require('sanitize-html');
const { sanitizeContent } = require('../core/formatting');
const {
    safeClassAttribute,
    withClassBound,
    CSS_POSITION_KEYWORDS,
} = require('../core/sanitize-meta');

/** Every class token an HTML string actually carries, however it is spelled. */
function classTokensOf(html: string): string[] {
    const out: string[] = [];
    for (const m of html.matchAll(/\bclass="([^"]*)"/g)) out.push(...m[1].split(/\s+/).filter(Boolean));
    return out;
}

const OVERLAY_UTILITIES = 'inset-0 z-50 w-full h-full bg-white';
const OVERLAY_CLASS_LISTS: string[] = [...(CSS_POSITION_KEYWORDS as Set<string>)]
    .map((kw) => `${kw} ${OVERLAY_UTILITIES}`);

/** What real content carries: a WordPress import, an expanded shortcode, a widget, a theme hook. */
const LEGITIMATE_CLASS_LISTS = [
    'wp-block-image',
    'wp-block-image alignwide size-large wp-image-42',
    'gallery gallery-columns-3',
    'wp-caption alignleft',
    'widget widget-title',
    'has-large-font-size',
    'wjs-block-heading wp-block-heading',
    'hero-scanline glow-panel celda-ancha',
    'md:flex w-1/2',
];

describe('sanitizeContent — the class channel of post bodies and comments', () => {
    test('an ANONYMOUS COMMENT cannot carry a position keyword into the moderation queue', () => {
        for (const classList of OVERLAY_CLASS_LISTS) {
            const comment = `<div class="${classList}">` +
                '<a href="https://evil.test/login">Your session has expired — sign in again</a></div>';
            const stored = sanitizeContent(comment);
            for (const kw of CSS_POSITION_KEYWORDS as Set<string>) {
                assert.ok(!classTokensOf(stored).includes(kw), `kept "${kw}" from "${classList}": ${stored}`);
            }
            // The comment is not destroyed — refusing the channel must not delete what the visitor
            // actually wrote, exactly as a rejected style declaration does not.
            assert.match(stored, /Your session has expired/);
            assert.match(stored, /evil\.test\/login/);
        }
    });

    test("real content's classes come through byte-identical", () => {
        for (const classList of LEGITIMATE_CLASS_LISTS) {
            const out = sanitizeContent(`<div class="${classList}">body</div>`);
            assert.deepStrictEqual(classTokensOf(out), classList.split(' '), `altered "${classList}"`);
        }
    });

    test('a rejected token is dropped and its siblings survive', () => {
        const out = sanitizeContent('<p class="wp-block-image fixed alignwide">x</p>');
        assert.deepStrictEqual(classTokensOf(out), ['wp-block-image', 'alignwide']);
    });

    test('the filter is the SHARED function, not a second copy of the rule', () => {
        // Same criterion, driven through the sanitizer and directly. If someone re-implemented the
        // rule inside formatting.ts, these two would eventually disagree on some token.
        const corpus = [...OVERLAY_CLASS_LISTS, ...LEGITIMATE_CLASS_LISTS, 'FIXED alignwide', 'x'.repeat(80)];
        for (const classList of corpus) {
            const out = sanitizeContent(`<div class="${classList}">x</div>`);
            const expected = safeClassAttribute(classList).split(' ').filter(Boolean);
            assert.deepStrictEqual(classTokensOf(out), expected, `disagreement on "${classList}"`);
        }
    });

    test('a caller that brings its OWN sanitizer configuration is bounded too', () => {
        // `allowedTags` REPLACES the whole configuration. A caller passing one would otherwise
        // re-open the exact channel this function exists to close.
        const out = sanitizeContent(
            '<div class="fixed inset-0 z-50"><a href="https://evil.test/login">x</a></div>',
            { allowedTags: ['div', 'a'], allowedAttributes: { '*': ['class', 'href'] } },
        );
        assert.ok(!classTokensOf(out).includes('fixed'), out);
        assert.match(out, /inset-0/);
    });
});

describe('withClassBound — the wrapper every sanitizer in this package goes through', () => {
    test('it keeps the transforms a configuration already declares', () => {
        // The iframe sandbox and the rel="noopener" transforms live in exactly such a config; a bound
        // that clobbered them would trade one hole for another.
        let sawTag = '';
        const config = withClassBound({
            allowedTags: ['div'],
            allowedAttributes: { '*': ['class', 'data-seen'] },
            transformTags: {
                '*': (tagName: string, attribs: Record<string, string>) => {
                    sawTag = tagName;
                    return { tagName, attribs: { ...attribs, 'data-seen': 'yes' } };
                },
            },
        });
        const out = sanitizeHtml('<div class="fixed alignwide">x</div>', config);
        assert.strictEqual(sawTag, 'div');
        assert.match(out, /data-seen="yes"/);
        assert.deepStrictEqual(classTokensOf(out), ['alignwide']);
    });

    test('a PER-TAG transform still runs, and the class is still bounded', () => {
        // sanitize-html runs `transformTagsMap[name]` and THEN `transformTagsAll` — the '*' entry is
        // not a fallback. If that ever changed, `a` and `iframe` would silently lose the bound.
        const config = withClassBound({
            allowedTags: ['a'],
            allowedAttributes: { a: ['class', 'href', 'rel'] },
            transformTags: {
                a: (tagName: string, attribs: Record<string, string>) => ({
                    tagName,
                    attribs: { ...attribs, rel: 'noopener noreferrer' },
                }),
            },
        });
        const out = sanitizeHtml('<a href="https://x.test" class="btn absolute">t</a>', config);
        assert.match(out, /rel="noopener noreferrer"/);
        assert.deepStrictEqual(classTokensOf(out), ['btn']);
    });

    test('an attribute with nothing left is REMOVED, not emitted empty', () => {
        const out = sanitizeContent('<p class="fixed">x</p>');
        assert.ok(!out.includes('class'), out);
    });
});
