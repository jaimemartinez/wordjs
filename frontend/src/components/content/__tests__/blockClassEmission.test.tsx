import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import {
    HeadingBlock, TextBlock, ImageBlock, DividerBlock, ButtonBlock, SectionBlock, GridBlock,
    ColumnsBlock, CardBlock, QuoteBlock, TableBlock, HeroBlock, SpacerBlock,
} from '../blocks';
import AccordionBlock from '../AccordionBlock';
import TabsBlock from '../TabsBlock';
import { bc, BLOCK_CLASS_PREFIX, LEGACY_BLOCK_CLASS_PREFIX } from '@/components/blocks/blockVars';
import { serializeContentFallback } from '@/lib/verso/contentFallback';

/**
 * THE BLOCK-CLASS IDENTITY CONTRACT — both classes on every block element, WordJS's own FIRST.
 *
 * WordJS emits `class="wjs-block-heading wp-block-heading"`. The own class is the identity and the
 * source of the framework stylesheet; the `wp-block-*` one is a DEPRECATED compatibility alias kept
 * so themes already installed and content already saved (including everything a WXR import brings
 * from WordPress) keep rendering. See documentation/block-class-identity.md.
 *
 * Two properties are proven here, and the second is the one that keeps this from rotting:
 *
 *   1. AT RENDER TIME — every rendered block element that carries a `wp-block-x` class also carries
 *      `wjs-block-x`, immediately BEFORE it. Order is part of the contract, not cosmetics: it is what
 *      makes the own class the one an author reads first and the one that survives the removal.
 *
 *   2. IN THE SOURCE — no block component spells a `wp-block-*` literal. The classes used to be typed
 *      inline in 233 places across eight components; "remember to emit both, own first" would have
 *      been a convention, and a convention is what the next person adding a block forgets. `bc()` in
 *      components/blocks/blockVars.ts is the single point that builds a block class name, and this
 *      test fails the build the moment a literal reappears outside it.
 */

const REPO = path.resolve(__dirname, '../../../../..');

/**
 * The historical NON-BEM aliases of the card block: emitted alongside the real `__` parts purely so
 * the very first themes (which matched `.wp-block-card-icon`) keep working. Nothing in the framework
 * stylesheet styles them, so they name no real surface and get NO own-identity twin — inventing
 * `.wjs-block-card-icon` would mint a new name for something already deprecated. They are listed here
 * one by one, with this reason, rather than by a pattern that would quietly excuse future literals.
 */
const LEGACY_LITERAL_ALLOWLIST = new Set([
    'wp-block-card-icon',
    'wp-block-card-title',
    'wp-block-card-description',
]);

/** Comments are not markup — a class named in prose must not satisfy (or trip) the scan. */
const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** Every source file that renders block markup, discovered rather than listed (a new block is covered). */
function blockMarkupSources(): string[] {
    const dirs = ['frontend/src/components/content', 'frontend/src/components/blocks'];
    const out: string[] = [];
    for (const dir of dirs) {
        const abs = path.join(REPO, dir);
        if (!fs.existsSync(abs)) continue;
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
            if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
            // blockVars.ts IS the single point — it is the one place allowed to know the prefixes.
            if (entry.name === 'blockVars.ts') continue;
            out.push(`${dir}/${entry.name}`); // repo-relative, forward slashes on every platform
        }
    }
    out.push('frontend/src/lib/verso/contentFallback.ts'); // the legacy `content` serializer
    return out;
}

describe('bc() — the single point that builds a block class name', () => {
    it('emits the own identity first and the historical alias second', () => {
        expect(bc('heading')).toBe('wjs-block-heading wp-block-heading');
        expect(BLOCK_CLASS_PREFIX).toBe('wjs-block-');
        expect(LEGACY_BLOCK_CLASS_PREFIX).toBe('wp-block-');
    });

    it('pairs each name it is given, and drops falsy ones', () => {
        expect(bc('divider', 'divider--gradient'))
            .toBe('wjs-block-divider wp-block-divider wjs-block-divider--gradient wp-block-divider--gradient');
        expect(bc('table', false && 'table--striped')).toBe('wjs-block-table wp-block-table');
    });

    // Forgiving in the safe direction only: a name that already carries either prefix is normalized,
    // never double-prefixed into the dead class `wjs-block-wp-block-heading`.
    it('normalizes an already-prefixed name instead of stacking prefixes', () => {
        expect(bc('wp-block-heading')).toBe(bc('heading'));
        expect(bc('wjs-block-heading')).toBe(bc('heading'));
    });
});

