/**
 * #24, EMISSION HALF — `props.css` on its way OUT, for the pages that were saved BEFORE the guard.
 *
 * The write boundary (backend/src/core/sanitize-meta.ts, pinned by blockStyleInjection.test.tsx)
 * cleans `_puck_data` on save. That protects nothing that is already on disk: every page published
 * before it landed still carries whatever `props.css` the author typed, and the renderer used to
 * spread it into the style attribute untouched —
 *
 *     style={{ ...blockVars('card', { … }), ...css }}
 *
 * with React escaping `<` and `&` in a style VALUE but NOT `;`. So one stored `color` field turned
 * into `position:fixed;inset:0;z-index:2147483647` plus a remote background beacon: a full-screen
 * overlay served from the site's own origin. Defence in depth is the whole point here — this suite
 * ASSUMES the stored data is dirty, because for existing installs it is.
 *
 * HOW IT ASSERTS, and why not by grepping for `position:fixed`. Grep only catches the payload
 * somebody thought of, and several blocks legitimately write `position`/`inset`/`pointer-events`
 * themselves, so a marker scan is both too weak and too noisy. The assertion is DIFFERENTIAL:
 * every block is rendered twice, once with the hostile `css` and once with only the part of it an
 * author was actually allowed to choose, and the two documents must be byte-identical. That proves
 * both halves at once — nothing hostile survived, and nothing legitimate was dropped — for whatever
 * payload is put in, without the test having to know what each block emits on its own.
 *
 * WHAT IS PINNED, and why none of it is a fixture:
 *  1. THE REAL COMPONENTS, through `renderToStaticMarkup`. The defect lived in the step between the
 *     props object and the `style` attribute, so an assertion about an intermediate object would
 *     have proven nothing. Every block that accepts `css` is here — including the empty / `isEditing`
 *     branches, which are separate `style={css}` sites and the easiest ones to miss.
 *  2. THE TWO HAND-ROLLED `url()` TWINS (PostsGrid's thumbnail variable, SiteLogo's max-height),
 *     which built a style value by string interpolation instead of through the shared normalizer.
 *  3. THE SOURCE. A block added tomorrow that spells `...css` instead of `...safeCss(css)` fails
 *     here, the same way blockClassEmission.test.tsx guards `bc()`. The convention is the thing that
 *     rots; the gate is what survives.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import * as Blocks from '../blocks';
import AccordionBlock from '../AccordionBlock';
import TabsBlock from '../TabsBlock';
import SearchBarBlock from '../SearchBarBlock';
import BackToTop from '../BackToTop';

/**
 * The audit's payload, spread across the shapes it actually arrives in: a hostile VALUE on a
 * legitimate property (`color`), hostile PROPERTIES the CSS control cannot even produce
 * (`position`/`inset`/`zIndex`/`pointerEvents`), and a `backgroundImage` whose URL closes its own
 * `url()` token so that everything after it becomes declarations.
 */
const OVERLAY = 'red;position:fixed;inset:0;z-index:2147483647;background:#fff url(https://attacker.example/x.png) center/contain no-repeat';

/** The one declaration in the payload an author was entitled to make. */
const LEGITIMATE = { padding: '12px' } as React.CSSProperties;

const HOSTILE_CSS = {
    ...LEGITIMATE,
    color: OVERLAY,
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    pointerEvents: 'auto',
    backgroundImage: 'url(x.png) ;position:fixed;inset:0;background:url(https://attacker.example/y',
} as React.CSSProperties;

const IDENTITY = { blogname: 'Acme Co', siteLogo: '/media/logo.png' };
// The resolved shapes these dynamic blocks actually receive (flat menu array; translation group).
const MENU = [{ id: 1, title: 'A', url: '/a' }];
const TRANSLATIONS = { language: 'es', currentHref: '/es', items: [{ language: 'en', href: '/en' }] };
const slot = (className?: string) => <div className={className}>slot</div>;

/**
 * Every block that takes a `css` prop, as a factory over the css object so the same block can be
 * rendered twice with only that one input changed. Two entries per block where the empty / editing
 * branch is a SEPARATE style site (NavMenu, MegaMenu, SiteLogo, Breadcrumbs, LangSwitcher, ToC,
 * PostsGrid): those branches carry their own `style={css}` and were the ones a hand sweep of ~45
 * call sites could most easily have skipped.
 */
