import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * The token manifest (backend/public/theme-tokens.json) tells theme authors which elements they may
 * style: `styles.header` compiles to a rule on `.wjs-header`, `styles.nav` to `.wjs-header-nav`, and
 * so on. Those chrome selectors are SEEDED in the generator, not scraped from a stylesheet — nothing
 * verified that the React chrome ever emitted them.
 *
 * It didn't. `.wjs-header` was in the manifest, offered by the doctor, accepted by the compiler and
 * matched by nothing: every theme that declared a header style got a rule that silently applied to
 * zero elements. The child hooks (-logo, -nav, -container) were emitted all along, which is what made
 * the gap so easy to miss.
 *
 * So: every chrome selector the manifest promises must exist as a class in the chrome source. This is
 * a promise-vs-markup test, deliberately grep-shaped — a DOM test would only cover the one code path
 * it renders, and the header alone has three variants plus the composed slot.
 */

const REPO = path.resolve(__dirname, '../../../..');
const MANIFEST = path.join(REPO, 'backend/public/theme-tokens.json');
const GENERATOR = path.join(REPO, 'scripts/generate-token-manifest.js');

/**
 * The generator's OWN seed table, required (not re-typed) so the coverage check below cannot drift
 * from it. The script is CommonJS and lives outside the frontend package, hence createRequire; it
 * exports the table behind a `require.main === module` guard, so this import writes nothing.
 */
type Seed = string | { selector: string; children?: Record<string, { selector: string }> };
const { CHROME_ELEMENT_SEEDS, BLOCK_ELEMENT_CHILD_SEEDS } = createRequire(GENERATOR)(GENERATOR) as {
    CHROME_ELEMENT_SEEDS: Record<string, Seed>;
    BLOCK_ELEMENT_CHILD_SEEDS: Record<string, Record<string, { selector: string }>>;
};

// Where chrome markup can legitimately live. The composed header/footer wrapper is in the public
// layout; the per-block classes are in components/chrome; the default chrome is in components/public.
const SOURCE_DIRS = [
    'frontend/src/components/chrome',
    'frontend/src/components/public',
    'frontend/src/app/(public)',
];

// Individual public-surface components that live OUTSIDE those trees. Listed one by one rather than
// widening the walk to all of frontend/src/components: that directory is mostly ADMIN markup, and a
// selector "found" in the admin UI would be a false pass — the manifest only promises public surfaces.
const SOURCE_FILES = [
    'frontend/src/components/CommentsSection.tsx',
];

/**
 * Comments are NOT markup. A selector named only in a code comment — `wjs-content`, say, written
 * while explaining why a class was not added — satisfied the grep below and let the manifest promise
 * a selector that matches zero elements. That is the precise failure this file exists to catch, so
 * comments come out before anything is searched.
 *
 * Deliberately naive: this strips `//…`, `/*…*` + `/` and nothing else. It can mangle a `//` inside a
 * string literal, which for THIS test only risks a false FAILURE (a class that is emitted looking
 * absent) — never a false pass. Erring that way round is the whole point.
 */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function readSources(): string {
    const out: string[] = [];
    const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            // TESTS ARE NOT MARKUP. A test file that asserts `wjs-post` is emitted lives inside these
            // same directories, so walking it let the suite satisfy its own promise: delete the class
            // from the component and this check still found the name — in the test that was checking
            // for it. Same class of false pass as the code comments stripped below, one level up.
            if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); }
            else if (/\.tsx?$/.test(e.name)) out.push(stripComments(fs.readFileSync(p, 'utf8')));
        }
    };
    for (const d of SOURCE_DIRS) walk(path.join(REPO, d));
    for (const f of SOURCE_FILES) {
        const p = path.join(REPO, f);
        // A listed file that has moved would silently stop being scanned, so fail loudly instead.
        if (!fs.existsSync(p)) throw new Error(`SOURCE_FILES entry does not exist: ${f}`);
        out.push(stripComments(fs.readFileSync(p, 'utf8')));
    }
    return out.join('\n');
}

