/** F4: declarative field snapshots, immutable codecs and legacy compatibility. */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
config.nodeEnv = 'test';
const TMP_DB = path.join(os.tmpdir(), `wjs-f4-revisions-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const postTypes = require('../core/post-types');
const Post = require('../models/Post');
const {
    normalizeContentTypeSchema,
    legacyPostTypeToContentSchema,
} = require('../core/content-schema');
const {
    saveRevision,
    getRevision,
    getRevisionRestoreIntent,
    getRevisions,
    restoreRevision,
    deleteRevision,
    deleteAllRevisions,
    countRevisions,
    isRevisionableMeta,
} = require('../core/revisions');
const { REVISION_SNAPSHOT_META_KEY } = require('../core/revision-constants');

let dbAsync: any;
let sequence = 0;
const unique = (prefix: string) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;

function pluginSchema(codecVersion = 1, includeFuture = false) {
    const schema = legacyPostTypeToContentSchema('f4_book', {
        label: 'F4 Books',
        supports: ['title', 'editor', 'excerpt', 'revisions'],
        capability_type: 'book',
        showInRest: true,
    });
    schema.fields.pluginRating = {
        type: 'integer', storage: { kind: 'meta', key: 'plugin_rating' },
        required: false, multiple: false, revisioned: true,
        description: 'Plugin rating',
    };
    // Deliberately omit pluginRating from revisions.fields: F4 makes the per-field bit authoritative.
    schema.fields.pluginNotes = {
        type: 'text', storage: { kind: 'meta', key: 'plugin_notes' },
        required: false, multiple: false, revisioned: false,
        description: 'Plugin notes outside revision history',
    };
    if (includeFuture) {
        schema.fields.pluginFuture = {
            type: 'string', storage: { kind: 'meta', key: 'plugin_future' },
            required: false, multiple: false, revisioned: true,
            description: 'Field introduced by a later plugin version',
        };
    }
    schema.revisions.codecVersion = codecVersion;
    schema.revisions.metaKeys = [];
    return normalizeContentTypeSchema(schema);
}

async function rawMeta(postId: number, key: string) {
    const row = await dbAsync.get('SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = ?', [postId, key]);
    return row?.meta_value ?? null;
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await postTypes.initPostTypes();
});

after(async () => {
    postTypes.unregisterPostType('f4_book');
    postTypes.unregisterPostType('f4_bad_codec');
    try { if (dbAsync?.close) await dbAsync.close(); } catch { /* cleanup */ }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(TMP_DB + suffix, { force: true }); } catch { /* cleanup */ }
    }
});

describe('F4 declarative plugin fields', () => {
    test('a plugin field restores from the frozen schema after plugin upgrade and deactivation', async () => {
        const originalSchema = pluginSchema();
        assert.ok(originalSchema.revisions.fields.includes('pluginRating'), 'revisioned:true must be authoritative');
        postTypes.registerContentType(originalSchema);

        const post = await Post.create({ authorId: 1, type: 'f4_book', title: unique('old-title'), content: 'old body', status: 'draft' });
        await Post.updateMeta(post.id, 'plugin_rating', 3);
        await Post.updateMeta(post.id, 'plugin_notes', 'keep-live');
        const revisionId = await saveRevision(post.id);

        const revision = await getRevision(revisionId);
        assert.strictEqual(revision.restore.compatible, true);
        assert.strictEqual(revision.restore.schemaVersion, 1);
        assert.strictEqual(revision.restore.codecVersion, 1);
        assert.match(revision.restore.schemaFingerprint, /^[a-f0-9]{64}$/);
        assert.ok(revision.restore.fields.some((field: any) => field.name === 'pluginRating' && field.description === 'Plugin rating'));
        assert.strictEqual(Object.prototype.hasOwnProperty.call(revision.meta, REVISION_SNAPSHOT_META_KEY), false, 'internal manifest leaked through the API');

        // A later plugin adds another revisioned field. It did not exist in this snapshot and must not
        // become part of the old snapshot retroactively.
        postTypes.registerContentType(pluginSchema(1, true));
        await Post.update(post.id, { title: unique('new-title'), content: 'new body' });
        await Post.updateMeta(post.id, 'plugin_rating', 9);
        await Post.updateMeta(post.id, 'plugin_notes', 'keep-new-notes');
        await Post.updateMeta(post.id, 'plugin_future', 'future-field-stays');

        postTypes.unregisterPostType('f4_book');
        assert.strictEqual(await restoreRevision(revisionId), true, 'snapshot must not require the active plugin registry');
        const restored = await dbAsync.get('SELECT post_title, post_content FROM posts WHERE id = ?', [post.id]);
        assert.match(restored.post_title, /old-title/);
        assert.strictEqual(restored.post_content, 'old body');
        assert.strictEqual(JSON.parse(await rawMeta(post.id, 'plugin_rating')), 3);
        assert.strictEqual(await rawMeta(post.id, 'plugin_notes'), 'keep-new-notes', 'non-revisioned plugin data was touched');
        assert.strictEqual(await rawMeta(post.id, 'plugin_future'), 'future-field-stays', 'a later field was reinterpreted into the old snapshot');

        // The pre-restore safety revision merged the disabled plugin field, so undoing the restore is
        // still possible even though no current schema could have rediscovered it.
        const safety = (await getRevisions(post.id, { limit: 10 })).find((entry: any) => entry.id !== revisionId);
        assert.ok(safety, 'restore did not create its transactional safety snapshot');
        assert.ok(safety.restore.fields.some((field: any) => field.name === 'pluginRating'));
        assert.strictEqual(await restoreRevision(safety.id), true);
        assert.strictEqual(JSON.parse(await rawMeta(post.id, 'plugin_rating')), 9);
    });

    test('single-key writes discover plugin revision fields without a core allowlist change', () => {
        postTypes.registerContentType(pluginSchema());
        assert.strictEqual(isRevisionableMeta('PLUGIN_RATING', 'f4_book'), true);
        assert.strictEqual(isRevisionableMeta('plugin_notes', 'f4_book'), false);
        assert.strictEqual(isRevisionableMeta('plugin_rating'), false, 'legacy fallback must not absorb plugin fields globally');
    });
});

describe('F4 codec and legacy boundaries', () => {
    test('manifest-less revisions retain the exact pre-F4 field set and do not delete unrelated meta', async () => {
        const post = await Post.create({ authorId: 1, title: unique('legacy-old'), content: 'legacy body', status: 'draft' });
        await Post.updateMeta(post.id, '_puck_data', { old: true });
        const revisionId = await saveRevision(post.id);
        await dbAsync.run('DELETE FROM post_meta WHERE post_id = ? AND meta_key = ?', [revisionId, REVISION_SNAPSHOT_META_KEY]);

        await Post.update(post.id, { title: unique('legacy-new'), content: 'new body' });
        await Post.updateMeta(post.id, '_puck_data', { old: false });
        await Post.updateMeta(post.id, 'plugin_unrelated', 'survives');
        assert.strictEqual(await restoreRevision(revisionId), true);

        const restored = await dbAsync.get('SELECT post_title, post_content FROM posts WHERE id = ?', [post.id]);
        assert.match(restored.post_title, /legacy-old/);
        assert.strictEqual(restored.post_content, 'legacy body');
        assert.deepStrictEqual(JSON.parse(await rawMeta(post.id, '_puck_data')), { old: true });
        assert.strictEqual(await rawMeta(post.id, 'plugin_unrelated'), 'survives');
        assert.strictEqual((await getRevision(revisionId)).restore.legacy, true);
    });

    test('an unknown codec fails closed before any safety snapshot or content write', async () => {
        const post = await Post.create({ authorId: 1, title: unique('codec-old'), content: 'old', status: 'draft' });
        const revisionId = await saveRevision(post.id);
        const row = await dbAsync.get('SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = ?', [revisionId, REVISION_SNAPSHOT_META_KEY]);
        const manifest = JSON.parse(row.meta_value);
        manifest.revisionCodecVersion = 999;
        await dbAsync.run('UPDATE post_meta SET meta_value = ? WHERE post_id = ? AND meta_key = ?', [JSON.stringify(manifest), revisionId, REVISION_SNAPSHOT_META_KEY]);
        await Post.update(post.id, { title: unique('codec-live'), content: 'live' });
        const before = await countRevisions(post.id);

        assert.strictEqual(await restoreRevision(revisionId), false);
        assert.strictEqual(await countRevisions(post.id), before, 'failed decode created a safety revision');
        assert.strictEqual((await dbAsync.get('SELECT post_content FROM posts WHERE id = ?', [post.id])).post_content, 'live');
        const described = await getRevision(revisionId);
        assert.strictEqual(described.restore.compatible, false);
        assert.strictEqual(described.restore.errorCode, 'revision_codec_unsupported');
        const intent = await getRevisionRestoreIntent(revisionId);
        assert.strictEqual(intent.compatible, false);
        assert.strictEqual(intent.descriptor.errorCode, 'revision_codec_unsupported');
    });

    test('a schema requesting an unavailable codec cannot leave a partial revision', async () => {
        const bad = pluginSchema(77);
        bad.name = 'f4_bad_codec';
        bad.storage.discriminator.value = 'f4_bad_codec';
        postTypes.registerContentType(bad);
        const post = await Post.create({ authorId: 1, type: 'f4_bad_codec', title: unique('bad-codec'), status: 'draft' });
        await assert.rejects(saveRevision(post.id), /Unsupported revision codec version 77/);
        assert.strictEqual(await countRevisions(post.id), 0);
    });

    test('a parent relation that became cyclic fails atomically with no safety-history residue', async () => {
        const parent = await Post.create({ authorId: 1, type: 'page', title: unique('parent'), status: 'draft' });
        const child = await Post.create({ authorId: 1, type: 'page', title: unique('child'), parent: parent.id, status: 'draft' });
        const revisionId = await saveRevision(child.id); // frozen child -> parent

        await Post.update(child.id, { parent: 0 });
        await Post.update(parent.id, { parent: child.id }); // valid current chain: parent -> child -> root
        const before = await countRevisions(child.id);
        assert.strictEqual(await restoreRevision(revisionId), false, 'restore would create child -> parent -> child');
        assert.strictEqual(await countRevisions(child.id), before, 'failed parent validation committed the safety snapshot');
        assert.strictEqual(Number((await dbAsync.get('SELECT post_parent FROM posts WHERE id = ?', [child.id])).post_parent), 0);
    });

    test('deleting one or all revisions removes their protected manifests atomically', async () => {
        const post = await Post.create({ authorId: 1, title: unique('delete-history'), status: 'draft' });
        const first = await saveRevision(post.id);
        const second = await saveRevision(post.id);
        assert.ok(await rawMeta(first, REVISION_SNAPSHOT_META_KEY));
        assert.strictEqual(await deleteRevision(first), true);
        assert.strictEqual(Number((await dbAsync.get('SELECT COUNT(*) AS c FROM post_meta WHERE post_id = ?', [first])).c), 0);
        assert.strictEqual(await deleteAllRevisions(post.id), 1);
        assert.strictEqual(Number((await dbAsync.get('SELECT COUNT(*) AS c FROM post_meta WHERE post_id = ?', [second])).c), 0);
    });
});
