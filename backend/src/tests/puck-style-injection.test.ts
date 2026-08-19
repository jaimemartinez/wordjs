/**
 * ARBITRARY CSS THROUGH THE `_puck_data` STYLE CHANNEL — the WRITE boundary.
 *
 * The payload never travels as HTML, so no HTML sanitizer ever saw it. It travels as a JSON OBJECT
 * (`props.css`, `props.look`) that the renderer hands to React, which turns it into a `style`
 * attribute — and React does NOT escape `;` inside a style VALUE. `sanitizePuckTree` used to recurse
 * into those objects like any other and run `safePuckUrl` on their string leaves, which only blanks a
 * value that STARTS with `javascript:`/`data:`/`vbscript:`/`file:`. So
 *
 *     props.css.color = "red;position:fixed;inset:0;z-index:2147483647;background:#fff url(https://…)"
 *
 * was stored verbatim by any account with `publish_posts`, and served verbatim from the site's own
 * origin: a full-screen attacker-controlled overlay with an IP/User-Agent beacon in the background
 * url(), and — behind an invisible fixed link — the whole viewport clickable to the attacker's
 * destination. It is NOT XSS (no script runs, no cookie leaves); it is phishing on the victim's domain.
 *
 * WHAT IS PINNED HERE. `sanitizeMetaValue` is the ONE write boundary: `routes/posts.ts` calls it on
 * every meta write, `core/wxr-import.ts` calls it for every imported meta, and `core/collab-ops.ts`
 * routes each collaborative prop change through `sanitizePuckTree` with the prop name as `keyHint` —
 * so all three paths inherit whatever this function does. It is exercised directly, over a
 * realistically shaped tree, in all three of the shapes the field actually arrives in (object, JSON
 * string, and a nested breakpoint spec).
 *
 * The MIRROR of this criterion lives in `frontend/src/components/blocks/safeStyle.ts` and is pinned
 * against this implementation, over one corpus, by
 * frontend/src/components/content/__tests__/blockStyleInjection.test.tsx.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
    sanitizeMetaValue,
    sanitizePuckTree,
    sanitizeStyleObject,
    sanitizeLookSpec,
    safeCssUrl,
    sanitize,
} = require('../core/sanitize-meta');

/** The overlay payload, verbatim. */
const OVERLAY =
    'red;position:fixed;inset:0;z-index:2147483647;background:#fff url(https://attacker.example/x.png) center/contain no-repeat';

const tree = () => ({
    root: { props: {} },
    content: [
        {
            type: 'Text',
            props: {
                id: 'Text-1',
                content: '<p>hello</p>',
                css: { color: OVERLAY, position: 'fixed', inset: '0', zIndex: '2147483647' },
                look: {
                    bg: 'color',
                    bgColor: OVERLAY,
                    bgImage: '//attacker.example/x.png',
                    color: '#111',
                    padY: 10,
                    gradAnimate: true,
                    tb: { padY: 5, align: 'left;position:fixed' },
                },
            },
        },
    ],
});

