import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VideoEmbedBlock } from '../blocks';

/**
 * The video block, at RENDER time: what actually reaches the `src` of the iframe.
 *
 * The block used to pick a provider with `url.includes("youtube.com/watch")` / `url.includes(
 * "vimeo.com/")`. Both are satisfied by a URL the site owner never chose — a look-alike host
 * (`youtube.com.evil.test`) or the provider's name sitting in the PATH of someone else's host
 * (`evil.test/youtube.com/watch?v=…`) — and the id was then cut out of that foreign URL and pasted
 * into an embed. The classifier now parses the URL and compares the whole host, so these render the
 * placeholder instead of an iframe.
 */
const render = (url: string) => renderToStaticMarkup(<VideoEmbedBlock url={url} />);
const srcOf = (html: string) => /<iframe[^>]*\ssrc="([^"]*)"/.exec(html)?.[1] ?? null;

describe('VideoEmbedBlock — provider by parsed host', () => {
    it('embeds the real providers', () => {
        expect(srcOf(render('https://www.youtube.com/watch?v=abc123'))).toBe(
            'https://www.youtube.com/embed/abc123?rel=0&amp;modestbranding=1',
        );
        expect(srcOf(render('https://youtu.be/abc123'))).toBe(
            'https://www.youtube.com/embed/abc123?rel=0&amp;modestbranding=1',
        );
        expect(srcOf(render('https://vimeo.com/123456'))).toBe('https://player.vimeo.com/video/123456');
    });

    it('renders the placeholder — never an iframe — for look-alike hosts', () => {
        for (const url of [
            'https://evil.test/youtube.com/watch?v=abc123',
            'https://evil.test/youtu.be/abc123',
            'https://vimeo.com.evil.test/x/vimeo.com/123456',
            'https://youtube.com.evil.test/watch?v=abc123',
            'https://player.vimeo.com.evil.test/video/123456',
            'javascript:alert(1)',
        ]) {
            const html = render(url);
            expect(html, url).not.toContain('<iframe');
            expect(html, url).toContain('wp-block-video-embed__placeholder');
        }
    });

    it('a root-relative path still plays as a self-hosted <video>', () => {
        const html = render('/media/clip.mp4');
        expect(html).toContain('<video');
        expect(html).not.toContain('<iframe');
    });
});