const CASES: Array<[string, (css: React.CSSProperties) => React.ReactElement]> = [
    ['AudioPlayer', (css) => <Blocks.AudioPlayerBlock src="/uploads/a.mp3" title="A" css={css} />],
    ['ParticleField', (css) => <Blocks.ParticleFieldBlock count={10} color="#fff" css={css} />],
    ['NavMenu (empty)', (css) => <Blocks.NavMenuBlock css={css} isEditing />],
    ['NavMenu', (css) => <Blocks.NavMenuBlock menu={MENU} css={css} />],
    ['MegaMenu (empty)', (css) => <Blocks.MegaMenuBlock css={css} isEditing />],
    ['MegaMenu', (css) => <Blocks.MegaMenuBlock menu={MENU} css={css} />],
    ['SiteLogo (empty)', (css) => <Blocks.SiteLogoBlock css={css} isEditing />],
    ['SiteLogo', (css) => <Blocks.SiteLogoBlock identity={IDENTITY} css={css} />],
    ['OffCanvas', (css) => <Blocks.OffCanvasBlock css={css} isEditing />],
    ['Breadcrumbs (preview)', (css) => <Blocks.BreadcrumbsBlock css={css} isEditing />],
    ['Breadcrumbs', (css) => <Blocks.BreadcrumbsBlock resolvedTrail={[{ title: 'A', href: '/a' }]} css={css} />],
    ['LangSwitcher (empty)', (css) => <Blocks.LangSwitcherBlock css={css} isEditing />],
    ['LangSwitcher', (css) => <Blocks.LangSwitcherBlock resolvedTranslations={TRANSLATIONS} css={css} />],
    ['ToC (empty)', (css) => <Blocks.TableOfContentsBlock css={css} isEditing />],
    ['ToC', (css) => <Blocks.TableOfContentsBlock resolvedHeadings={[{ id: 'a', title: 'A', level: 'h2' }, { id: 'b', title: 'B', level: 'h3' }]} css={css} />],
    ['Heading', (css) => <Blocks.HeadingBlock title="T" level="h2" color={OVERLAY} css={css} />],
    ['Image', (css) => <Blocks.ImageBlock src="/uploads/a.png" alt="a" css={css} />],
    ['Divider', (css) => <Blocks.DividerBlock type="solid" color={OVERLAY} css={css} />],
    ['Button', (css) => <Blocks.ButtonBlock label="B" href="/b" css={css} />],
    ['Section', (css) => <Blocks.SectionBlock bg={OVERLAY} slot={slot} css={css} />],
    ['Grid', (css) => <Blocks.GridBlock columns={2} slot={slot} css={css} />],
    ['FlexRow', (css) => <Blocks.FlexRowBlock slot={slot} css={css} />],
    ['Columns', (css) => <Blocks.ColumnsBlock distribution="1-1" slots={[slot, slot]} css={css} />],
    ['Card', (css) => <Blocks.CardBlock title="T" description="D" css={css} />],
    ['Quote', (css) => <Blocks.QuoteBlock text="Q" cite="C" color={OVERLAY} css={css} />],
    ['Table', (css) => <Blocks.TableBlock header={['H']} rows={[['R']]} stripeBg={OVERLAY} css={css} />],
    ['IconList', (css) => <Blocks.IconListBlock items={[{ icon: 'fa-star', text: 'A' }]} css={css} />],
    ['SocialLinks', (css) => <Blocks.SocialLinksBlock items={[{ icon: 'fa-x', url: '/x' }]} css={css} />],
    ['Stats', (css) => <Blocks.StatsBlock items={[{ value: '1', label: 'L' }]} css={css} />],
    ['HTMLEmbed', (css) => <Blocks.HTMLEmbedBlock html="<p>x</p>" css={css} />],
    ['PricingTable', (css) => <Blocks.PricingTableBlock plans={[{ name: 'P', price: '1' }]} css={css} />],
    ['Testimonial', (css) => <Blocks.TestimonialBlock quote="Q" author="A" css={css} />],
    ['CTABanner', (css) => <Blocks.CTABannerBlock title="T" buttonText="B" buttonLink="/b" css={css} />],
    ['VideoEmbed', (css) => <Blocks.VideoEmbedBlock url="https://www.youtube.com/watch?v=abc" css={css} />],
    ['Hero', (css) => <Blocks.HeroBlock title="T" bgImage="/uploads/h.png" css={css} />],
    ['PostsGrid (empty)', (css) => <Blocks.PostsGridBlock css={css} isEditing />],
    ['PostsGrid', (css) => <Blocks.PostsGridBlock posts={[{ id: 1, title: 'A', href: '/a', image: '/uploads/a.png' }]} css={css} />],
    ['CategoryPosts', (css) => <Blocks.CategoryPostsBlock posts={[{ id: 1, title: 'A', href: '/a' }]} css={css} />],
    ['Spacer', (css) => <Blocks.SpacerBlock height={24} css={css} />],
    ['Text', (css) => <Blocks.TextBlock content="<p>x</p>" color={OVERLAY} css={css} />],
    ['Accordion', (css) => <AccordionBlock items={[{ title: 'A', content: 'C' }]} css={css} />],
    ['Tabs', (css) => <TabsBlock tabs={[{ title: 'A', content: 'C' }]} css={css} />],
    ['SearchBar', (css) => <SearchBarBlock placeholder="P" buttonText="B" css={css} />],
    ['BackToTop', (css) => <BackToTop css={css} />],
];

