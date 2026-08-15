/**
 * Revisions real diff (FRENTE C-4, part B).
 *
 * compareRevisions() used to report a "diff" as three title/content/excerpt "changed y/n" booleans.
 * It now ALSO returns a structured word-level diff (core/text-diff, dependency-free LCS). This pins:
 *
 *   1. text-diff CORRECTNESS: for a known before/after the diff carries real added AND removed
 *      segments (not just a boolean), and it is LOSSLESS — the 'same'+'removed' segments reconstruct
 *      the old text and 'same'+'added' reconstruct the new text. A dropped/duplicated/mistyped token
 *      breaks reconstruction, so this fails under mutation.
 *   2. SYMMETRY: for a case with a unique LCS, the text added by diff(a,b) equals the text removed by
 *      diff(b,a), and vice versa.
 *   3. WIRING + back-compat: compareRevisions() returns the structured `diff` alongside the original
 *      booleans, and the diff reflects a real content edit.
 *
 * node --test isolates this file in its own process.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { diffText, diffStats } = require('../core/text-diff');

// Join the text visible on the OLD side (everything not exclusively added) / NEW side (not removed).
const reconstructOld = (segs: any[]) => segs.filter((s) => s.type !== 'added').map((s) => s.value).join('');
const reconstructNew = (segs: any[]) => segs.filter((s) => s.type !== 'removed').map((s) => s.value).join('');
const textOfType = (segs: any[], type: string) => segs.filter((s) => s.type === type).map((s) => s.value).join('');

describe('text-diff: structured, lossless, symmetric', () => {
    it('produces real added AND removed segments for a known before/after', () => {
        const segs = diffText('The quick brown fox', 'The slow brown fox', 'word');
        // Not booleans — actual segments the UI can render.
        assert.ok(textOfType(segs, 'removed').includes('quick'), 'the removed word must appear as a removed segment');
        assert.ok(textOfType(segs, 'added').includes('slow'), 'the added word must appear as an added segment');
        // "The", "brown" and "fox" are unchanged.
        assert.ok(textOfType(segs, 'same').includes('brown'));
    });

    it('is lossless: same+removed reconstructs old, same+added reconstructs new', () => {
        const cases: Array<[string, string]> = [
            ['The quick brown fox', 'The slow brown fox'],
            ['alpha beta gamma delta', 'alpha gamma epsilon delta'],
            ['one two three', 'one two three four five'],   // pure append
            ['a b c d e', 'a c e'],                           // pure deletions
            ['', 'hello world'],                             // empty → all added
            ['goodbye world', ''],                           // all removed
            ['same same same', 'same same same'],            // no change
            ['<p>Hello</p>', '<p>Hello there</p>'],           // HTML content
        ];
        for (const [oldT, newT] of cases) {
            const segs = diffText(oldT, newT, 'word');
            assert.strictEqual(reconstructOld(segs), oldT, `old reconstruction failed for ${JSON.stringify(oldT)}`);
            assert.strictEqual(reconstructNew(segs), newT, `new reconstruction failed for ${JSON.stringify(newT)}`);
        }
    });

    it('identical inputs yield no added/removed segments', () => {
        const segs = diffText('nothing changed here', 'nothing changed here', 'word');
        assert.strictEqual(textOfType(segs, 'added'), '');
        assert.strictEqual(textOfType(segs, 'removed'), '');
        const stats = diffStats(segs);
        assert.strictEqual(stats.changed, false);
        assert.strictEqual(stats.added, 0);
        assert.strictEqual(stats.removed, 0);
    });

    it('is symmetric: text added by diff(a,b) == text removed by diff(b,a) (unique LCS)', () => {
        const a = 'alpha beta gamma';
        const b = 'alpha delta gamma';
        const ab = diffText(a, b, 'word');
        const ba = diffText(b, a, 'word');
        assert.strictEqual(textOfType(ab, 'added'), textOfType(ba, 'removed'));
        assert.strictEqual(textOfType(ab, 'removed'), textOfType(ba, 'added'));
        // And the un-mutated fact the old booleans gave: something DID change.
        assert.strictEqual(diffStats(ab).changed, true);
    });

    it('line mode diffs whole lines losslessly', () => {
        const oldT = 'line one\nline two\nline three';
        const newT = 'line one\nline TWO changed\nline three';
        const segs = diffText(oldT, newT, 'line');
        assert.strictEqual(reconstructOld(segs), oldT);
        assert.strictEqual(reconstructNew(segs), newT);
        assert.ok(diffStats(segs).changed);
    });
});

// ----------------------------------------------------------------------------------------------------
// compareRevisions() wiring against a real DB.
// ----------------------------------------------------------------------------------------------------
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-rev-diff-'));
process.chdir(TMP_ROOT);
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

describe('compareRevisions: structured diff alongside booleans', () => {
    let dbAsync: any;
    let revisions: any;
    let rev1Id: number;
    let rev2Id: number;

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();
        revisions = require('../core/revisions');

        // A parent post to hang the revisions off.
        const parent = await dbAsync.run(
            `INSERT INTO posts (author_id, post_title, post_content, post_excerpt, post_status, post_type, post_name, post_mime_type)
             VALUES (?, ?, ?, ?, 'publish', 'post', 'p', '')`,
            [1, 'Parent', 'body', 'ex', ]
        );
        const parentId = parent.lastID;

        let revSeq = 0;
        const insertRevision = async (title: string, content: string, excerpt: string) => {
            revSeq++;
            const r = await dbAsync.run(
                `INSERT INTO posts (author_id, post_title, post_content, post_excerpt, post_status, post_type, post_parent, post_name, post_mime_type)
                 VALUES (?, ?, ?, ?, 'inherit', 'revision', ?, ?, '')`,
                [1, title, content, excerpt, parentId, `${parentId}-revision-v${revSeq}`]
            );
            return r.lastID as number;
        };

        rev1Id = await insertRevision('Hello World', '<p>The quick brown fox</p>', 'first excerpt');
        rev2Id = await insertRevision('Hello There', '<p>The slow brown fox</p>', 'first excerpt');
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('keeps the back-compat booleans', async () => {
        const cmp = await revisions.compareRevisions(rev1Id, rev2Id);
        assert.ok(cmp, 'comparison must exist');
        assert.strictEqual(cmp.titleChanged, true);
        assert.strictEqual(cmp.contentChanged, true);
        assert.strictEqual(cmp.excerptChanged, false); // excerpt identical
    });

    it('adds a structured diff with real added/removed content segments', async () => {
        const cmp = await revisions.compareRevisions(rev1Id, rev2Id);
        assert.ok(cmp.diff, 'diff must be present');
        assert.ok(Array.isArray(cmp.diff.content), 'content diff is a segment array');

        const added = cmp.diff.content.filter((s: any) => s.type === 'added').map((s: any) => s.value).join('');
        const removed = cmp.diff.content.filter((s: any) => s.type === 'removed').map((s: any) => s.value).join('');
        assert.ok(added.includes('slow'), 'the new word must be an added segment');
        assert.ok(removed.includes('quick'), 'the old word must be a removed segment');

        // Title changed too; excerpt did not (no added/removed segments).
        assert.strictEqual(cmp.diff.stats.title.changed, true);
        assert.strictEqual(cmp.diff.stats.excerpt.changed, false);
    });
});
