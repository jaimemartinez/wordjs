import { mergeCategoryOptions, toTermRefs } from "@/lib/editorRootFields";
import type { Category, PostTermRef } from "@/lib/api";

/**
 * THE ONE PRODUCER OF THE EDITOR'S CATEGORY STATE — the select's options AND the list the save
 * resolves against, from the same call.
 *
 * #25 was two halves that had to stay equal and lived in two places. `GET /categories` caps
 * `per_page` at 100, so the site list the editor loads can be a PAGE, not the catalogue; a post whose
 * own category falls outside it had no option in the select (the panel showed it as uncategorised),
 * and `resolveCategoriesForSave` resolving against that shorter list treated a category the panel was
 * SHOWING as unresolvable, so the author could not change it. The fix is the union — site categories
 * ∪ the record's own — used for both. Splitting it back into a seed line and a memo is what made it
 * possible to delete either one and keep the suite green.
 *
 * KEPT OUT OF THE PAGE COMPONENT ON PURPOSE: page.tsx is a client component that drags in the whole
 * editor, so nothing could exercise it in a unit test. Here the wiring is a pure function over the
 * REAL `editorRootFields` producers, and `frontend/src/lib/__tests__/postEditorCategoryState.test.ts`
 * drives it — plus the two lines in the page that feed it.
 *
 * @param recordSource the record's own categories, exactly as `Post.toJSON` serialises them
 *                     (`[{id,name,slug}, …]`); `toTermRefs` also accepts refs it already normalised,
 *                     so re-deriving from state is idempotent.
 * @param loadedCategories the site's categories as loaded by `categoriesApi.listAll()` — possibly a
 *                     truncated view, which is exactly why the union exists.
 */
export function buildCategoryEditorState(
    recordSource: unknown,
    loadedCategories: readonly Category[],
): { recordCategories: PostTermRef[]; categoryOptions: Category[] } {
    const recordCategories = toTermRefs(recordSource);
    return {
        recordCategories,
        categoryOptions: mergeCategoryOptions(loadedCategories, recordCategories),
    };
}