describe('#24 emission — a page stored dirty still renders clean', () => {
    it.each(CASES)('%s emits exactly what the author was allowed to choose, and nothing else', (label, render) => {
        const dirty = renderToStaticMarkup(render(HOSTILE_CSS));
        const clean = renderToStaticMarkup(render(LEGITIMATE));
        expect(`${label}: ${dirty}`).toBe(`${label}: ${clean}`);
    });

    /**
     * The differential above would also pass if the guard had eaten the legitimate declaration too,
     * or if a block silently rendered nothing. This is the control that says the channel is open.
     */
    it('the legitimate half of the payload does reach the attribute', () => {
        const mute = CASES
            .filter(([, render]) => !renderToStaticMarkup(render(LEGITIMATE)).includes('padding:12px'))
            .map(([label]) => label);
        // The empty/editing branches of NavMenu and MegaMenu render their placeholder without a style
        // hook of their own, so they are the only ones exempt — everything else must carry it.
        expect(mute).toEqual([]);
    });

    it('the attacker markers never reach any document', () => {
        const leaking = CASES
            .filter(([, render]) => {
                const html = renderToStaticMarkup(render(HOSTILE_CSS));
                return html.includes('2147483647') || html.includes('attacker.example');
            })
            .map(([label]) => label);
        expect(leaking).toEqual([]);
    });

    /**
     * TWIN 1 — PostsGrid built `--wjs-posts-thumb-image: url(${post.image})` by hand. `post.image` is
     * stored data, so a `)` in it closes the token and the rest becomes declarations. Routed through
     * blockVars, whose `-image$` rule validates the URL and re-emits it QUOTED.
     */
    it('PostsGrid routes its thumbnail through the validated variable, quoted', () => {
        const bad = renderToStaticMarkup(
            <Blocks.PostsGridBlock posts={[{ id: 1, title: 'A', href: '/a', image: 'a.png) ;position:fixed;inset:0;background:url(https://attacker.example/y' }]} />,
        );
        expect(bad).not.toContain('position:fixed');
        expect(bad).not.toContain('attacker.example');
        const good = renderToStaticMarkup(
            <Blocks.PostsGridBlock posts={[{ id: 1, title: 'A', href: '/a', image: '/uploads/a.png' }]} />,
        );
        expect(good).toContain('--wjs-posts-thumb-image:url(&quot;/uploads/a.png&quot;)');
    });

    /**
     * TWIN 2 — SiteLogo's `maxHeight` reached the attribute through `unit()`, which appends `px` to a
     * bare number and passes ANYTHING ELSE through verbatim. It is the one unit() result that does
     * not go on to blockVars.
     */
    it('SiteLogo max-height is a length, not a place to hang a rule', () => {
        const bad = renderToStaticMarkup(
            <Blocks.SiteLogoBlock identity={IDENTITY} maxHeight="40px;position:fixed;inset:0;z-index:2147483647" />,
        );
        expect(bad).not.toContain('position:fixed');
        expect(bad).not.toContain('2147483647');
        const good = renderToStaticMarkup(<Blocks.SiteLogoBlock identity={IDENTITY} maxHeight={40} />);
        expect(good).toContain('max-height:40px');
    });
});

describe('#24 no regression — a legitimate css object still reaches the attribute', () => {
    const OK = {
        color: '#112233',
        padding: '12px 24px',
        fontFamily: 'Inter, sans-serif',
        backgroundImage: 'url(/uploads/bg.png)',
        borderRadius: '8px',
    } as React.CSSProperties;

    it('Card keeps every declaration the author chose', () => {
        const html = renderToStaticMarkup(<Blocks.CardBlock title="T" description="D" css={OK} />);
        expect(html).toContain('color:#112233');
        expect(html).toContain('padding:12px 24px');
        expect(html).toContain('font-family:Inter, sans-serif');
        expect(html).toContain('border-radius:8px');
        // URL-bearing property: kept, validated, and re-emitted QUOTED rather than interpolated bare.
        expect(html).toContain('background-image:url(&quot;/uploads/bg.png&quot;)');
    });

    it('the block variables a block sets itself are untouched by the filter', () => {
        const html = renderToStaticMarkup(<Blocks.TextBlock content="<p>x</p>" color="#111" size="18px" css={OK} />);
        expect(html).toContain('--wjs-text-color:#111');
        expect(html).toContain('--wjs-text-size:18px');
    });
});

/**
 * THE GATE THAT OUTLIVES THIS FIX. ~45 call sites were converted by hand; the 46th is the one that
 * matters. A raw `...css` / `style={css}` anywhere under components/content is the defect itself.
 */
describe('#24 source gate — no block spreads props.css unfiltered', () => {
    const CONTENT_DIR = path.resolve(__dirname, '..');
    // `...safeCss(css)` never contains the literal `...css`, so a plain match is the whole test.
    const RAW_SPREAD = /\.\.\.css\b|style=\{\s*css\s*\}/;

    it('every emission site goes through safeCss()', () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name !== '__tests__') walk(full);
                    continue;
                }
                if (!/\.tsx?$/.test(entry.name)) continue;
                fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
                    if (RAW_SPREAD.test(line)) offenders.push(`${path.relative(CONTENT_DIR, full)}:${i + 1}: ${line.trim()}`);
                });
            }
        };
        walk(CONTENT_DIR);
        expect(offenders).toEqual([]);
    });
});
