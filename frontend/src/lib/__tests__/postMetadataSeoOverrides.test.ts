/**
 * PER-POST SEO OVERRIDES — what actually reaches the <head>.
 *
 * THE BUG THIS PINS. The editor persists `seo_title`, `seo_description`, `og_image` and `noindex`
 * into post meta and reports success, but buildPostMetadata() — the ONLY metadata builder the public
 * routes use — derived the title from `post.title` and the description from the excerpt, and emitted
 * no `robots` key at all. Every override except `og_image` was written and then ignored: the editor
 * said "saved" while the live page rendered exactly what it rendered before.
 *
 * Three properties are asserted:
 *   1. an override PRESENT wins, in the document title/description AND in OpenGraph/Twitter;
 *   2. an override ABSENT (missing, empty, whitespace) falls back to the OLD derivation, unchanged,
 *      and still emits NO `robots` key — the no-regression half;
 *   3. `noindex` truthy emits `robots: { index: false, follow: false }` (the Next Metadata shape
 *      Next renders as <meta name="robots" content="noindex, nofollow">).
 *
 * The meta SHAPE is part of the contract: post.meta reaches us as an object through Post.toJSON,
 * but as a raw JSON string through paths that never went through it — both are covered, because an
 * override honoured for only one of them is the same silent failure with a smaller blast radius.
 */

import { describe, it, expect } from 'vitest';
import { buildPostMetadata } from '@/lib/server-api';
import type { Post } from '@/lib/api';

function makePost(overrides: Partial<Post> = {}): Post {
    return {
        id: 1,
        title: 'Título del post',
        slug: 'hola',
        content: '<p>Cuerpo del artículo</p>',
        excerpt: 'Extracto del artículo',
        status: 'publish',
        type: 'post',
        date: '2026-01-01 00:00:00',
        author: { id: 1, displayName: 'A' },
        commentStatus: 'open',
        ...overrides,
    } as Post;
}

describe('buildPostMetadata — per-post SEO overrides', () => {
    // ---------------------------------------------------------------- 1. override present

    it('prefers meta.seo_title / meta.seo_description over the post title and excerpt', () => {
        const md = buildPostMetadata(makePost({
            meta: { seo_title: 'Título SEO a medida', seo_description: 'Descripción SEO a medida' },
        }));

        expect(md.title).toBe('Título SEO a medida');
        expect(md.description).toBe('Descripción SEO a medida');
        // The overrides travel to the social cards too — an og:title that contradicts the <title>
        // is what every social validator flags.
        expect((md.openGraph as { title?: string })?.title).toBe('Título SEO a medida');
        expect((md.openGraph as { description?: string })?.description).toBe('Descripción SEO a medida');
        expect((md.twitter as { title?: string })?.title).toBe('Título SEO a medida');
        expect((md.twitter as { description?: string })?.description).toBe('Descripción SEO a medida');
    });

    it('honours each override independently — one set, the other still derived', () => {
        const onlyTitle = buildPostMetadata(makePost({ meta: { seo_title: 'Solo el título' } }));
        expect(onlyTitle.title).toBe('Solo el título');
        expect(onlyTitle.description).toBe('Extracto del artículo');

        const onlyDescription = buildPostMetadata(makePost({ meta: { seo_description: 'Solo la descripción' } }));
        expect(onlyDescription.title).toBe('Título del post');
        expect(onlyDescription.description).toBe('Solo la descripción');
    });

    it('reads the overrides when post.meta arrives as a raw JSON STRING, not an object', () => {
        const md = buildPostMetadata(makePost({
            meta: JSON.stringify({ seo_title: 'Desde una cadena', noindex: true }) as unknown as Record<string, unknown>,
        }));
        expect(md.title).toBe('Desde una cadena');
        expect(md.robots).toEqual({ index: false, follow: false });
    });

    it('accepts a numeric override — getAllMeta JSON.parses "2026" into the NUMBER 2026', () => {
        const md = buildPostMetadata(makePost({ meta: { seo_title: 2026 } }));
        expect(md.title).toBe('2026');
    });

    // ---------------------------------------------------------------- 2. override absent (no regression)

    it('falls back EXACTLY to the previous derivation when no override is set', () => {
        const bare = buildPostMetadata(makePost());
        expect(bare.title).toBe('Título del post');
        expect(bare.description).toBe('Extracto del artículo');
        expect(bare.robots).toBeUndefined();
        expect(bare.alternates?.canonical).toBe('/hola');

        // An empty / whitespace-only override is NOT an override: the editor always sends the keys,
        // with '' when the author left the field blank, so a blank must not blank the page's title.
        const blank = buildPostMetadata(makePost({
            meta: { seo_title: '', seo_description: '   ', noindex: false },
        }));
        expect(blank).toEqual(bare);
    });

    it('is byte-identical to the no-meta build for a post carrying only unrelated meta', () => {
        // _puck_data / _wjs_template travel on every editor save; they must not perturb the head.
        const withOtherMeta = buildPostMetadata(makePost({
            meta: { _puck_data: { content: [] }, _wjs_template: 'single' },
        }));
        expect(withOtherMeta).toEqual(buildPostMetadata(makePost()));
    });

    it('still derives the description from the body when there is no excerpt and no override', () => {
        const md = buildPostMetadata(makePost({ excerpt: '' }));
        expect(md.description).toBe('Cuerpo del artículo');
    });

    it('leaves the og:image behaviour untouched (the one override that already worked)', () => {
        const md = buildPostMetadata(makePost({ meta: { og_image: '/uploads/social.png' } }));
        expect((md.openGraph as { images?: string[] })?.images).toEqual(['/uploads/social.png']);
        expect((md.twitter as { card?: string })?.card).toBe('summary_large_image');
    });

    // ---------------------------------------------------------------- 3. noindex

    it('emits robots { index: false, follow: false } when noindex is set', () => {
        expect(buildPostMetadata(makePost({ meta: { noindex: true } })).robots)
            .toEqual({ index: false, follow: false });
    });

    it('accepts every stored spelling of the flag, and only those', () => {
        // The editor writes a real boolean; imports and legacy content use these strings.
        for (const hidden of [true, 'true', 'TRUE', ' true ', '1', 1, 'yes', 'on']) {
            const md = buildPostMetadata(makePost({ meta: { noindex: hidden } }));
            expect(md.robots, `${JSON.stringify(hidden)} must hide the post`)
                .toEqual({ index: false, follow: false });
        }
        // Fail-OPEN: anything unrecognised leaves a live page indexable rather than guessing.
        for (const visible of [false, 'false', '0', 0, '', '   ', 'no', 'off', null, undefined, {}]) {
            const md = buildPostMetadata(makePost({ meta: { noindex: visible } }));
            expect(md.robots, `${JSON.stringify(visible)} must NOT emit robots`).toBeUndefined();
        }
    });

    it('does not disturb the rest of the head when it hides a post', () => {
        const hidden = buildPostMetadata(makePost({ meta: { noindex: true } }), { siteName: 'Sitio' });
        const visible = buildPostMetadata(makePost(), { siteName: 'Sitio' });
        expect(hidden.title).toBe(visible.title);
        expect(hidden.description).toBe(visible.description);
        expect(hidden.alternates).toEqual(visible.alternates);
        expect(hidden.openGraph).toEqual(visible.openGraph);
        expect(hidden.twitter).toEqual(visible.twitter);
    });
});
