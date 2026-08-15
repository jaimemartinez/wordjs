/**
 * WAVE 1b(A) — the audited micro-constants in wordjs-ui.css are theme-reachable tokens.
 *
 * Every literal geometry value that lived inside a stateful/variant selector (the open
 * accordion's icon rotation, the highlighted pricing plan's mobile transform, the video
 * play glyph's optical nudge, …) is now `var(--wjs-…, <literal>)` with the fallback
 * preserving the exact pre-tokenization value — a pixel-identical default render.
 *
 * Two assertions per seam, both against REAL build outputs (no fixtures):
 *   1. the stylesheet itself carries the var() with the exact fallback — a token nobody
 *      consumes at render time is a DEFECT, so the consumption site is the proof;
 *   2. backend/public/theme-tokens.json (the generated contract) records the token with
 *      that fallback and that consumer — proving the manifest was regenerated, i.e. the
 *      seam is actually reachable by themes/doctor/compiler, not just present in CSS.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// __dirname works from both src/tests and dist/tests — ../../public is backend/public either way.
const CSS = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'css', 'wordjs-ui.css'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'theme-tokens.json'), 'utf8'));

// [token, exact fallback (today's literal value), consumer selector, property, media-scoped]
const SEAMS: Array<[string, string, string, string, boolean]> = [
    // The six audited constants:
    ['--wjs-accordion-icon-open-transform', 'rotate(180deg)', '.wp-block-accordion__item.is-open .wp-block-accordion__icon', 'transform', false],
    ['--wjs-quote-large-align', 'center', '.wp-block-quote--large', 'text-align', false],
    ['--wjs-testimonial-initials-weight', '700', '.wp-block-testimonial__avatar--initials', 'font-weight', false],
    ['--wjs-pricing-highlight-mobile-transform', 'none', '.wp-block-pricing__plan--highlighted', 'transform', true],
    ['--wjs-pricing-highlight-mobile-hover-transform', 'translateY(-6px)', '.wp-block-pricing__plan--highlighted:hover', 'transform', true],
    ['--wjs-pricing-feature-icon-size', '18px', '.wp-block-pricing__feature i', 'font-size', false],
    ['--wjs-video-play-glyph-transform', 'translateX(6%)', '.wp-block-video-embed__play i', 'transform', false],
    // Siblings of the same shape (literal geometry in a stateful/variant selector):
    ['--wjs-video-play-hover-transform', 'scale(1.06)', '.wp-block-video-embed__cover:hover .wp-block-video-embed__play', 'transform', false],
    ['--wjs-button-active-transform', 'scale(0.96)', '.wp-block-button__link:active', 'transform', false],
    ['--wjs-audio-icon-hover-transform', 'scale(1.05)', '.wp-block-audio-player__button:hover', 'transform', false],
    ['--wjs-audio-icon-active-transform', 'scale(0.96)', '.wp-block-audio-player__button:active', 'transform', false],
    ['--wjs-pricing-highlight-hover-transform', 'scale(var(--wjs-pricing-highlight-scale, 1.02)) translateY(-6px)', '.wp-block-pricing__plan--highlighted:hover', 'transform', false],
    ['--wjs-cta-button-hover-transform', 'scale(1.03)', '.wp-block-cta-banner__button:hover', 'transform', false],
    ['--wjs-hero-button-hover-transform', 'scale(1.03)', '.wp-block-hero__button:hover', 'transform', false],
    ['--wjs-social-hover-transform', 'translateY(-2px)', '.wp-block-social-links__link:hover', 'transform', false],
];

describe('wordjs-ui.css geometry seams (WAVE 1b)', () => {
    for (const [token, fallback, selector, property, mediaScoped] of SEAMS) {
        it(`${token} is consumed with its exact pre-tokenization fallback`, () => {
            // 1. The stylesheet consumes the token with the literal preserved byte-for-byte.
            assert.ok(
                CSS.includes(`var(${token}, ${fallback})`),
                `wordjs-ui.css must contain "var(${token}, ${fallback})"`
            );
            // 2. The regenerated manifest exposes the seam to themes.
            const entry = MANIFEST.tokens[token];
            assert.ok(entry, `theme-tokens.json has no entry for ${token} — manifest not regenerated?`);
            assert.ok(
                entry.fallbacks.includes(fallback),
                `${token} fallbacks ${JSON.stringify(entry.fallbacks)} must include ${JSON.stringify(fallback)}`
            );
            const consumer = entry.consumers.find(
                (c: any) => c.selector === selector && c.property === property
            );
            assert.ok(consumer, `${token} must be consumed by "${selector}" for ${property}; got ${JSON.stringify(entry.consumers)}`);
            assert.strictEqual(
                consumer.media !== undefined, mediaScoped,
                `${token} consumer media-scoping mismatch: ${JSON.stringify(consumer)}`
            );
        });
    }

    it('wrapping the highlighted-hover transform did not orphan --wjs-pricing-highlight-scale', () => {
        // The old value consumed --wjs-pricing-highlight-scale directly; the new outer var()
        // moves it into a fallback, and the manifest's nested-var scan must still see it.
        const entry = MANIFEST.tokens['--wjs-pricing-highlight-scale'];
        assert.ok(entry, 'token vanished from the manifest');
        assert.ok(
            entry.consumers.some((c: any) => c.selector === '.wp-block-pricing__plan--highlighted:hover' && c.property === 'transform'),
            `nested var() consumption lost: ${JSON.stringify(entry.consumers)}`
        );
    });

    it('no tokenization changed a rendered default: every new token is undeclared in :root', () => {
        // The seams are pure escape hatches — ui.css must not DECLARE any of them (a :root
        // declaration would change the cascade for themes that set the token on a subtree).
        for (const [token] of SEAMS) {
            assert.strictEqual(
                MANIFEST.tokens[token].declaredDefault, null,
                `${token} must not be declared in :root — the fallback IS the default`
            );
        }
    });
});
