import { describe, it, expect } from 'vitest';
import { parseTemplate, templateCandidates, CONTENT_SLOT, TEMPLATE_TAGS, CLASS_TOKEN, MAX_CLASS_TOKENS } from '../templateData';

/**
 * The renderer's mirror of the page-template contract.
 *
 * The backend validator is the authority; this copy exists so the renderer never renders a tree the
 * backend would reject, without a network round-trip. Two copies of a contract only stay honest if both
 * are tested, so these assert the same properties the backend suite does — and one the backend cannot:
 * that the mirror FAILS CLOSED, returning null rather than a partial tree.
 */

const slot = { type: CONTENT_SLOT, props: {} };
const raw = (content: unknown) => JSON.stringify({ content });

describe('parseTemplate', () => {
    it('accepts a template and returns its tree', () => {
        const t = parseTemplate(raw([{ type: 'Section', props: { maxWidth: '72rem', items: [slot] } }]));
        expect(t).not.toBeNull();
        expect(t!.content[0].type).toBe('Section');
    });

    it('accepts a layout a theme could not previously express', () => {
        const t = parseTemplate(raw([{
            type: 'Section', props: {
                maxWidth: '80rem', items: [
                    { type: 'Grid', props: { columns: 2, gap: '2rem', columnsMobile: 1, items: [slot, { type: 'Spacer', props: { height: '4rem' } }] } },
                    { type: 'FlexRow', props: { justify: 'between', wrap: true, direction: 'row', items: [{ type: 'Divider', props: { color: '#eee' } }] } },
                ]
            }
        }]));
        expect(t).not.toBeNull();
    });

    // ── data never chooses structure ───────────────────────────────────────────────────────────────
    it('rejects a prop outside its enum — the shape of the XSS this contract prevents', () => {
        expect(parseTemplate(raw([{ type: 'FlexRow', props: { justify: 'script', items: [slot] } }]))).toBeNull();
    });

    it('rejects an undeclared prop rather than ignoring it', () => {
        expect(parseTemplate(raw([{ type: 'Section', props: { as: 'iframe', items: [slot] } }]))).toBeNull();
        // Including props an EARLIER draft of the contract accepted but no block honours. These
        // validated and rendered nothing, which reads to an author as a broken framework.
        expect(parseTemplate(raw([{ type: 'Grid', props: { minColumnWidth: '20rem', items: [slot] } }]))).toBeNull();
        expect(parseTemplate(raw([{ type: 'Section', props: { align: 'center', items: [slot] } }]))).toBeNull();
    });

    it('rejects a prop of the wrong primitive type', () => {
        expect(parseTemplate(raw([{ type: 'Grid', props: { columns: 'three', items: [slot] } }]))).toBeNull();
    });

    // ── the container wrapper: `tag` and `className` ───────────────────────────────────────────────
    //
    // The backend is the authority for these; the point of repeating them here is that the two must
    // agree EXACTLY. A tree this mirror accepts and the backend rejects means the renderer draws a
    // layout the doctor calls invalid — and a tree the backend accepts and this rejects means a valid
    // theme silently falls back to the default arrangement.

    it('accepts every tag in the closed set, on every container', () => {
        for (const tag of TEMPLATE_TAGS) {
            for (const type of ['Section', 'Grid', 'FlexRow', 'Columns']) {
                expect(parseTemplate(raw([{ type, props: { tag, items: [slot] } }])), `${type}/${tag}`).not.toBeNull();
            }
        }
        // Shopify's six, and deliberately NOT `main` — the public shell already emits
        // <main id="main-content"> around every template, so a second one is a nested landmark.
        expect([...TEMPLATE_TAGS].sort()).toEqual(['article', 'aside', 'div', 'footer', 'header', 'section']);
        expect(TEMPLATE_TAGS).not.toContain('main');
    });

    it('rejects a tag outside the enum — data may fill a slot, never name an element', () => {
        for (const tag of ['script', 'main', 'iframe', 'style', 'svg', 'object', 'Section', 'SECTION',
            'div ', 'a', '', 'section><script>alert(1)</script', 1, true, null, ['div']]) {
            expect(parseTemplate(raw([{ type: 'Section', props: { tag, items: [slot] } }])), JSON.stringify(tag)).toBeNull();
        }
    });

    it('accepts a className of up to three plain tokens, and only on containers', () => {
        for (const className of ['hero', 'site-hero', 'hero site-hero', 'a b c']) {
            expect(parseTemplate(raw([{ type: 'Section', props: { className, items: [slot] } }])), className).not.toBeNull();
        }
        // A leaf has no wrapper worth naming, so neither prop exists there.
        for (const type of ['Spacer', 'Divider', CONTENT_SLOT]) {
            expect(parseTemplate(raw([{ type, props: { className: 'hero' } }, slot])), type).toBeNull();
            expect(parseTemplate(raw([{ type, props: { tag: 'div' } }, slot])), type).toBeNull();
        }
    });

    it('rejects a className that tries to be anything other than a class', () => {
        for (const className of [
            'hero" onclick="alert(1)', "hero' onmouseover='x", 'hero><script>alert(1)</script>',
            'hero{color:red}', '.hero', '#hero', 'hero[data-x]', 'hero:hover', 'hero,div', 'hero/**/x',
            'HERO', 'Hero-Unit', '1hero', '-hero', 'hero_unit', 'hero\tunit', 'hero\nunit', 'hero  unit',
            ' hero', 'hero ', 'a b c d', 'one two three four five', '', 'x'.repeat(41), 'héro',
            1, true, null, ['hero'], { hero: true },
        ]) {
            expect(parseTemplate(raw([{ type: 'Section', props: { className, items: [slot] } }])), JSON.stringify(className)).toBeNull();
        }
    });

    it('pins the token rule the mirror shares with the backend', () => {
        expect(CLASS_TOKEN.source).toBe('^[a-z][a-z0-9-]{0,39}$');
        expect(CLASS_TOKEN.flags).not.toContain('m'); // `m` would let $ match before a newline
        expect(MAX_CLASS_TOKENS).toBe(3);
    });

    // ── the allowlist is closed ────────────────────────────────────────────────────────────────────
    it('rejects a block outside the allowlist, including ones a PAGE may use', () => {
        // HTMLEmbed, Symbol, Form, Heading, Text and Image all render fine in page content; a
        // theme-shipped template is a different trust question, so none of them is in this allowlist.
        for (const type of ['ScriptBlock', 'HTMLEmbed', 'Symbol', 'Form', 'Heading', 'Text', 'Image']) {
            expect(parseTemplate(raw([{ type, props: {} }, slot])), type).toBeNull();
        }
    });

    it('rejects children smuggled into a leaf', () => {
        expect(parseTemplate(raw([{ type: 'Spacer', props: { items: [slot] } }, slot]))).toBeNull();
    });

    // ── exactly one content slot ───────────────────────────────────────────────────────────────────
    it('rejects a template with no content slot — the page content would vanish', () => {
        expect(parseTemplate(raw([{ type: 'Section', props: { items: [{ type: 'Spacer', props: {} }] } }]))).toBeNull();
    });

    it('rejects two content slots — the content would render twice', () => {
        expect(parseTemplate(raw([slot, { type: 'Section', props: { items: [slot] } }]))).toBeNull();
    });

    it('accepts the dynamic blocks now that a template has a data path', () => {
        // These were refused for as long as a template could not feed them: they derive content from
        // the site, and a listing that validates and renders empty is worse than one that is refused.
        // resolveTemplateBlocks is that data path, so the reason expired — and this asserts it did.
        const t = parseTemplate(raw([
            { type: 'PostsGrid', props: { count: 6, columns: 3, gap: '2rem' } },
            { type: 'CategoryPosts', props: { count: 4, categorySlug: 'recetas', layout: 'list' } },
            { type: 'SearchBar', props: { placeholder: 'Buscar', align: 'center' } },
            slot,
        ]));
        expect(t).not.toBeNull();
        expect(t!.content.map(b => b.type)).toContain('PostsGrid');
    });

    it('still refuses a dynamic block prop its component would ignore', () => {
        // The same rule as everywhere else in this contract: a prop exists only if the block honours
        // it. `showExcerpt` reads like it should work and no component reads it.
        expect(parseTemplate(raw([{ type: 'PostsGrid', props: { showExcerpt: true } }, slot]))).toBeNull();
        expect(parseTemplate(raw([{ type: 'CategoryPosts', props: { layout: 'carousel' } }, slot]))).toBeNull();
        // …and a listing is a LEAF: it has no slot, so children must not be smuggled into it.
        expect(parseTemplate(raw([{ type: 'PostsGrid', props: { items: [slot] } }, slot]))).toBeNull();
    });

    // ── budgets and junk ───────────────────────────────────────────────────────────────────────────
    it('rejects an over-deep tree, an over-long tree and an over-sized file', () => {
        let deep: unknown = slot;
        for (let i = 0; i < 6; i++) deep = { type: 'Section', props: { items: [deep] } };
        expect(parseTemplate(raw([deep]))).toBeNull();

        const many = Array.from({ length: 120 }, () => ({ type: 'Spacer', props: { height: '1rem' } }));
        expect(parseTemplate(raw([...many, slot]))).toBeNull();

        expect(parseTemplate(raw([{ type: 'Section', props: { padding: 'x'.repeat(70_000), items: [slot] } }]))).toBeNull();
    });

    it('fails closed on anything that is not a template', () => {
        for (const bad of ['', '   ', '{ not json', '[]', 'null', JSON.stringify({ content: 'nope' }),
            JSON.stringify({ content: [null] }), JSON.stringify({ content: [{ props: {} }] })]) {
            expect(parseTemplate(bad), JSON.stringify(bad)).toBeNull();
        }
        expect(parseTemplate(null)).toBeNull();
        expect(parseTemplate(undefined)).toBeNull();
    });
});

describe('templateCandidates', () => {
    it('falls back from most specific to page, so one page.json can serve a whole theme', () => {
        expect(templateCandidates('home')).toEqual(['home', 'archive', 'page']);
        expect(templateCandidates('single')).toEqual(['single', 'page']);
        expect(templateCandidates('search')).toEqual(['search', 'archive', 'page']);
        // Every chain ENDS at 'page' — a theme shipping only page.json affects every route.
        for (const kind of ['home', 'single', 'page', 'archive', 'search'] as const) {
            expect(templateCandidates(kind).at(-1)).toBe('page');
        }
    });
});