describe('chrome selector contract', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const sources = readSources();

    // Only the .wjs-* chrome entries: the .wp-block-* ones come from wordjs-ui.css, which the
    // generator scrapes — those cannot be promised without existing. `footer` is a bare tag name.
    // CHILDREN ARE CHECKED TOO. This used to read only each element's own `selector`, which left the
    // named composites — chromeFooter.socialLink, chromeHeader.logoText, … — promised to theme authors
    // and verified by nothing. That is the same gap this file was written to close, one level down.
    //
    // And a chrome selector is no longer necessarily a single class: a composite like
    // `.wjs-chrome-footer .wjs-chrome-row > .wjs-chrome-text` scopes a part to its container, so the
    // check is per CLASS TOKEN. (The previous version did `selector.slice(1)` and searched the whole
    // string as one class name, which silently failed the moment a compound selector appeared.)
    const chromeSelectors: (readonly [string, string])[] = [];
    for (const [name, def] of Object.entries(manifest.elements as Record<string, { selector: string; children?: Record<string, { selector: string }> }>)) {
        // PLUGIN surfaces (`plugin:<slug>:<element>`, selector `.wjs-p-<slug>-*`) are NOT chrome. Their
        // markup lives in a plugin's own bundle, not the chrome source dirs walked below, and their
        // promise-vs-markup contract is proven at equal strength by pluginSelectorContract.test.ts.
        // Skipping them here is scoping, not weakening — chrome coverage is unchanged.
        if (name.startsWith('plugin:')) continue;
        if (def.selector && def.selector.startsWith('.wjs-')) chromeSelectors.push([name, def.selector] as const);
        for (const [child, cd] of Object.entries(def.children || {})) {
            if (cd.selector && cd.selector.includes('.wjs-')) chromeSelectors.push([`${name}.${child}`, cd.selector] as const);
        }
    }

    it('has chrome entries to check (guards against an empty-filter false pass)', () => {
        expect(chromeSelectors.length).toBeGreaterThanOrEqual(3);
        // The composites must be in scope, or this file is back to checking only the easy half.
        expect(chromeSelectors.some(([n]) => n.includes('.'))).toBe(true);
    });

    // ── Nothing may vanish silently ───────────────────────────────────────────────────────────────
    //
    // The it.each below only checks the selectors it is HANDED. Delete a seed and the manifest loses
    // an element, the list gets shorter, and the suite still passes green — a test that passes without
    // checking, which is precisely the failure this file exists to prevent. This used to be guarded by
    // a hand-copied list of 17 required keys while the manifest carried 108, so 91 of them could be
    // deleted in silence.
    //
    // Two layers, because they fail on different mistakes:
    //   1. DERIVED from the generator's seed table — catches a manifest that no longer matches the
    //      seeds (a stale regeneration, or a seed silently dropped because a .wp-block-* registration
    //      took its key: the generator skips those on purpose, and skipping one must be loud).
    //   2. FROZEN snapshot of the whole set — catches deleting the seed AND regenerating, where layer
    //      1 agrees with itself. A reviewer has to update this list on purpose.

    it('contains every element the generator seeds, with the same selector', () => {
        const seeds = Object.entries(CHROME_ELEMENT_SEEDS);
        expect(seeds.length, 'the generator exported no seeds — this check would be vacuous').toBeGreaterThan(10);
        const elements = manifest.elements as Record<string, { selector: string; children?: Record<string, { selector: string }> }>;
        for (const [key, seed] of seeds) {
            const want = typeof seed === 'string' ? { selector: seed, children: undefined } : seed;
            const got = elements[key];
            expect(got, `manifest element "${key}" is missing — the generator seeds it`).toBeTruthy();
            expect(got.selector, `manifest element "${key}" does not carry its seeded selector (a .wp-block-* registration would have displaced the seed silently)`)
                .toBe(want.selector);
            for (const [child, cd] of Object.entries(want.children || {})) {
                expect(got.children?.[child]?.selector, `manifest element "${key}.${child}" is missing or renamed`).toBe(cd.selector);
            }
        }
    });

    it('matches the frozen chrome-selector snapshot (update deliberately, never to make CI green)', () => {
        const actual = chromeSelectors.map(([n, s]) => `${n} -> ${s}`).sort();
        // Adding a hook: add its line. REMOVING one: that is a promise being withdrawn from every
        // theme that styles it — say so in the commit message, then delete the line.
        const frozen = `
chromeFooter -> .wjs-chrome-footer
chromeFooter.button -> .wjs-chrome-footer .wjs-chrome-button
chromeFooter.container -> .wjs-chrome-footer .wjs-footer-container
chromeFooter.containerRow -> .wjs-chrome-footer .wjs-footer-container > .wjs-chrome-row
chromeFooter.containerRowAfterFirst -> .wjs-chrome-footer > .wjs-footer-container > .wjs-chrome-row + .wjs-chrome-row
chromeFooter.containerRowNested -> .wjs-chrome-footer .wjs-footer-container > .wjs-chrome-row > .wjs-chrome-row
chromeFooter.nav -> .wjs-chrome-footer .wjs-chrome-nav
chromeFooter.navHorizontal -> .wjs-chrome-footer .wjs-chrome-nav-horizontal
chromeFooter.navLink -> .wjs-chrome-footer .wjs-chrome-nav a
chromeFooter.navVertical -> .wjs-chrome-footer .wjs-chrome-nav-vertical
chromeFooter.row -> .wjs-chrome-footer .wjs-chrome-row
chromeFooter.rowChild -> .wjs-chrome-footer .wjs-chrome-row > .wjs-chrome-row
chromeFooter.rowNested -> .wjs-chrome-footer .wjs-chrome-row .wjs-chrome-row
chromeFooter.rowNestedText -> .wjs-chrome-footer .wjs-chrome-row .wjs-chrome-row > .wjs-chrome-text
chromeFooter.search -> .wjs-chrome-footer .wjs-chrome-search
chromeFooter.searchInput -> .wjs-chrome-footer .wjs-chrome-search input
chromeFooter.siteTitle -> .wjs-chrome-footer .wjs-chrome-site-title
chromeFooter.siteTitleLink -> .wjs-chrome-footer .wjs-chrome-site-title a
chromeFooter.siteTitleText -> .wjs-chrome-footer .wjs-chrome-site-title span
chromeFooter.socialLink -> .wjs-chrome-footer .wjs-chrome-socials a
chromeFooter.socials -> .wjs-chrome-footer .wjs-chrome-socials
chromeFooter.spacer -> .wjs-chrome-footer .wjs-chrome-spacer
chromeFooter.text -> .wjs-chrome-footer .wjs-chrome-text
chromeHeader -> .wjs-chrome-header
chromeHeader.actionButton -> .wjs-chrome-header .wjs-header-actions button
chromeHeader.actions -> .wjs-chrome-header .wjs-header-actions
chromeHeader.button -> .wjs-chrome-header .wjs-chrome-button
chromeHeader.container -> .wjs-chrome-header .wjs-header-container
chromeHeader.logo -> .wjs-chrome-header .wjs-header-logo
chromeHeader.logoText -> .wjs-chrome-header .wjs-header-logo span
chromeHeader.mobilePanel -> .wjs-header-mobile-panel
chromeHeader.mobilePanelLink -> .wjs-header-mobile-panel nav a
chromeHeader.nav -> .wjs-chrome-header .wjs-chrome-nav
chromeHeader.navHorizontal -> .wjs-chrome-header .wjs-chrome-nav-horizontal
chromeHeader.navLink -> .wjs-chrome-header .wjs-header-nav a
chromeHeader.navVertical -> .wjs-chrome-header .wjs-chrome-nav-vertical
chromeHeader.row -> .wjs-chrome-header .wjs-chrome-row
chromeHeader.rowNested -> .wjs-chrome-header .wjs-chrome-row .wjs-chrome-row
chromeHeader.search -> .wjs-chrome-header .wjs-chrome-search
chromeHeader.searchInput -> .wjs-chrome-header .wjs-chrome-search input
chromeHeader.siteTitle -> .wjs-chrome-header .wjs-chrome-site-title
chromeHeader.siteTitleLink -> .wjs-chrome-header .wjs-chrome-site-title a
chromeHeader.siteTitleText -> .wjs-chrome-header .wjs-chrome-site-title span
chromeHeader.socialLink -> .wjs-chrome-header .wjs-chrome-socials a
chromeHeader.socials -> .wjs-chrome-header .wjs-chrome-socials
chromeHeader.spacer -> .wjs-chrome-header .wjs-chrome-spacer
chromeHeader.text -> .wjs-chrome-header .wjs-chrome-text
chromeSearch -> .wjs-chrome-search
chromeSearch.input -> .wjs-chrome-search input
comment -> .wjs-comment
comment.author -> .wjs-comment-author
comment.avatar -> .wjs-comment-avatar
comment.avatarImage -> .wjs-comment-avatar img
comment.body -> .wjs-comment-body
comment.content -> .wjs-comment-content
comment.date -> .wjs-comment-date
comment.head -> .wjs-comment-head
comments -> .wjs-comments
comments.empty -> .wjs-comments-empty
comments.field -> .wjs-comment-field
comments.form -> .wjs-comment-form
comments.formTitle -> .wjs-comment-form-title
comments.list -> .wjs-comment-list
comments.submit -> .wjs-comment-submit
comments.title -> .wjs-comments-title
header -> .wjs-header
header.actionButton -> .wjs-header-actions button
headerNav -> .wjs-chrome-header .wjs-header-nav
logo -> .wjs-header-logo
logo.text -> .wjs-header-logo span
nav -> .wjs-header-nav
nav.link -> .wjs-header-nav a
postCard -> .wjs-post-card
postCard.badge -> .wjs-post-card-badge
postCard.body -> .wjs-post-card-body
postCard.excerpt -> .wjs-post-card-excerpt
postCard.meta -> .wjs-post-card-meta
postCard.more -> .wjs-post-card-more
postCard.title -> .wjs-post-card-title
postCard.titleLink -> .wjs-post-card-link
postList -> .wjs-post-list
postList.empty -> .wjs-post-list-empty
postList.header -> .wjs-post-list-header
postList.title -> .wjs-post-list-title
postMeta -> .wjs-post-meta
postMeta.author -> .wjs-post-meta-author
postMeta.category -> .wjs-post-meta-category
postMeta.date -> .wjs-post-meta-date
searchForm -> .wjs-search-form
searchForm.input -> .wjs-search-form input
searchForm.submit -> .wjs-search-form button
searchPage -> .wjs-search-page
searchPage.empty -> .wjs-search-empty
searchPage.header -> .wjs-search-header
searchPage.summary -> .wjs-search-summary
searchPage.title -> .wjs-search-title
searchResult -> .wjs-search-result
searchResult.badge -> .wjs-search-result-badge
searchResult.excerpt -> .wjs-search-result-excerpt
searchResult.meta -> .wjs-search-result-meta
searchResult.more -> .wjs-search-result-more
searchResult.title -> .wjs-search-result-title
searchResult.titleLink -> .wjs-search-result-link
searchResults -> .wjs-search-results
singlePost -> .wjs-post
singlePost.body -> .wjs-post-body
singlePost.header -> .wjs-post-header
singlePost.title -> .wjs-post-title
`.trim().split('\n').map((l) => l.trim());

        expect(actual).toEqual(frozen);
    });

    // ── .wp-block-* CHILD SEEDS (WAVE 1a) ─────────────────────────────────────────────────────────
    //
    // The scraped .wp-block-* entries "cannot be promised without existing" because they come from
    // ui.css — but the SEEDED block children (states, variant modifiers, unstyled parts, per-level
    // heading compounds) exist only in the generator's table, so they get the same two layers the
    // chrome seeds get. Markup existence is proven separately, AT RENDER TIME, by
    // frontend/src/components/content/__tests__/blockChildSeeds.test.tsx — a grep cannot see
    // template-built classes like `card-theme-${theme}`, so no grep layer is attempted here.

    it('contains every seeded .wp-block-* child, with the same selector', () => {
        const seeds = Object.entries(BLOCK_ELEMENT_CHILD_SEEDS);
        expect(seeds.length, 'the generator exported no block-child seeds — this check would be vacuous').toBeGreaterThan(5);
        const elements = manifest.elements as Record<string, { selector: string; children?: Record<string, { selector: string }> }>;
        for (const [base, kids] of seeds) {
            expect(elements[base], `manifest element "${base}" is missing — its child seeds have nowhere to land`).toBeTruthy();
            for (const [child, cd] of Object.entries(kids)) {
                expect(elements[base].children?.[child]?.selector,
                    `manifest child "${base}.${child}" is missing or does not carry its seeded selector (a scraped ui.css child would have displaced the seed silently)`)
                    .toBe(cd.selector);
            }
        }
    });

    it('matches the frozen block-child snapshot (update deliberately, never to make CI green)', () => {
        const actual = Object.entries(BLOCK_ELEMENT_CHILD_SEEDS)
            .flatMap(([base, kids]) => Object.entries(kids).map(([child, cd]) => `${base}.${child} -> ${cd.selector}`))
            .sort();
        // Same contract as the chrome snapshot above: removing a line is withdrawing a promise from
        // every theme that styles it — say so in the commit message.
        const frozen = `
accordion.iconOpen -> .wp-block-accordion__item.is-open .wp-block-accordion__icon
accordion.itemOpen -> .wp-block-accordion__item.is-open
audio-player.body -> .wp-block-audio-player__body
audio-player.scrolling -> .wp-block-audio-player__track.is-scrolling
button.linkOutline -> .wp-block-button__link.button-variant-outline
button.linkPrimary -> .wp-block-button__link.button-variant-primary
button.linkSecondary -> .wp-block-button__link.button-variant-secondary
card.themeAccent -> .wp-block-card.card-theme-accent
card.themeDark -> .wp-block-card.card-theme-dark
card.themeLight -> .wp-block-card.card-theme-light
category-posts.grid -> .wp-block-category-posts--grid
category-posts.list -> .wp-block-category-posts__list
cta-banner.variantDark -> .wp-block-cta-banner.cta-variant-dark
cta-banner.variantGradient -> .wp-block-cta-banner.cta-variant-gradient
cta-banner.variantPrimary -> .wp-block-cta-banner.cta-variant-primary
divider.dashed -> .wp-block-divider--dashed
divider.gradient -> .wp-block-divider--gradient
divider.solid -> .wp-block-divider--solid
heading.h1 -> h1.wp-block-heading
heading.h2 -> h2.wp-block-heading
heading.h3 -> h3.wp-block-heading
heading.h4 -> h4.wp-block-heading
heading.h5 -> h5.wp-block-heading
heading.h6 -> h6.wp-block-heading
hero.buttonOutline -> .wp-block-hero__button--outline
pricing.planHighlighted -> .wp-block-pricing__plan--highlighted
quote.bar -> .wp-block-quote--bar
quote.body -> .wp-block-quote__body
quote.large -> .wp-block-quote--large
table.cell -> .wp-block-table__table td
table.head -> .wp-block-table__table th
table.striped -> .wp-block-table--striped
tabs.tabActive -> .wp-block-tabs__tab.is-active
testimonial.avatarInitials -> .wp-block-testimonial__avatar--initials
video-embed.frame -> .wp-block-video-embed iframe, .wp-block-video-embed video
video-embed.playing -> .wp-block-video-embed.is-playing
`.trim().split('\n').map((l) => l.trim());

        expect(actual).toEqual(frozen);
    });

    it.each(chromeSelectors)('%s → %s is emitted by the chrome markup', (_name, selector) => {
        // Every .wjs-* class the selector names must exist in the chrome source. Bare tags (a, span,
        // input, button, nav) and combinators are structure, not promises — the framework's own markup
        // decides those, and a tag is not something a grep can meaningfully confirm.
        const classes = selector.match(/\.wjs-[a-z0-9-]+/gi) || [];
        expect(classes.length).toBeGreaterThan(0);
        for (const cls of classes) {
            const className = cls.slice(1);
            // Word-boundary match so `.wjs-header` is not "found" inside `wjs-header-logo`.
            const re = new RegExp(`(^|[\\s"'\`])${className}([\\s"'\`$]|$)`, 'm');
            expect(re.test(sources), `${className} is promised by the manifest but never emitted`).toBe(true);
        }
    });
});