describe('_puck_data — the object style channel is CSS, and gets the CSS criterion', () => {
    it('drops a css declaration list smuggled through an allowed property', () => {
        const clean = sanitizeMetaValue('_puck_data', tree());
        // `color` IS an allowed property — the value is what carried three more declarations.
        assert.deepStrictEqual(clean.content[0].props.css, {});
        assert.ok(!JSON.stringify(clean).includes('position:fixed'));
    });

    it('drops property names no editor control can produce', () => {
        assert.deepStrictEqual(
            sanitizeStyleObject({ position: 'fixed', inset: '0', zIndex: '9', padding: '4px' }),
            { padding: '4px' },
        );
    });

    it('blanks a hostile look string but keeps the spec shape (isSet reads "" as unset)', () => {
        const look = sanitizeMetaValue('_puck_data', tree()).content[0].props.look;
        assert.strictEqual(look.bgColor, '');
        assert.strictEqual(look.color, '#111');
        assert.strictEqual(look.padY, 10, 'numbers must survive untouched');
        assert.strictEqual(look.gradAnimate, true, 'booleans must survive untouched');
        assert.strictEqual(look.tb.padY, 5, 'the nested breakpoint object keeps its shape');
        assert.strictEqual(look.tb.align, '', 'and is filtered with the same rule');
    });

    it('a _puck_data sent as a JSON STRING goes through the same guard', () => {
        const clean = JSON.parse(sanitizeMetaValue('_puck_data', JSON.stringify(tree())));
        assert.deepStrictEqual(clean.content[0].props.css, {});
        assert.strictEqual(clean.content[0].props.look.bgColor, '');
    });

    it('keeps everything an author legitimately chose', () => {
        const ok = sanitizeMetaValue('_puck_data', {
            content: [
                {
                    props: {
                        css: {
                            color: '#112233',
                            padding: '12px 24px',
                            fontFamily: 'Inter, sans-serif',
                            boxShadow: '0 1px 2px rgb(0 0 0 / .06), 0 1px 3px rgb(0 0 0 / .10)',
                            width: 'clamp(20ch, 60%, 70ch)',
                            opacity: 0.5,
                        },
                        look: { bgColor: '#fff', fontFamily: 'X', align: 'left', bgImage: '/uploads/a.png' },
                    },
                },
            ],
        });
        assert.deepStrictEqual(ok.content[0].props.css, {
            color: '#112233',
            padding: '12px 24px',
            fontFamily: 'Inter, sans-serif',
            boxShadow: '0 1px 2px rgb(0 0 0 / .06), 0 1px 3px rgb(0 0 0 / .10)',
            width: 'clamp(20ch, 60%, 70ch)',
            opacity: 0.5,
        });
        assert.deepStrictEqual(ok.content[0].props.look, {
            bgColor: '#fff', fontFamily: 'X', align: 'left', bgImage: '/uploads/a.png',
        });
    });

    it('the CRDT path inherits it: sanitizePuckTree is keyed by the PROP NAME', () => {
        // core/collab-ops.ts cleanValueEx() calls exactly this, with the prop name as keyHint, so a
        // collaborative `setProp('css', …)` cannot reopen what the REST route closed.
        assert.deepStrictEqual(sanitizePuckTree({ color: OVERLAY }, 'css'), {});
        assert.deepStrictEqual(sanitizePuckTree({ bgColor: OVERLAY }, 'look'), { bgColor: '' });
    });
});

describe('where a URL is the point, an ORIGIN is required and the token is quoted', () => {
    it('accepts a path on this site and an absolute http(s) URL', () => {
        assert.strictEqual(safeCssUrl('/uploads/a.png'), '/uploads/a.png');
        assert.strictEqual(safeCssUrl('https://cdn.example/a.png?x=1'), 'https://cdn.example/a.png?x=1');
    });

    it('rejects both authority-relative spellings — `\\` parses exactly like `/`', () => {
        assert.strictEqual(safeCssUrl('//evil.example/a.png'), null);
        assert.strictEqual(safeCssUrl('/\\evil.example/a.png'), null);
    });

    it('rejects schemes with no origin we serve, and anything that could close the token', () => {
        for (const bad of [
            'data:image/svg+xml,<svg/>',
            'javascript:alert(1)',
            'file:///etc/passwd',
            'a.png) ;position:fixed;background:url(b',
            '/uploads/a".png',
        ]) {
            assert.strictEqual(safeCssUrl(bad), null, `safeCssUrl accepted ${bad}`);
        }
    });

    it('a surviving url() comes back quoted, and only on a URL-bearing property', () => {
        assert.deepStrictEqual(
            sanitizeStyleObject({ backgroundImage: 'url(/uploads/a.png)', background: 'url(/uploads/a.png)' }),
            { backgroundImage: 'url("/uploads/a.png")' },
        );
        assert.strictEqual(sanitizeLookSpec({ bgImage: 'https://cdn.example/a.png' }).bgImage,
            'https://cdn.example/a.png');
    });
});

describe('the embed-host list (#26): the backend copy does not delete what the frontend accepts', () => {
    it('keeps an iframe on the privacy-enhanced YouTube host', () => {
        // MIRROR of frontend/embed-hosts.js. It used to omit www.youtube-nocookie.com, so pasting the
        // markup YouTube hands you for "privacy-enhanced mode" silently lost the iframe on save.
        for (const host of ['www.youtube.com', 'player.vimeo.com', 'www.youtube-nocookie.com']) {
            const html = `<iframe src="https://${host}/embed/x" width="560" height="315"></iframe>`;
            assert.ok(sanitize(html).includes(host), `backend sanitize() dropped ${host}`);
        }
    });

    it('and still drops every other host, including look-alikes', () => {
        assert.ok(!sanitize('<iframe src="https://evil.example/embed/x"></iframe>').includes('evil.example'));
        assert.ok(
            !sanitize('<iframe src="https://www.youtube.com.evil.example/embed/x"></iframe>').includes('evil.example'),
        );
    });
});
