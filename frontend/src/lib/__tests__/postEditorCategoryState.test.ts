/**
 * #25 FOLLOW-UP — THE PAGE'S CATEGORY WIRING, PINNED.
 *
 * `categorySelectorPagination.test.ts` drives the real HTTP client and the real field producers, but
 * it never touches the editor page — and the two lines that turned those producers into a working
 * panel lived only there: the seed of the record's own categories, and passing THE SAME union to
 * `resolveCategoriesForSave`. Deleting either one left all 89 tests green while the defect came
 * halfway back: without the seed, a category outside the loaded page has no option again; without the
 * union at save time, a category the panel is SHOWING resolves to nothing and the author's change is
 * dropped in silence.
 *
 * So this file pins both halves:
 *  1. THE PRODUCER — `buildCategoryEditorState` (the page's own module) over the REAL
 *     `editorRootFields` functions and an API-shaped post, including the case that separates the
 *     union from the loaded page.
 *  2. THE WIRING — page.tsx is a client component that drags in the whole editor, so what a unit test
 *     can hold onto is its SOURCE: it must feed the producer from the loaded post and must resolve
 *     the save against the producer's output, with no second, local way of building that list.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildCategoryEditorState } from '@/app/admin/posts/[id]/categoryEditorState';
import { categoryField, resolveCategoriesForSave } from '@/lib/editorRootFields';
import type { Category } from '@/lib/api';

/** 150 categories, as a WXR import leaves them; `GET /categories` caps per_page at 100. */
const ALL: Category[] = Array.from({ length: 150 }, (_, i) => ({
    id: i + 1,
    name: `Cat ${String(i + 1).padStart(3, '0')}`,
    slug: `cat-${i + 1}`,
    count: 0,
}));
/** What the editor has in hand when only the first page arrived. */
const FIRST_PAGE = ALL.slice(0, 100);
/** `Post.toJSON` serialises the record's terms like this — id, name, slug. */
const RECORD = [
    { id: 7, name: 'Cat 007', slug: 'cat-7' },
    { id: 150, name: 'Cat 150', slug: 'cat-150' },
];

describe('#25 buildCategoryEditorState — one union for the select and for the save', () => {
    it('adds the record\'s own out-of-page category to the options, with its real name', () => {
        const { recordCategories, categoryOptions } = buildCategoryEditorState(RECORD, FIRST_PAGE);
        expect(recordCategories.map((r) => r.id)).toEqual([7, 150]);
        expect(categoryOptions).toHaveLength(101);
        expect(categoryOptions.find((c) => c.id === 150)).toEqual({ id: 150, name: 'Cat 150', slug: 'cat-150', count: 0 });
        // The select therefore offers the real term, not the "#150" placeholder for an unknown id.
        // `VersoField` is a union (a slot field carries no `options`), hence the widening cast.
        const options = (categoryField(categoryOptions, '150') as unknown as {
            options: { label: string; value: string }[];
        }).options;
        expect(options).toContainEqual({ label: 'Cat 150', value: '150' });
        expect(options.some((o) => o.label === '#150')).toBe(false);
    });

    it('is what makes the author\'s change SAVEABLE — the loaded page alone drops it', () => {
        const { categoryOptions } = buildCategoryEditorState(RECORD, FIRST_PAGE);
        // The author picks the record's own out-of-page category as the primary one.
        const args = { current: '150', seeded: RECORD };
        expect(resolveCategoriesForSave({ ...args, categories: categoryOptions })).toEqual([150]);
        // Same author action resolved against the loaded page only: unresolvable → silently no-op.
        expect(resolveCategoriesForSave({ ...args, categories: FIRST_PAGE })).toBeUndefined();
    });

    it('a post with no categories yields no options beyond the site list, and no crash on null', () => {
        expect(buildCategoryEditorState(null, FIRST_PAGE).categoryOptions).toHaveLength(100);
        expect(buildCategoryEditorState(undefined, []).recordCategories).toEqual([]);
        // Idempotent: feeding back the refs it produced changes nothing (the page re-derives on each
        // render from state).
        const once = buildCategoryEditorState(RECORD, FIRST_PAGE);
        const twice = buildCategoryEditorState(once.recordCategories, FIRST_PAGE);
        expect(twice.categoryOptions).toEqual(once.categoryOptions);
    });

    it('the record never displaces the site\'s own row for the same id', () => {
        const renamed = [{ id: 3, name: 'STALE NAME', slug: 'stale' }];
        const { categoryOptions } = buildCategoryEditorState(renamed, FIRST_PAGE);
        expect(categoryOptions.find((c) => c.id === 3)!.name).toBe('Cat 003');
    });
});

describe('#25 the editor page is wired to that producer, and to nothing else', () => {
    const page = readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app/admin/posts/[id]/page.tsx'),
        'utf8',
    );

    it('seeds the record\'s categories from the loaded post', () => {
        // Deleting this line is the half that leaves `recordCategories` empty forever.
        expect(page).toMatch(/setRecordCategorySource\(\s*post\.categories\s*\)/);
    });

    it('derives BOTH the options and the record refs from buildCategoryEditorState', () => {
        expect(page).toMatch(/const \{ recordCategories, categoryOptions \} = useMemo\(/);
        expect(page).toMatch(/buildCategoryEditorState\(\s*recordCategorySource,\s*categories\s*\)/);
    });

    it('resolves the save against that same union', () => {
        const call = /resolveCategoriesForSave\(\{([\s\S]*?)\}\)/.exec(page);
        expect(call, 'resolveCategoriesForSave is no longer called by the editor page').not.toBeNull();
        expect(call![1]).toMatch(/categories:\s*categoryOptions\b/);
    });

    it('has no second way of building that list', () => {
        // A local mergeCategoryOptions/toTermRefs call would be a fork of the producer — which is how
        // the select and the save came to disagree in the first place.
        expect(page).not.toMatch(/\bmergeCategoryOptions\(/);
        expect(page).not.toMatch(/\btoTermRefs\(/);
    });
});
