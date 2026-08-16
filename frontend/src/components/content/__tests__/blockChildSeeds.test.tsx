import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
    AudioPlayerBlock, HeadingBlock, DividerBlock, ButtonBlock, CardBlock, QuoteBlock, TableBlock,
    PricingTableBlock, TestimonialBlock, CTABannerBlock, VideoEmbedBlock, HeroBlock, CategoryPostsBlock,
} from '../blocks';
import AccordionBlock from '../AccordionBlock';
import TabsBlock from '../TabsBlock';

/**
 * Every SEEDED .wp-block-* child in the token manifest, proven AT RENDER TIME.
 *
 * The scraped block children come from ui.css and cannot be promised without existing; the seeded
 * ones (states, variant modifiers, unstyled parts, per-level heading compounds) exist only in the
 * generator's table, and several of their classes are template-built (`card-theme-${theme}`,
 * `button-variant-${variant}`) — invisible to the grep chromeSelectorContract runs. So this file
 * renders each block through the REAL components with props that exercise every variant, and asserts
 * each promised selector's pieces appear in the markup.
 *
 * The seed table is required from the generator (never re-typed), and the sweep below fails on any
 * seed this file does not cover — adding a seed forces adding the render that proves it.
 *
 * What "proven" means here: for each compound segment of the selector (`.a.b`, `h2.wp-block-heading`,
 * `td`), some rendered element carries that tag and ALL those classes together. Ancestry between
 * segments is not re-verified — the segments come from single component renders, so the nesting is
 * the component's own — but a class that no component emits can never pass.
 */

const REPO = path.resolve(__dirname, '../../../../..');
const GENERATOR = path.join(REPO, 'scripts/generate-token-manifest.js');
const { BLOCK_ELEMENT_CHILD_SEEDS } = createRequire(GENERATOR)(GENERATOR) as {
    BLOCK_ELEMENT_CHILD_SEEDS: Record<string, Record<string, { selector: string }>>;
};

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

/**
 * The render matrix: element key → HTML strings that together must emit every seeded child.
 * Variants are the CLOSED enums the props admit — each enum member gets its own render, so a
 * partial enum in the markup (a variant class that stopped being emitted) fails, not just the first.
 */
const RENDERS: Record<string, string[]> = {
    accordion: [
        // openIndex starts at 0, so the first item renders `.is-open` (and its icon) statically.
        render(<AccordionBlock items={[{ title: 'a', content: 'A' }, { title: 'b', content: 'B' }]} />),
    ],
    'audio-player': [render(<AudioPlayerBlock src="/media/a.mp3" title="Track" />)],
    button: ['primary', 'secondary', 'outline'].map((variant) =>
        render(<ButtonBlock label="Go" href="#" variant={variant} />)),
    card: ['light', 'dark', 'accent'].map((theme) =>
        render(<CardBlock title="T" description="D" theme={theme} />)),
    'category-posts': [
        render(<CategoryPostsBlock categorySlug="news" posts={[{ id: 1, href: '/p', title: 'P', excerpt: 'E' }]} />),
        render(<CategoryPostsBlock categorySlug="news" layout="grid" posts={[{ id: 1, href: '/p', title: 'P', excerpt: 'E' }]} />),
    ],
    'cta-banner': ['primary', 'dark', 'gradient'].map((variant) =>
        render(<CTABannerBlock title="T" subtitle="S" buttonText="B" buttonLink="#" variant={variant} />)),
    divider: ['solid', 'dashed', 'gradient'].map((type) => render(<DividerBlock type={type} />)),
    heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((level) =>
        render(<HeadingBlock title="H" level={level} />)),
    hero: [render(<HeroBlock title="T" buttons={[{ label: 'B', href: '#', variant: 'outline' }]} />)],
    pricing: [render(<PricingTableBlock plans={[{ name: 'Pro', price: '9', period: '/mo', features: 'x', highlighted: 'true', buttonText: 'Buy', buttonLink: '#' }]} />)],
    quote: [
        render(<QuoteBlock text="Q" cite="C" style="large" />),
        render(<QuoteBlock text="Q" cite="C" />), // the bar branch is the default
    ],
    table: [render(<TableBlock header="A|B" rows={[{ cells: '1|2' }]} striped="true" />)],
    tabs: [
        // activeTab starts at 0, so the first tab renders `.is-active` statically.
        render(<TabsBlock tabs={[{ label: 'a', content: 'A' }, { label: 'b', content: 'B' }]} />),
    ],
    testimonial: [render(<TestimonialBlock quote="Q" author="Ada" role="R" />)], // no avatar → initials
    'video-embed': [
        render(<VideoEmbedBlock url="/media/v.mp4" />), // self-hosted → <video>
        render(<VideoEmbedBlock url="https://www.youtube.com/watch?v=abc123" />), // embed → <iframe>
    ],
};

