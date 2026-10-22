/**
 * S3-13 — the publication date in og:article:published_time and JSON-LD datePublished is ISO 8601 in
 * UTC, including the Postgres shape `…575536+00` (an offset of hours alone), which was not ISO either.
 */
import { describe, it, expect } from 'vitest';
import { isoPostDate, buildPostMetadata } from '@/lib/server-api';
import type { Post } from '@/lib/api';

describe('isoPostDate (S3-13)', () => {
    it('reads the UTC dateGmt, the Postgres +00 offset, and refuses what is not a date', () => {
        expect(isoPostDate('2026-10-21 11:47:59', '2026-10-21 06:47:59')).toBe('2026-10-21T11:47:59.000Z');
        expect(isoPostDate('2026-10-21 11:44:43.575536+00')).toBe('2026-10-21T11:44:43.575Z');
        expect(isoPostDate('not a date')).toBeUndefined();
    });

    it('reaches the OpenGraph article metadata', () => {
        const post = { id: 1, title: 'T', slug: 't', type: 'post', content: '', excerpt: '', status: 'publish', date: '2026-10-21 06:47:59', dateGmt: '2026-10-21 11:47:59', author: { id: 1, displayName: 'A', slug: 'a' }, commentStatus: 'open' } as unknown as Post;
        const meta = buildPostMetadata(post, {} as never) as any;
        expect(meta.openGraph.publishedTime).toBe('2026-10-21T11:47:59.000Z');
    });
});
