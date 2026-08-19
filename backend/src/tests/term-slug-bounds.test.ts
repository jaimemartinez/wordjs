/**
 * terms.slug — THE BOUND LIVES WHERE THE WRITE HAPPENS, AND THE WRITERS ARE DERIVED
 *
 * CLASS 7: "the bound lives in the usual PRODUCER and not where the WRITE happens." It was closed for
 * posts.post_name by moving `boundSlug` inside `Post.generateUniqueSlug` — the single point every writer
 * passes through. terms.slug is the exact twin and was left open: `Term.create` accepts
 * `slug || sanitizeTitle(name)`, so a caller-supplied slug never met `sanitizeTitle`'s bound, and the
 * `-2`, `-3`, … suffix was appended to the CALLER'S original string rather than to a bounded base.
 *
 * Reachable by an EDITOR (`manage_categories`), not only by an administrator. Invisible on SQLite, where
 * the column is unbounded; on MySQL drivers/mysql-text-rule narrows a key column to VARCHAR(255), so it
 * is errno 1406 and an unmapped 500. That is why no suite saw it.
 *
 * THE POPULATION IS DERIVED, in two directions:
 *   · from the SOURCE — every statement in the repo that writes `terms.slug` must live in models/Term.ts,
 *     so a new writer somewhere else is red rather than merely unbounded;
 *   · from the MODEL — the bound is asserted through the two entry points that exist (create and update)
 *     AND through the collision suffix, which is the half that made the post_name fix necessary twice.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-term-slug-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const Term = require('../models/Term');
const { MAX_SLUG_LENGTH } = require('../core/formatting');

let dbAsync: any;

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
});

after(async () => {
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    try { fs.rmSync(TMP_DB, { force: true }); } catch { /* */ }
    try { fs.rmSync(TMP_DB + '-wal', { force: true }); fs.rmSync(TMP_DB + '-shm', { force: true }); } catch { /* */ }
});

/** A slug nobody would type and every fuzzer sends: far past every column width in play. */
const HUGE = 'a-very-long-taxonomy-name'.repeat(200);

/**
 * The two things the bound has to be true of, stated once so every writer below asserts the SAME pair.
 * The second is the one that was wrong in the Post twin: a bounded base with an UNBOUNDED suffix policy
 * is not a bound, it is a bound plus however many disambiguations the site happens to need.
 */
function assertBounded(slug: string, where: string) {
    assert.ok(slug.length <= MAX_SLUG_LENGTH,
        `${where}: slug is ${slug.length} chars, over MAX_SLUG_LENGTH (${MAX_SLUG_LENGTH}): ${slug.slice(0, 80)}…`);
    assert.ok(slug.length <= 255,
        `${where}: slug is ${slug.length} chars and would be errno 1406 on a MySQL key column`);
}

test('every writer of terms.slug goes through the bound — including the collision suffix', async () => {
    // WRITER 1 — Term.create with a caller-supplied slug (routes/categories.ts and routes/tags.ts do this).
    const first = await Term.create({ name: 'First term', taxonomy: 'category', slug: HUGE });
    assertBounded(String(first.slug), 'Term.create (caller-supplied slug)');

    // WRITER 2 — the COLLISION SUFFIX. A second term whose slug collides must still fit: the `-2` has to
    // be built from the BOUNDED base, not from the caller's original string.
    const second = await Term.create({ name: 'Second term', taxonomy: 'category', slug: HUGE });
    assertBounded(String(second.slug), 'Term.create (collision suffix)');
    assert.notStrictEqual(second.slug, first.slug, 'the second term must get a distinct slug');
    assert.ok(String(second.slug).startsWith(String(first.slug)),
        'the suffix must extend the BOUNDED base, or the two are different strings entirely');

    // WRITER 3 — Term.update, the other door into generateUniqueSlug.
    await Term.update(first.termId, 'category', { slug: HUGE + '-renamed' });
    const renamed = await dbAsync.get('SELECT slug FROM terms WHERE term_id = ?', [first.termId]);
    assertBounded(String(renamed.slug), 'Term.update');

    // WRITER 4 — a term created from its NAME alone still fits (sanitizeTitle's own bound, restated here
    // so removing it from that helper does not silently uncover this path).
    const named = await Term.create({ name: HUGE, taxonomy: 'category' });
    assertBounded(String(named.slug), 'Term.create (slug derived from the name)');
});

/**
 * The ONE declared exception, named rather than filtered away. models/Menu.ts owns nav_menu terms and
 * writes terms.name/terms.slug with its own INSERT and UPDATE, so a menu slug never meets boundSlug:
 * Menu.create derives one from the name (Menu.ts:122) and Menu.update stores `data.slug` verbatim
 * (Menu.ts:202). It is the SAME class as this file's subject, in a file outside this change's scope, and
 * it is REPORTED as residual risk instead of being silently excluded. The assertion below fails if the
 * file stops writing the table, so the exception cannot outlive the debt.
 */
const DECLARED_DIRECT_WRITERS = ['models/Menu.ts'];

test('nothing outside models/Term.ts writes terms.slug', () => {
    const seenDeclared = new Set<string>();
    // DERIVED: the population is every non-test source file, not a list of the routes somebody recalled.
    const root = path.resolve(__dirname, '..');
    const WRITE = /(INSERT\s+INTO\s+terms\b|UPDATE\s+terms\b)/i;
    const offenders: string[] = [];

    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'tests' || entry.name === 'node_modules') continue;
                walk(full);
                continue;
            }
            if (!entry.name.endsWith('.ts')) continue;
            const rel = path.relative(root, full).split(path.sep).join('/');
            if (rel === 'models/Term.ts') continue;                 // the owner of the column
            const text = fs.readFileSync(full, 'utf8');
            const hits: string[] = [];
            String(text).split('\n').forEach((line: string, i: number) => {
                if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
                if (WRITE.test(line)) hits.push(`${rel}:${i + 1} ${line.trim()}`);
            });
            if (!hits.length) continue;
            // The exception is only "used" when the file really does still write the table, so a stale
            // entry cannot sit in the list unnoticed.
            if (DECLARED_DIRECT_WRITERS.includes(rel)) { seenDeclared.add(rel); continue; }
            offenders.push(...hits);
        }
    };
    walk(root);

    assert.deepStrictEqual(offenders, [],
        'a statement outside models/Term.ts writes the terms table directly, so it bypasses the one place ' +
        'that bounds terms.slug. Route it through Term.create / Term.update:\n  ' + offenders.join('\n  '));

    for (const rel of DECLARED_DIRECT_WRITERS) {
        assert.ok(seenDeclared.has(rel),
            `${rel} is declared as a direct writer of the terms table but no longer writes it — remove the ` +
            'entry from DECLARED_DIRECT_WRITERS rather than leaving a stale claim of debt.');
    }
});
