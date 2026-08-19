/**
 * #15 FOLLOW-UP — THE RESTORE DIALOG MUST NAME WHAT A RESTORE DESTROYS.
 *
 * `restoreRevision` rolls back the post row and the VERSIONED meta, and the roll-back is exact in
 * both directions: a versioned key the live post has but the snapshot does not is DELETED (the
 * backend suite pins that: "a snapshot with a versioned key CLEARS one added later"). So restoring a
 * version older than the featured image, the theme template or the SEO fields removes them — and the
 * confirm dialog said only "your current unsaved changes will be lost".
 *
 * WHY THE TEST READS THE BACKEND CONSTANT INSTEAD OF LISTING THE KEYS AGAIN. The list that decides
 * what a restore moves is `REVISIONABLE_POST_META` in backend/src/core/revisions.ts. A copy of it
 * here would go stale the first time someone versions another key, and the dialog would quietly
 * understate the damage again — which is the exact failure this test exists to prevent. So the keys
 * come from the real module and each one must have a phrase in the dialog; adding a key to a revision
 * fails this test until the sidebar names it.
 *
 * The dialog text is read from the component SOURCE: it is a string built inside an event handler of
 * a client component whose module pulls the whole admin API layer, and what is being pinned is the
 * WORDING, which the source carries exactly.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.resolve(here, rel), 'utf8');

const sidebar = read('../RevisionsSidebar.tsx');
const revisions = read('../../../../backend/src/core/revisions.ts');

/**
 * The restore dialog's call, with the source's line continuations undone: the message is written as
 * adjacent template literals joined by `+`, so the text an author reads is the CONCATENATION, and a
 * phrase may straddle two source lines. Joining them is what makes this a test about the wording
 * instead of a test about where the lines were wrapped.
 */
const dialog = (() => {
    const start = sidebar.indexOf('const ok = await confirm(');
    expect(start, 'the restore confirm disappeared from RevisionsSidebar').toBeGreaterThan(-1);
    const end = sidebar.indexOf('if (ok)', start);
    return sidebar.slice(start, end).replace(/`\s*\+\s*`/g, '');
})();

/** The keys a revision actually captures, straight from the backend module. */
const revisionableKeys = (() => {
    const block = /const REVISIONABLE_POST_META: string\[\] = \[([\s\S]*?)\];/.exec(revisions);
    expect(block, 'REVISIONABLE_POST_META moved or was renamed').not.toBeNull();
    return [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
})();

/** What each versioned key is CALLED in the editor, i.e. what an author must read to recognise it. */
const PHRASE_FOR_KEY: Record<string, RegExp> = {
    _puck_data: /page layout/i,
    _wjs_template: /theme template/i,
    _thumbnail_id: /featured image/i,
    seo_title: /SEO title/i,
    seo_description: /SEO description/i,
    og_image: /social image/i,
    noindex: /noindex/i,
};

describe('#15 the restore dialog discloses the versioned meta it overwrites', () => {
    it('the backend still versions the keys this test knows how to name', () => {
        // Not a copy of the list — a demand that a NEW key comes with a user-facing name. Add the
        // phrase to PHRASE_FOR_KEY and to the dialog together.
        expect(revisionableKeys.filter((k) => !PHRASE_FOR_KEY[k])).toEqual([]);
        expect(revisionableKeys.length).toBeGreaterThan(1);
    });

    it.each(revisionableKeys)('%s is named in the dialog', (key) => {
        expect(dialog).toMatch(PHRASE_FOR_KEY[key]);
    });

    it('says that a field added AFTER the version is removed, not just overwritten', () => {
        expect(dialog).toMatch(/removed|clears|cleared|deleted/i);
        expect(dialog).toMatch(/after/i);
    });

    it('still warns about unsaved changes, and says what a restore does NOT touch', () => {
        expect(dialog).toMatch(/unsaved changes/i);
        expect(dialog).toMatch(/review thread/i);
        expect(dialog).toMatch(/plugins/i);
    });

    it('the disclosure is the MESSAGE, not the heading — confirm(message, title, isDanger)', () => {
        // ModalContext's signature is (message, title, isDanger): the sidebar used to pass them the
        // other way round, so the long text rendered as the <h3> and the body read "Restore
        // Revision". The message is the first argument and the dialog is marked destructive.
        const firstArg = dialog.slice(dialog.indexOf('confirm(') + 'confirm('.length);
        expect(firstArg.trimStart().startsWith('`Restoring the version from')).toBe(true);
        expect(dialog).toMatch(/"Restore this version\?",\s*\n?\s*true,/);
    });
});
