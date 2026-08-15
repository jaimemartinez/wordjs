import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import PostContent from '../PostContent';
import type { Post } from '@/lib/api';

/**
 * The single-post hooks, proven on BOTH bodies — at RENDER time, not by grepping the source.
 *
 * A post has two body paths: the visual editor's (`meta._puck_data` → ContentRenderer) and the
 * classic one (sanitized HTML). The frame — `.wjs-post`, `-header`, `-title`, `.wjs-post-meta*` —
 * used to be emitted by the classic branch ONLY, so the manifest kept promising those selectors while
 * they matched nothing the moment an author opened the post in the editor. chromeSelectorContract
 * cannot see that: it greps the source, and the source contains the class either way.
 *
 * So this file renders the component both ways and asserts the manifest's own promise holds on each.
 * The selectors are READ FROM THE MANIFEST rather than copied, so renaming a hook there without
 * moving the markup fails here.
 */

const MANIFEST = path.join(path.resolve(__dirname, '../../../../..'), 'backend/public/theme-tokens.json');
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as {
    elements: Record<string, { selector: string; children?: Record<string, { selector: string }> }>;
};

/** Every `.wjs-*` class token the named manifest elements promise, flattened. */
function promisedClasses(...keys: string[]): string[] {
    const out = new Set<string>();
    for (const key of keys) {
        const el = manifest.elements[key];
        expect(el, `manifest element "${key}" is missing — this test would assert nothing`).toBeTruthy();
        for (const sel of [el.selector, ...Object.values(el.children || {}).map((c) => c.selector)]) {
            for (const cls of sel.match(/\.wjs-[a-z0-9-]+/gi) || []) out.add(cls.slice(1));
        }
    }
    return [...out].sort();
}

const basePost = {
    id: 7,
    title: 'A post with two bodies',
    slug: 'two-bodies',
    content: '<p>classic body</p>',
    type: 'post',
    status: 'publish',
    date: '2026-08-13T10:00:00.000Z',
    commentStatus: 'closed',
    author: { displayName: 'Ada' },
} as unknown as Post;

const puckPost = {
    ...basePost,
    meta: {
        _puck_data: {
            root: { props: { title: 'A post with two bodies' } },
            content: [{ type: 'Heading', props: { id: 'h1', title: 'Composed in the editor', level: 'h2' } }],
        },
    },
} as unknown as Post;

const render = (post: Post, category?: string) =>
    renderToStaticMarkup(React.createElement(PostContent, { post, category, showComments: false }));

/**
 * A class token, matched only where it is really in a class attribute — and matched WHOLE.
 *
 * `\b` was the bug: a word boundary sits before a hyphen too, so `wjs-post-header` satisfied a check
 * for `wjs-post` and deleting `wjs-post` from the <article> left this file green. Every class here is
 * a prefix of a longer sibling, so that one boundary silently voided the assertions that matter most.
 * Class attributes are space-separated, so the separator is a space or the attribute's own edge.
 */
const emits = (html: string, cls: string) =>
    new RegExp(`class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"`).test(html);

describe('PostContent — the post frame is emitted on both body paths', () => {
    const classic = render(basePost, 'travel-notes');
    const puck = render(puckPost, 'travel-notes');

    it('renders two genuinely different bodies (or the comparison below is worthless)', () => {
        // The classic body is the sanitized HTML; the Puck body is the rendered block tree. If either
        // assertion breaks, this file is comparing one code path against itself.
        expect(classic).toContain('classic body');
        expect(classic).not.toContain('puck-content');
        expect(puck).toContain('Composed in the editor');
        expect(puck).toContain('puck-content');
        expect(puck).not.toContain('classic body');
    });

    const required = promisedClasses('singlePost', 'postMeta');

    it('promises a non-trivial set of hooks (guards against an empty manifest read)', () => {
        expect(required).toContain('wjs-post');
        expect(required).toContain('wjs-post-title');
        expect(required).toContain('wjs-post-body');
        expect(required.length).toBeGreaterThanOrEqual(7);
    });

    it.each(required)('%s is emitted by the CLASSIC body', (cls) => {
        expect(emits(classic, cls), `${cls} is promised by the manifest but absent from the classic render`).toBe(true);
    });

    it.each(required)('%s is emitted by the PUCK body', (cls) => {
        expect(emits(puck, cls), `${cls} is promised by the manifest but absent from the Puck render — a theme's rule for it would stop applying the moment an author edits the post`).toBe(true);
    });

    it('gives a Puck-composed post its title and byline, like the editor canvas does', () => {
        // Not just the class: the CONTENT the frame exists to carry. Before this, a post edited in the
        // visual editor shipped with no <h1> and no author line at all.
        expect(puck).toContain('A post with two bodies');
        expect(puck).toContain('Ada');
    });

    it('emits NO inline <script> — the page-id global travels as a client effect', () => {
        // The inline script executed only during document parse: after a soft navigation React
        // inserts but never runs it, so window.__WJS_PAGE_ID kept the PREVIOUS page's id and a form
        // submission was stamped against the wrong page. PageId.tsx (an effect keyed on the id) is
        // the fix; this pins the script's absence so the bug cannot come back quietly.
        expect(classic).not.toContain('<script');
        expect(puck).not.toContain('<script');
    });

    it('leaves a PAGE alone — the frame is the POST frame', () => {
        const page = render({ ...basePost, type: 'page' } as unknown as Post);
        expect(emits(page, 'wjs-post')).toBe(false);
        expect(page).toContain('classic body');
    });

    it("leaves a CUSTOM post type alone too — we do not own a plugin's content type", () => {
        // The branch used to be "anything that is not a page", so every CPT a plugin registers had a
        // title, a date and a byline prepended to content whose presentation the plugin owns —
        // duplicating a heading its own blocks may already draw. The allowlist matches the one this
        // component already applies to comments (`type === 'post'`).
        for (const type of ['wjs_symbol', 'product', 'event', 'attachment']) {
            const cpt = render({ ...basePost, type } as unknown as Post);
            expect(emits(cpt, 'wjs-post'), type).toBe(false);
            expect(emits(cpt, 'wjs-post-header'), type).toBe(false);
            expect(emits(cpt, 'wjs-post-meta'), type).toBe(false);
            // …and its content still renders: no frame is not the same as no page.
            expect(cpt, type).toContain('classic body');
        }
        // The body hook survives on every type, so `singlePost.body` never stops matching.
        expect(emits(render({ ...basePost, type: 'product' } as unknown as Post), 'wjs-post-body')).toBe(true);
    });
});
