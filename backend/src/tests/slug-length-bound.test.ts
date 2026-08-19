/**
 * WordJS — a slug is bounded by its PRODUCER, because its column is bounded by MySQL.
 *
 * Closing audit #13 (TEXT → LONGTEXT unless the column is a key) plus the session-mode fix from #2
 * (STRICT_TRANS_TABLES) changed what happens to an overlong slug on MySQL. `posts.post_name` is a
 * key column — `CREATE INDEX idx_posts_name` narrows it to VARCHAR(255) — so a 300-character title
 * used to be TRUNCATED (defect #13's own example: two different titles collapsing onto ONE
 * post_name) and would now raise ERROR 1406 instead, surfacing as a 500 from `POST /posts`. Trading
 * silent corruption for an unhandled 500 is not a fix.
 *
 * The bound belongs in the producer, and the same producer feeds every bounded slug column in the
 * schema: posts.post_name (Post.create / Post.update), terms.slug (Term.create / Term.update),
 * users' nicenames. One rule, one place — core/formatting.sanitizeTitle.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { sanitizeTitle, boundSlug, MAX_SLUG_LENGTH } = require('../core/formatting');

test('a title far longer than the indexed column produces a slug that fits, with room for -N', () => {
    // 60 words of ~9 characters: well past 255 once slugified.
    const title = Array.from({ length: 60 }, (_, i) => `longwordy${i}`).join(' ');
    const slug = sanitizeTitle(title);

    assert.ok(slug.length <= MAX_SLUG_LENGTH,
        `the slug must fit the column: ${slug.length} > ${MAX_SLUG_LENGTH}`);
    // generateUniqueSlug appends `-2`, `-3`, … on collision; the whole thing must still fit 255.
    assert.ok(slug.length + '-999999'.length <= 255,
        'the bound must leave head-room for the collision suffix, or a COLLIDING long title still overflows');
    assert.doesNotMatch(slug, /-$/, 'the cut must not leave a dangling separator');
    assert.match(slug, /^[a-z0-9-]+$/, 'still a slug');
});

test('an ordinary title is untouched by the bound', () => {
    assert.strictEqual(sanitizeTitle('Hello World, Again!'), 'hello-world-again');
    const exact = 'a'.repeat(MAX_SLUG_LENGTH);
    assert.strictEqual(sanitizeTitle(exact), exact, 'a slug that already fits is returned verbatim');
});

test('boundSlug cuts at a word boundary when one is near the limit, and hard-cuts when none is', () => {
    const words = ('word-'.repeat(100)).slice(0, -1);          // hyphen every 5 chars
    const cut = boundSlug(words);
    assert.ok(cut.length <= MAX_SLUG_LENGTH);
    assert.ok(!cut.endsWith('-'));
    assert.ok(words.startsWith(cut), 'the bound only ever removes a suffix — it never rewrites the slug');

    const oneLongWord = 'x'.repeat(400);                        // no boundary to cut at
    assert.strictEqual(boundSlug(oneLongWord).length, MAX_SLUG_LENGTH,
        'with no separator to fall back on, the full budget is used');
});