describe('rendered block markup carries both classes, own first', () => {
    // A page's worth of blocks: containers, leaves, client islands, and the legacy `content` fallback.
    const samples: [string, string][] = [
        ['heading', renderToStaticMarkup(<HeadingBlock title="H" level="h2" />)],
        ['text', renderToStaticMarkup(<TextBlock content="<p>x</p>" />)],
        ['image', renderToStaticMarkup(<ImageBlock src="/u/a.png" alt="a" />)],
        ['divider', renderToStaticMarkup(<DividerBlock type="gradient" />)],
        ['divider-hr', renderToStaticMarkup(<DividerBlock type="dashed" />)],
        ['button', renderToStaticMarkup(<ButtonBlock label="Go" href="#" variant="primary" />)],
        ['section', renderToStaticMarkup(<SectionBlock slot={() => null} />)],
        ['grid', renderToStaticMarkup(<GridBlock slot={(c?: string) => <div className={c} />} />)],
        ['columns', renderToStaticMarkup(<ColumnsBlock slots={[() => null, () => null]} />)],
        ['card', renderToStaticMarkup(<CardBlock title="T" description="D" theme="dark" icon="fa-star" />)],
        ['quote', renderToStaticMarkup(<QuoteBlock text="Q" cite="C" style="large" />)],
        ['table', renderToStaticMarkup(<TableBlock header="A|B" rows={[{ cells: '1|2' }]} striped="true" />)],
        ['hero', renderToStaticMarkup(<HeroBlock title="T" subtitle="S" buttons={[{ label: 'B', href: '#' }]} />)],
        ['spacer', renderToStaticMarkup(<SpacerBlock height={24} />)],
        ['accordion', renderToStaticMarkup(<AccordionBlock items={[{ title: 'a', content: 'A' }]} />)],
        ['tabs', renderToStaticMarkup(<TabsBlock tabs={[{ label: 'a', content: 'A' }]} />)],
        ['content-fallback', serializeContentFallback([
            { type: 'Heading', props: { level: 'h2', title: 'H' } },
            { type: 'Text', props: { content: '<p>x</p>' } },
            { type: 'Image', props: { src: '/u/a.png', alt: 'a' } },
            { type: 'Button', props: { href: '#', label: 'Go', variant: 'primary', align: 'left' } },
            { type: 'Card', props: { theme: 'dark', title: 'T', description: 'D' } },
            { type: 'Divider', props: { type: 'solid' } },
        ])],
    ];

    it.each(samples)('%s', (_name, html) => {
        const classAttrs = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);
        expect(classAttrs.length, 'the sample rendered no class attribute at all').toBeGreaterThan(0);
        let checked = 0;
        for (const attr of classAttrs) {
            const tokens = attr.split(/\s+/).filter(Boolean);
            tokens.forEach((token, i) => {
                if (!token.startsWith(LEGACY_BLOCK_CLASS_PREFIX)) return;
                if (LEGACY_LITERAL_ALLOWLIST.has(token)) return;
                const own = BLOCK_CLASS_PREFIX + token.slice(LEGACY_BLOCK_CLASS_PREFIX.length);
                expect(tokens[i - 1], `class="${attr}" — "${token}" must be preceded by "${own}"`).toBe(own);
                checked++;
            });
        }
        expect(checked, 'no block class in this sample — the render matrix stopped exercising it').toBeGreaterThan(0);
    });

    // The inverse: an own class must never appear ALONE while the alias window is open, or a theme
    // written against `.wp-block-*` would silently stop matching that element.
    it('never emits the own class without its alias', () => {
        for (const [name, html] of samples) {
            for (const m of html.matchAll(/class="([^"]*)"/g)) {
                const tokens = m[1].split(/\s+/).filter(Boolean);
                tokens.forEach((token, i) => {
                    if (!token.startsWith(BLOCK_CLASS_PREFIX)) return;
                    const alias = LEGACY_BLOCK_CLASS_PREFIX + token.slice(BLOCK_CLASS_PREFIX.length);
                    expect(tokens[i + 1], `${name}: class="${m[1]}" — "${token}" must be followed by "${alias}"`).toBe(alias);
                });
            }
        }
    });
});

describe('no block component spells a block class by hand', () => {
    const files = blockMarkupSources();

    it('finds the block sources (guards an empty-sweep false pass)', () => {
        expect(files.length).toBeGreaterThan(5);
        expect(files).toContain('frontend/src/components/content/blocks.tsx');
    });

    it.each(files)('%s routes every block class through bc()', (rel) => {
        const src = stripComments(fs.readFileSync(path.join(REPO, rel), 'utf8'));
        const offenders = [...src.matchAll(/wp-block-[A-Za-z0-9_-]+/g)]
            .map((m) => m[0])
            .filter((cls) => !LEGACY_LITERAL_ALLOWLIST.has(cls));
        expect(offenders,
            `${rel} spells block classes inline. Use bc('${offenders[0]?.replace('wp-block-', '') ?? 'name'}') — it emits the own class and the alias, in order. See components/blocks/blockVars.ts.`)
            .toEqual([]);
    });
});
