import { describe, it, expect } from 'vitest';
import { parseTemplate, templateCandidates, CONTENT_SLOT } from '../templateData';

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
                align: 'center', items: [
                    { type: 'Grid', props: { columns: 2, gap: '2rem', items: [slot, { type: 'PostsGrid', props: { count: 6, showExcerpt: true } }] } },
                    { type: 'FlexRow', props: { justify: 'between', wrap: true, items: [{ type: 'SearchBar', props: { placeholder: 'Buscar' } }] } },
                ]
            }
        }]));
        expect(t).not.toBeNull();
    });

    // ── data never chooses structure ───────────────────────────────────────────────────────────────
    it('rejects a prop outside its enum — the shape of the XSS this contract prevents', () => {
        expect(parseTemplate(raw([{ type: 'Section', props: { align: 'script', items: [slot] } }]))).toBeNull();
    });

    it('rejects an undeclared prop rather than ignoring it', () => {
        expect(parseTemplate(raw([{ type: 'Section', props: { as: 'iframe', items: [slot] } }]))).toBeNull();
    });

    it('rejects a prop of the wrong primitive type', () => {
        expect(parseTemplate(raw([{ type: 'Grid', props: { columns: 'three', items: [slot] } }]))).toBeNull();
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
        expect(parseTemplate(raw([{ type: 'PostsGrid', props: { items: [slot] } }, slot]))).toBeNull();
    });

    // ── exactly one content slot ───────────────────────────────────────────────────────────────────
    it('rejects a template with no content slot — the page content would vanish', () => {
        expect(parseTemplate(raw([{ type: 'Section', props: { items: [{ type: 'PostsGrid', props: {} }] } }]))).toBeNull();
    });

    it('rejects two content slots — the content would render twice', () => {
        expect(parseTemplate(raw([slot, { type: 'Section', props: { items: [slot] } }]))).toBeNull();
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
