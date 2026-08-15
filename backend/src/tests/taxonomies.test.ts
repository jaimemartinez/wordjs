/**
 * WordJS - Taxonomy Registry Tests
 * Mirrors the post-type registry. Verifies registerTaxonomy() and friends:
 * built-ins are always present, custom taxonomies normalize, bad shapes are
 * rejected, unregister removes, and the 'registered_taxonomy' hook fires.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const {
    registerTaxonomy,
    unregisterTaxonomy,
    getTaxonomy,
    getTaxonomies,
    taxonomyExists,
    initTaxonomies
} = require('../core/post-types');
const { addAction, removeAction } = require('../core/hooks');

describe('Taxonomy Registry', () => {
    beforeEach(async () => {
        // Ensure built-ins are seeded (idempotent) and no stray custom taxonomy lingers.
        await initTaxonomies();
        unregisterTaxonomy('genre');
    });

    afterEach(() => {
        unregisterTaxonomy('genre');
    });

    it('always has the two built-in taxonomies', () => {
        const category = getTaxonomy('category');
        const tag = getTaxonomy('post_tag');

        assert.ok(category, 'category must be registered');
        assert.strictEqual(category.hierarchical, true, 'category is hierarchical');
        assert.ok(category.postTypes.includes('post'), 'category applies to posts');

        assert.ok(tag, 'post_tag must be registered');
        assert.strictEqual(tag.hierarchical, false, 'post_tag is flat');
        assert.ok(taxonomyExists('category') && taxonomyExists('post_tag'));
    });

    it('registers a custom hierarchical taxonomy with normalized opts', () => {
        const returned = registerTaxonomy('genre', {
            label: 'Genres',
            hierarchical: true,
            postTypes: 'book',          // single string → normalized to array
            showInRest: true
        });

        const genre = getTaxonomy('genre');
        assert.ok(genre, 'getTaxonomy returns the registered taxonomy');
        assert.deepStrictEqual(genre, returned, 'getTaxonomy returns the same object register returned');
        assert.strictEqual(genre.name, 'genre');
        assert.strictEqual(genre.label, 'Genres');
        assert.strictEqual(genre.hierarchical, true, 'hierarchical normalized to boolean true');
        assert.deepStrictEqual(genre.postTypes, ['book'], 'postTypes string normalized to array');
        assert.strictEqual(genre.public, true, 'public defaults to true');
        assert.strictEqual(genre.showInRest, true);
        assert.deepStrictEqual(genre.rewrite, { slug: 'genre' }, 'rewrite slug defaults to name');
        assert.strictEqual(genre.labels.singular, 'Genres');
    });

    it('normalizes a non-boolean hierarchical to false (cannot be smuggled past normalization)', () => {
        registerTaxonomy('genre', { hierarchical: 'yes' as any, postTypes: ['book'] });
        assert.strictEqual(getTaxonomy('genre').hierarchical, false);
    });

    it('rejects a bad opts shape', () => {
        assert.throws(() => registerTaxonomy('genre', 'notanobject' as any), /plain object/);
        assert.throws(() => registerTaxonomy('genre', ['nope'] as any), /plain object/);
        assert.throws(() => registerTaxonomy('' as any, {}), /non-empty string/);
        assert.throws(() => registerTaxonomy(null as any, {}), /non-empty string/);
    });

    it('unregister removes a custom taxonomy but never a built-in', () => {
        registerTaxonomy('genre', { hierarchical: true });
        assert.ok(taxonomyExists('genre'));

        assert.strictEqual(unregisterTaxonomy('genre'), true, 'custom taxonomy removed');
        assert.strictEqual(taxonomyExists('genre'), false);
        assert.strictEqual(getTaxonomy('genre'), null);

        assert.strictEqual(unregisterTaxonomy('category'), false, 'built-in cannot be removed');
        assert.ok(taxonomyExists('category'), 'category still present after refused unregister');
    });

    it("fires the 'registered_taxonomy' action", () => {
        let firedName: string | null = null;
        let firedObj: any = null;
        const listener = (name: string, tax: any) => { firedName = name; firedObj = tax; };
        addAction('registered_taxonomy', listener);
        try {
            registerTaxonomy('genre', { hierarchical: true });
        } finally {
            removeAction('registered_taxonomy', listener);
        }
        assert.strictEqual(firedName, 'genre', 'hook received the taxonomy name');
        assert.ok(firedObj && firedObj.hierarchical === true, 'hook received the normalized object');
    });

    it('getTaxonomies filters by postType and rest visibility', () => {
        registerTaxonomy('genre', { hierarchical: true, postTypes: ['book'], showInRest: false });

        const forPost = getTaxonomies({ postType: 'post' }).map((t: any) => t.name);
        assert.ok(forPost.includes('category') && forPost.includes('post_tag'));
        assert.ok(!forPost.includes('genre'), 'genre applies to book, not post');

        const forBook = getTaxonomies({ postType: 'book' }).map((t: any) => t.name);
        assert.ok(forBook.includes('genre'));

        const restVisible = getTaxonomies({ showInRest: true }).map((t: any) => t.name);
        assert.ok(!restVisible.includes('genre'), 'genre is showInRest:false');
    });
});
