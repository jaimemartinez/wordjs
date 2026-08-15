/**
 * MULTILINGUAL hreflang (FRENTE E-2) — RENDERED head contract.
 *
 * buildPostMetadata() produces the Next `Metadata` object that Next renders VERBATIM into the page
 * <head>. `alternates.languages` becomes one `<link rel="alternate" hreflang="…" href="…">` per entry
 * (metadataBase absolutizes the relative hrefs). These tests assert that object — i.e. exactly what
 * gets rendered — for three cases:
 *
 *   • a grouped post emits a self-reference PLUS one alternate per published sibling;
 *   • a lone / monolingual post emits NO `languages` key at all (⇒ zero hreflang tags — no regression);
 *   • a post with a group but no own language emits nothing (an incomplete set is not emitted).
 *
 * Mutation proof: the grouped case pins the exact hreflang→href map, and the lone case pins ABSENCE,
 * so deleting or weakening the emission block in server-api.ts fails one of them.
 */

import { describe, it, expect } from 'vitest';
import { buildPostMetadata } from '@/lib/server-api';
import type { Post } from '@/lib/api';

function makePost(overrides: Partial<Post> = {}): Post {
    return {
        id: 1,
        title: 'Hello',
        slug: 'hello',
        content: '<p>Body</p>',
        excerpt: 'Body',
        status: 'publish',
        type: 'post',
        date: '2026-01-01 00:00:00',
        author: { id: 1, displayName: 'A' },
        commentStatus: 'open',
        ...overrides,
    } as Post;
}

describe('buildPostMetadata hreflang alternates', () => {
    it('emits a self-reference plus one alternate per published sibling for a grouped post', () => {
        const post = makePost({
            slug: 'hola',
            language: 'es',
            translations: [
                { id: 2, language: 'en', slug: 'hello', type: 'post' },
                { id: 3, language: 'pt-BR', slug: 'ola', type: 'post' },
            ],
        });

        const md = buildPostMetadata(post, { canonicalPath: '/hola' });
        const languages = md.alternates?.languages as Record<string, string> | undefined;

        expect(languages).toBeDefined();
        // Self-reference: the current page's own language points at its canonical.
        expect(languages!['es']).toBe('/hola');
        // Each published sibling maps to its own path.
        expect(languages!['en']).toBe('/hello');
        expect(languages!['pt-BR']).toBe('/ola');
        // Exactly the three languages — no phantom entries.
        expect(Object.keys(languages!).sort()).toEqual(['en', 'es', 'pt-BR']);
        // Canonical is untouched.
        expect(md.alternates?.canonical).toBe('/hola');
    });

    it('emits NO languages key for a lone / monolingual post (zero hreflang tags)', () => {
        const lone = makePost({ language: null, translations: [] });
        const md = buildPostMetadata(lone);
        expect(md.alternates?.languages).toBeUndefined();

        // A post with no multilingual fields at all (the pre-feature shape) is likewise untouched.
        const bare = makePost();
        expect(buildPostMetadata(bare).alternates?.languages).toBeUndefined();
    });

    it('emits nothing when a post has translations but no language of its own (incomplete set)', () => {
        const post = makePost({
            language: null,
            translations: [{ id: 2, language: 'en', slug: 'hello', type: 'post' }],
        });
        expect(buildPostMetadata(post).alternates?.languages).toBeUndefined();
    });
});
