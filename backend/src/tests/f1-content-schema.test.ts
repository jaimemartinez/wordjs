/** F1 declarative content schema: portability, compatibility, persistence and REST. */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const config = require('../config/app');
config.nodeEnv = 'test';
const TMP_DB = path.join(os.tmpdir(), `wjs-f1-schema-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const roles = require('../core/roles');
const { getOption, updateOption } = require('../core/options');
const postTypes = require('../core/post-types');
const {
    normalizeContentTypeSchema,
    legacyPostTypeToContentSchema,
} = require('../core/content-schema');
const { csrfProtection } = require('../middleware/auth');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(csrfProtection);
app.use('/api/v1', require('../routes'));

let dbAsync: any;
let adminId = 0;

function adminToken(): string {
    return jwt.sign({ userId: adminId, username: 'f1-admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
}

function schemaFor(name: string, label = 'Books'): any {
    const schema = legacyPostTypeToContentSchema(name, {
        label,
        supports: ['title', 'editor', 'author', 'excerpt', 'revisions'],
        taxonomies: ['category'],
        capability_type: name,
        showInRest: true,
        hasArchive: true,
    });
    schema.fields.isbn = {
        type: 'string', storage: { kind: 'meta', key: 'isbn' },
        required: false, multiple: false, revisioned: true,
        description: 'Portable book identifier.',
    };
    schema.revisions.fields.push('isbn');
    schema.extensions = { owner: 'f1-test' };
    return normalizeContentTypeSchema(schema);
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await postTypes.initPostTypes();
    await roles.loadRoles();
    const inserted = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        ['f1-admin', 'f1-admin@example.com', 'F1 Admin'],
    );
    adminId = inserted.lastID;
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [adminId]);
});

after(async () => {
    for (const name of ['f1_native', 'f1_legacy', 'f1_api', 'f1_api_legacy', 'f1_poison_good']) {
        postTypes.unregisterPostType(name);
    }
    try { const db = database.getDbAsync(); if (db?.close) await db.close(); } catch { /* cleanup */ }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(TMP_DB + suffix, { force: true }); } catch { /* cleanup */ }
    }
});

test('every built-in has one complete, defensive and JSON-portable F1 declaration', () => {
    const schemas = postTypes.getContentTypeSchemas({});
    assert.deepStrictEqual(
        schemas.filter((schema: any) => ['post', 'page', 'attachment', 'nav_menu_item', 'revision'].includes(schema.name))
            .map((schema: any) => schema.name).sort(),
        ['attachment', 'nav_menu_item', 'page', 'post', 'revision'],
    );
    for (const schema of schemas) {
        assert.strictEqual(schema.schemaVersion, 1);
        assert.strictEqual(schema.storage.discriminator.value, schema.name);
        assert.ok(schema.fields.status && schema.permissions.operations.edit && schema.revisions.codecVersion === 1);
        assert.deepStrictEqual(normalizeContentTypeSchema(JSON.parse(JSON.stringify(schema))), schema);
    }

    const first = postTypes.getContentTypeSchema('post');
    first.visibility.showInRest = false;
    first.fields.title.description = 'mutated by caller';
    const second = postTypes.getContentTypeSchema('post');
    assert.strictEqual(second.visibility.showInRest, true, 'read is a defensive copy');
    assert.notStrictEqual(second.fields.title.description, 'mutated by caller');
});

test('registerContentType projects fields, relationships, permissions and revisions to legacy consumers', () => {
    const schema = schemaFor('f1_native');
    const runtime = postTypes.registerContentType(schema);
    assert.strictEqual(runtime.name, 'f1_native');
    assert.strictEqual(runtime.label, 'Books');
    assert.deepStrictEqual(runtime.supports, ['title', 'editor', 'author', 'excerpt', 'revisions']);
    assert.deepStrictEqual(runtime.taxonomies, ['category']);
    assert.strictEqual(runtime.capability_type, 'f1_native');
    assert.strictEqual(postTypes.postTypeSupports('f1_native', 'editor'), true);

    const stored = postTypes.getContentTypeSchema('f1_native');
    assert.strictEqual(stored.fields.isbn.storage.kind, 'meta');
    assert.ok(stored.relationships.some((relation: any) => relation.kind === 'taxonomy' && relation.target === 'category'));
    assert.strictEqual(stored.permissions.operations.publish, 'publish_f1_natives');
    assert.ok(stored.revisions.enabled && stored.revisions.fields.includes('isbn'));
    assert.strictEqual(postTypes.unregisterPostType('f1_native'), true);
});

test('strict schemas fail closed on executable data, unsafe storage and inconsistent revisions', () => {
    const good = schemaFor('f1_native');
    assert.throws(
        () => normalizeContentTypeSchema({ ...good, extensions: { callback: () => true } }),
        /JSON values only/,
    );
    const badColumn = JSON.parse(JSON.stringify(good));
    badColumn.fields.isbn.storage = { kind: 'column', column: 'password_hash' };
    assert.throws(() => normalizeContentTypeSchema(badColumn), /declared posts-table column/);
    const badRevision = JSON.parse(JSON.stringify(good));
    badRevision.revisions.fields.push('doesNotExist');
    assert.throws(() => normalizeContentTypeSchema(badRevision), /unknown field/);
    const wrongDiscriminator = JSON.parse(JSON.stringify(good));
    wrongDiscriminator.storage.discriminator.value = 'another_type';
    assert.throws(() => normalizeContentTypeSchema(wrongDiscriminator), /schema.name/);
    assert.throws(() => normalizeContentTypeSchema({ ...good, surprise: true }), /unknown property/);
});

test('registerPostType preserves unknown legacy runtime keys without polluting the portable schema', () => {
    const extension = { provider: 'legacy-plugin', version: 1 };
    const callback = () => 'still runtime-compatible';
    const runtime = postTypes.registerPostType('f1_legacy', {
        label: 'Legacy Books', showInRest: false, capability_type: 'book',
        supports: ['title', 'editor'], extension, callback,
    });
    assert.strictEqual(runtime.extension, extension, 'legacy reference identity remains intact');
    assert.strictEqual(runtime.callback, callback);
    const schema = postTypes.getContentTypeSchema('f1_legacy');
    assert.deepStrictEqual(schema.extensions.extension, extension);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(schema.extensions, 'callback'), false);
    assert.doesNotThrow(() => JSON.stringify(schema));
    postTypes.unregisterPostType('f1_legacy');
});

test('native POST /types awaits dual persistence, exposes the schema, survives re-init and deletes both records', async () => {
    const schema = schemaFor('f1_api', 'API Books');
    const created = await request(app).post('/api/v1/types')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send(schema);
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    assert.strictEqual(created.body.name, 'f1_api');
    assert.ok(postTypes.getPostType('f1_api'), '201 is not sent before registration finishes');

    const schemaResponse = await request(app).get('/api/v1/types/f1_api/schema');
    assert.strictEqual(schemaResponse.status, 200);
    assert.strictEqual(schemaResponse.body.fields.isbn.storage.key, 'isbn');
    const list = await request(app).get('/api/v1/types/schemas');
    assert.ok(list.body.some((entry: any) => entry.name === 'f1_api'));

    const nativeStored = await getOption('custom_content_schemas', {});
    const legacyStored = await getOption('custom_post_types', {});
    assert.strictEqual(nativeStored.f1_api.schemaVersion, 1);
    assert.strictEqual(legacyStored.f1_api.name, 'f1_api', 'compatibility dual-write exists');

    postTypes.unregisterPostType('f1_api');
    assert.strictEqual(postTypes.postTypeExists('f1_api'), false);
    await postTypes.initPostTypes();
    assert.strictEqual(postTypes.getContentTypeSchema('f1_api').fields.isbn.storage.key, 'isbn');

    const deleted = await request(app).delete('/api/v1/types/f1_api')
        .set('Authorization', `Bearer ${adminToken()}`);
    assert.strictEqual(deleted.status, 200, JSON.stringify(deleted.body));
    assert.strictEqual(postTypes.postTypeExists('f1_api'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(await getOption('custom_content_schemas', {}), 'f1_api'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(await getOption('custom_post_types', {}), 'f1_api'), false);
});

test('legacy POST /types is awaited and gains a portable schema without changing its response shape', async () => {
    const created = await request(app).post('/api/v1/types')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({
            name: 'f1_api_legacy', label: 'Legacy API', supports: ['title', 'editor'],
            taxonomies: ['category'], capability_type: 'book', providerConfig: { version: 1 },
        });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    assert.strictEqual(created.body.name, 'f1_api_legacy');
    assert.strictEqual(created.body.label, 'Legacy API');
    assert.deepStrictEqual(created.body.providerConfig, { version: 1 });
    const schema = postTypes.getContentTypeSchema('f1_api_legacy');
    assert.strictEqual(schema.schemaVersion, 1);
    assert.deepStrictEqual(schema.extensions.providerConfig, { version: 1 });

    const deleted = await request(app).delete('/api/v1/types/f1_api_legacy')
        .set('Authorization', `Bearer ${adminToken()}`);
    assert.strictEqual(deleted.status, 200);
});

test('one poisoned persisted F1 entry cannot brick boot or hide a valid sibling', async () => {
    await updateOption('custom_content_schemas', {
        f1_poison_good: schemaFor('f1_poison_good', 'Good'),
        f1_poison_bad: { schemaVersion: 1, name: 'f1_poison_bad' },
    });
    await postTypes.initPostTypes();
    assert.ok(postTypes.getPostType('f1_poison_good'));
    assert.strictEqual(postTypes.getPostType('f1_poison_bad'), null);
    await postTypes.deleteCustomPostType('f1_poison_good');
    await updateOption('custom_content_schemas', {});
});
