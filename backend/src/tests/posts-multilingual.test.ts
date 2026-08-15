/**
 * MULTILINGUAL CONTENT (FRENTE E-2) — model contract.
 *
 * A post carries an optional BCP-47 language tag and an optional translation_group uuid; two posts are
 * translations of one another iff they share the same non-NULL group. This pins the OBSERVABLE contract
 * the routes and the public hreflang path depend on:
 *
 *   • create/setLanguage store a CANONICAL tag and reject junk (→ null, never a silent 'en');
 *   • linkTranslations is SYMMETRIC and IDEMPOTENT, and MERGES whole sets (not just the two posts);
 *   • getTranslations returns the other-language siblings, PUBLISHED-only by default;
 *   • toJSON exposes `language` + published `translations` (the hreflang payload), and a lone post
 *     exposes an EMPTY list — the property the frontend turns into zero <link rel=alternate> tags.
 *
 * Same config-repoint-first pattern as the other DB-backed suites (point config.dbPath at a temp file
 * BEFORE the DB layer resolves it). Columns come from the base schema (initializeSchema).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-ml-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const Post = require('../models/Post');

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
});

after(async () => {
    try { await database.close?.(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { fs.unlinkSync(f); } catch { /* */ }
    }
});

/** Create a published post in one language; returns its id. */
async function makePost(title: string, language: string | null = null, status = 'publish'): Promise<number> {
    const p = await Post.create({ authorId: 1, title, status, type: 'post', language });
    return p.id;
}

const groupOf = async (id: number): Promise<string | null> =>
    (await Post.findById(id)).translationGroup;

test('create + setLanguage store a CANONICAL BCP-47 tag; junk becomes null (never a silent fallback)', async () => {
    const id = await makePost('Hola', 'pt_br');           // underscore locale form
    assert.strictEqual((await Post.findById(id)).postLanguage, 'pt-BR', 'locale form canonicalized to a tag');

    assert.strictEqual(await Post.setLanguage(id, 'DE'), 'de', 'uppercased short tag canonicalized');
    assert.strictEqual((await Post.findById(id)).postLanguage, 'de');

    // An unparseable value clears the language (does NOT become 'en').
    assert.strictEqual(await Post.setLanguage(id, 'not a tag!!'), null, 'junk → null');
    assert.strictEqual((await Post.findById(id)).postLanguage, null);

    // Explicit clear.
    await Post.setLanguage(id, 'fr');
    assert.strictEqual(await Post.setLanguage(id, ''), null, 'empty string clears');
    assert.strictEqual((await Post.findById(id)).postLanguage, null);
});

test('linkTranslations is symmetric and idempotent', async () => {
    const en = await makePost('Cat', 'en');
    const es = await makePost('Gato', 'es');

    const g1 = await Post.linkTranslations(en, es);
    assert.ok(g1, 'linking returns a group id');
    assert.strictEqual(await groupOf(en), g1);
    assert.strictEqual(await groupOf(es), g1, 'both posts share ONE group — symmetric');

    // Idempotent: linking again (either direction) keeps the SAME group, no duplication.
    assert.strictEqual(await Post.linkTranslations(en, es), g1, 'A,B re-link keeps the group');
    assert.strictEqual(await Post.linkTranslations(es, en), g1, 'B,A link is the same relationship');
    assert.strictEqual(await groupOf(en), g1);
    assert.strictEqual(await groupOf(es), g1);
});

test('linkTranslations MERGES whole sets (a third language joins both existing members)', async () => {
    const en = await makePost('Dog', 'en');
    const es = await makePost('Perro', 'es');
    const fr = await makePost('Chien', 'fr');

    const g = await Post.linkTranslations(en, es);
    // fr had no group; linking fr↔en must fold fr into the EXISTING {en,es} group, not make a new one.
    const merged = await Post.linkTranslations(fr, en);
    assert.strictEqual(merged, g, 'the pre-existing group survives the merge');
    assert.strictEqual(await groupOf(en), g);
    assert.strictEqual(await groupOf(es), g, 'the untouched member es is still in the group');
    assert.strictEqual(await groupOf(fr), g, 'fr joined the same group');

    // Now merge TWO existing groups: build a separate {de,it} set, then link one member across.
    const de = await makePost('Hund', 'de');
    const it = await makePost('Cane', 'it');
    const g2 = await Post.linkTranslations(de, it);
    assert.notStrictEqual(g2, g, 'the two sets start distinct');
    await Post.linkTranslations(it, en);
    // Every one of the five posts must now share ONE group.
    const groups = new Set(await Promise.all([en, es, fr, de, it].map(groupOf)));
    assert.strictEqual(groups.size, 1, 'merging two sets collapses them to a single group');
});

test('getTranslations returns other-language siblings, PUBLISHED-only by default', async () => {
    const en = await makePost('House', 'en');
    const es = await makePost('Casa', 'es');
    const draft = await makePost('Maison', 'fr', 'draft');
    await Post.linkTranslations(en, es);
    await Post.linkTranslations(en, draft);

    const pub = await Post.getTranslations(en);
    assert.deepStrictEqual(
        pub.map((t: any) => t.language).sort(), ['es'],
        'default view excludes the draft translation and the post itself'
    );

    const all = await Post.getTranslations(en, undefined, { includeUnpublished: true });
    assert.deepStrictEqual(
        all.map((t: any) => t.language).sort(), ['es', 'fr'],
        'management view includes the unpublished sibling'
    );

    // A lone post has no siblings.
    const lonely = await makePost('Solo', 'en');
    assert.deepStrictEqual(await Post.getTranslations(lonely), [], 'ungrouped post → empty list');
});

test('toJSON exposes language + published translations for a grouped post, and none for a lone post', async () => {
    const en = await makePost('Tree', 'en');
    const es = await makePost('Arbol', 'es');
    await Post.linkTranslations(en, es);

    const j = await (await Post.findById(en)).toJSON();
    assert.strictEqual(j.language, 'en', 'toJSON carries the post language');
    assert.strictEqual(j.translations.length, 1, 'one sibling');
    assert.strictEqual(j.translations[0].language, 'es');
    assert.strictEqual(j.translations[0].slug, (await Post.findById(es)).postName, 'sibling slug is exposed for the hreflang href');

    // The property the frontend relies on: a monolingual/lone post exposes an EMPTY translations list.
    const lone = await makePost('Alone');
    const jl = await (await Post.findById(lone)).toJSON();
    assert.strictEqual(jl.language, null, 'no language set → null');
    assert.deepStrictEqual(jl.translations, [], 'lone post → no translations (⇒ zero hreflang tags)');
});

test('unlinkTranslation removes one post from the set, leaving the rest linked', async () => {
    const en = await makePost('Sun', 'en');
    const es = await makePost('Sol', 'es');
    const fr = await makePost('Soleil', 'fr');
    const g = await Post.linkTranslations(en, es);
    await Post.linkTranslations(en, fr);

    assert.strictEqual(await Post.unlinkTranslation(es), true);
    assert.strictEqual(await groupOf(es), null, 'es left the set');
    assert.strictEqual(await groupOf(en), g, 'en still grouped');
    assert.strictEqual(await groupOf(fr), g, 'fr still grouped');
    // en's published siblings no longer include es.
    const sibs = await Post.getTranslations(en);
    assert.deepStrictEqual(sibs.map((t: any) => t.language).sort(), ['fr']);
});