/**
 * The two states only an interaction can reach: `is-playing` needs a click (renderToStaticMarkup
 * cannot fire one, and there is no DOM environment here), `is-scrolling` needs a real overflow
 * measurement. For exactly these, the proof is the emitting cx() call in the component source —
 * base class and state class in the SAME call, so renaming either side fails here.
 *
 * The base class is now built by `bc('<name>')` rather than typed as a `wp-block-*` literal (block
 * elements carry BOTH classes — see components/blocks/blockVars.ts), so the pattern matches the
 * CALL. That is the same strength of proof as before: bc() is what puts the manifest's
 * `.wp-block-video-embed` on the element, so a rename on either side still fails here.
 */
const INTERACTION_ONLY: Record<string, { file: string; pattern: RegExp }> = {
    'video-embed.playing': {
        file: 'frontend/src/components/content/SelfHostedVideo.tsx',
        pattern: /cx\(\s*bc\(\s*['"]video-embed['"]\s*\)[^)]{0,120}['"]is-playing['"]/,
    },
    'audio-player.scrolling': {
        file: 'frontend/src/components/content/AudioTransport.tsx',
        pattern: /cx\(\s*bc\(\s*['"]audio-player__track['"]\s*\)[^)]{0,120}['"]is-scrolling['"]/,
    },
};

/** Parse one compound segment: optional tag + zero or more classes (`.a.b`, `h2.wp-block-heading`, `td`). */
function parseSegment(segment: string): { tag: string | null; classes: string[] } {
    const m = segment.match(/^([a-z][a-z0-9-]*)?((?:\.[A-Za-z0-9_-]+)*)$/);
    expect(m, `unparseable selector segment "${segment}" — extend parseSegment before promising it`).toBeTruthy();
    return { tag: m![1] || null, classes: (m![2].match(/\.[A-Za-z0-9_-]+/g) || []).map((c) => c.slice(1)) };
}

/** True if some element in the HTML carries the segment's tag and ALL its classes together. */
function segmentEmitted(html: string, segment: string): boolean {
    const { tag, classes } = parseSegment(segment);
    for (const m of html.matchAll(/<([a-z][a-z0-9-]*)((?:\s[^<>]*)?)>/g)) {
        if (tag && m[1] !== tag) continue;
        if (classes.length === 0) return true; // bare tag (td, iframe, video…) — presence is the promise
        const cls = m[2].match(/class="([^"]*)"/);
        const have = cls ? cls[1].split(/\s+/) : [];
        if (classes.every((c) => have.includes(c))) return true;
    }
    return false;
}

/** Every compound segment of the alternative appears in this one render. */
const alternativeEmitted = (html: string, alternative: string): boolean =>
    alternative.trim().split(/\s+/).every((seg) => segmentEmitted(html, seg));

describe('seeded .wp-block-* children are emitted by the block components', () => {
    const seeds = Object.entries(BLOCK_ELEMENT_CHILD_SEEDS);

    it('has seeds to check (guards against an empty-table false pass)', () => {
        expect(seeds.length).toBeGreaterThan(5);
    });

    const cases: [string, string][] = seeds.flatMap(([base, kids]) =>
        Object.entries(kids).map(([child, cd]) => [`${base}.${child}`, cd.selector] as [string, string]));

    it.each(cases)('%s → %s', (name, selector) => {
        const io = INTERACTION_ONLY[name];
        if (io) {
            const src = fs.readFileSync(path.join(REPO, io.file), 'utf8');
            expect(io.pattern.test(src),
                `${name}: the state class is promised by the manifest but ${io.file} no longer emits it in the same cx() call`).toBe(true);
            return;
        }
        const base = name.split('.')[0];
        const renders = RENDERS[base];
        expect(renders, `no render exercises "${base}" — add it to the RENDERS matrix, a seed may not go unproven`).toBeTruthy();
        // EVERY comma-alternative is its own promise: `iframe` matching must not excuse `video`.
        for (const alternative of selector.split(',')) {
            expect(renders!.some((html) => alternativeEmitted(html, alternative)),
                `${name}: no render emits "${alternative.trim()}" — the manifest is promising a selector the markup does not produce`).toBe(true);
        }
    });
});
