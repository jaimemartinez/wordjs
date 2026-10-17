/**
 * MEDIA OFFLOAD — the share image follows the page body to the CDN.
 *
 * With the whole library in the bucket, the public SSR rewrites the body's /uploads/ URLs to the CDN
 * (`media_public_base`), but og:image, twitter:image and the JSON-LD image kept the featured image's
 * absolute `<site>/uploads/…` URL, which only answers with a 302 to the bucket. They now use the same
 * base, from the featured image's relative `path`; without a base they are what they always were.
 *
 * MUTATION PROOF: drop the mediaBase branch from pickOgImage and the first two cases fail.
 */
import { describe, it, expect } from 'vitest';
import { buildPostMetadata, buildPostJsonLd } from '@/lib/server-api';
import type { Post } from '@/lib/api';

const CDN = 'https://cdn.example.com/media';
const post = {
    id: 7,
    title: 'Pour-over',
    slug: 'pour-over',
    content: '<p>x</p>',
    excerpt: 'x',
    status: 'publish',
    type: 'post',
    date: '2026-01-01 00:00:00',
    author: { id: 1, displayName: 'A' },
    commentStatus: 'open',
    featuredMedia: { id: 3, url: 'https://www.example.com/uploads/2026/10/kettle.jpg', path: '/uploads/2026/10/kettle.jpg', title: 'Kettle' },
} as unknown as Post;

const ogImages = (m: any) => m.openGraph?.images;

describe('share image with the library on a CDN', () => {
    it('og:image and twitter:image use the CDN copy', () => {
        const m = buildPostMetadata(post, { mediaBase: CDN });
        expect(ogImages(m)).toEqual([`${CDN}/2026/10/kettle.jpg`]);
        expect((m.twitter as any).images).toEqual([`${CDN}/2026/10/kettle.jpg`]);
    });

    it('the JSON-LD image uses the CDN copy', () => {
        const ld = buildPostJsonLd(post, 'https://www.example.com', 'Site', CDN) as any;
        expect(ld.image).toEqual([`${CDN}/2026/10/kettle.jpg`]);
    });

    it('without a base (or with an unusable one) nothing changes', () => {
        expect(ogImages(buildPostMetadata(post))).toEqual(['https://www.example.com/uploads/2026/10/kettle.jpg']);
        expect(ogImages(buildPostMetadata(post, { mediaBase: 'javascript:alert(1)' }))).toEqual(['https://www.example.com/uploads/2026/10/kettle.jpg']);
        expect((buildPostJsonLd(post, 'https://www.example.com') as any).image).toEqual(['https://www.example.com/uploads/2026/10/kettle.jpg']);
    });
});
