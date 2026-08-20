const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { getBuiltinContentSchemas } = require('../core/content-schemas-builtins');
const {
    compileContentContract,
    buildContentOpenApiComponents,
} = require('../core/content-contract');
const postTypes = require('../core/post-types');
const {
    capsForType,
    canEditPostRecord,
    canDeletePostRecord,
    canReadPostRecord,
} = require('../core/post-capabilities');

const registered = new Set<string>();
afterEach(() => {
    for (const name of registered) postTypes.unregisterPostType(name);
    registered.clear();
});

function builtin(name: string) {
    const schema = getBuiltinContentSchemas().find((candidate: any) => candidate.name === name);
    assert.ok(schema, `missing built-in schema ${name}`);
    return schema;
}

function nativeSchema(name: string) {
    const schema = JSON.parse(JSON.stringify(builtin('post')));
    schema.name = name;
    schema.labels = { singular: name, plural: `${name}s`, addNew: `Add ${name}`, edit: `Edit ${name}` };
    schema.storage.discriminator.value = name;
    schema.presentation.rewrite.slug = name;
    return schema;
}

describe('F2 runtime contracts', () => {
    it('validates declared fields, enums, meta values and required create fields', () => {
        const contract = compileContentContract(builtin('post'));
        assert.deepStrictEqual(contract.validateCreate({ title: 'Ready', status: 'future', type: 'post' }), {
            ok: true,
            value: { title: 'Ready', status: 'future', type: 'post' },
        });

        const missing = contract.validateCreate({ status: 'draft' });
        assert.strictEqual(missing.ok, false);
        assert.ok(missing.issues.some((issue: any) => issue.path === 'title' && issue.code === 'required'));
        assert.strictEqual(contract.validateCreate({ title: null }).ok, false);

        const invalidEnum = contract.validateCreate({ title: 'Bad', status: 'scheduled' });
        assert.strictEqual(invalidEnum.ok, false);
        assert.ok(invalidEnum.issues.some((issue: any) => issue.path === 'status' && issue.code === 'enum'));

        assert.strictEqual(contract.validateCreate({ title: 'Media', meta: { _thumbnail_id: '42' } }).ok, true);
        assert.strictEqual(contract.validateCreate({ title: 'Clear media', meta: { _thumbnail_id: '' } }).ok, true,
            'the established REST media-clearing sentinel must remain valid');
        const invalidMeta = contract.validateCreate({ title: 'Media', meta: { _thumbnail_id: {} } });
        assert.strictEqual(invalidMeta.ok, false);
        assert.ok(invalidMeta.issues.some((issue: any) => issue.path === 'meta._thumbnail_id'));
        assert.ok((contract.createOpenApi as any).properties.meta.properties._thumbnail_id.oneOf
            .some((candidate: any) => Array.isArray(candidate.enum) && candidate.enum.includes('')),
        'OpenAPI must expose the same media-clearing sentinel as runtime');
    });

    it('keeps compatibility extension fields while enforcing the schema discriminator', () => {
        const contract = compileContentContract(builtin('page'));
        const extra = { title: 'Page', type: 'page', plugin_payload: { kept: true } };
        const accepted = contract.validateCreate(extra);
        assert.strictEqual(accepted.ok, true);
        assert.strictEqual(accepted.value, extra, 'the validator must not strip legacy/plugin extension fields');

        const wrongType = contract.validateCreate({ title: 'Page', type: 'post' });
        assert.strictEqual(wrongType.ok, false);
        assert.ok(wrongType.issues.some((issue: any) => issue.code === 'discriminator'));
        assert.strictEqual(contract.validateUpdate({}).ok, true);
        assert.strictEqual(contract.validateUpdate({ type: 'post' }).ok, false,
            'an update discriminator may not contradict the record selected by the URL');
    });

    it('rejects cyclic or prototype-bearing JSON in a declared JSON meta field', () => {
        const schema = nativeSchema('f2_json');
        schema.fields.settings = {
            type: 'json', storage: { kind: 'meta', key: 'settings' }, required: false,
            multiple: false, revisioned: false, description: 'JSON settings.',
        };
        const contract = compileContentContract(schema);
        const cycle: any = {};
        cycle.self = cycle;
        assert.strictEqual(contract.validateCreate({ title: 'Cycle', meta: { settings: cycle } }).ok, false);
        const poisoned = JSON.parse('{"__proto__":{"polluted":true}}');
        assert.strictEqual(contract.validateCreate({ title: 'Poison', meta: { settings: poisoned } }).ok, false);
    });

    it('enforces required declared meta fields as well as direct columns', () => {
        const schema = nativeSchema('f2_required_meta');
        schema.fields.externalId = {
            type: 'string', storage: { kind: 'meta', key: 'external_id' }, required: true,
            multiple: false, revisioned: false, description: 'Required external identifier.',
        };
        const contract = compileContentContract(schema);
        const openApi = contract.createOpenApi as any;
        const missing = contract.validateCreate({ title: 'Missing' });
        assert.strictEqual(missing.ok, false);
        assert.ok(missing.issues.some((issue: any) => issue.path === 'meta.external_id' && issue.code === 'required'));
        assert.strictEqual(contract.validateCreate({ title: 'Null', meta: { external_id: null } }).ok, false);
        assert.strictEqual(contract.validateCreate({ title: 'Present', meta: { external_id: 'abc' } }).ok, true);
        assert.ok(openApi.required.includes('meta'));
        assert.ok(openApi.properties.meta.required.includes('external_id'));
    });

    it('keeps numeric strings decimal in both runtime and OpenAPI', () => {
        const schema = nativeSchema('f2_number');
        schema.fields.score = {
            type: 'number', storage: { kind: 'meta', key: 'score' }, required: false,
            multiple: false, revisioned: false, description: 'Decimal score.',
        };
        const contract = compileContentContract(schema);
        assert.strictEqual(contract.validateCreate({ title: 'Decimal', meta: { score: '1.25e2' } }).ok, true);
        assert.strictEqual(contract.validateCreate({ title: 'Hex', meta: { score: '0x10' } }).ok, false);
        assert.ok((contract.createOpenApi as any).properties.meta.properties.score.oneOf
            .some((candidate: any) => candidate.type === 'string' && candidate.pattern));
    });

    it('compares JSON enum values structurally instead of by object identity', () => {
        const schema = nativeSchema('f2_enum_object');
        schema.fields.mode = {
            type: 'enum', storage: { kind: 'meta', key: 'mode' }, required: false,
            multiple: false, revisioned: false, description: 'Structured mode.',
            enum: [{ mode: 'strict', level: 2 }],
        };
        const contract = compileContentContract(schema);
        assert.strictEqual(contract.validateCreate({
            title: 'Structural', meta: { mode: { level: 2, mode: 'strict' } },
        }).ok, true);
        assert.strictEqual(contract.validateCreate({
            title: 'Different', meta: { mode: { level: 3, mode: 'strict' } },
        }).ok, false);
    });
});

describe('F2 generated policies', () => {
    it('uses every explicitly declared operation instead of reconstructing capability names', () => {
        const schema = nativeSchema('f2_policy');
        schema.permissions.capabilityType = 'article';
        schema.permissions.operations = {
            create: 'f2_create', edit: 'f2_edit', publish: 'f2_publish', delete: 'f2_delete',
            editPublished: 'f2_edit_live', deletePublished: 'f2_delete_live',
            editOthers: 'f2_edit_others', deleteOthers: 'f2_delete_others',
        };
        postTypes.registerContentType(schema);
        registered.add(schema.name);

        const policy = capsForType(schema.name);
        assert.deepStrictEqual({
            create: policy.create, edit: policy.edit, publish: policy.publish, del: policy.del,
            editPublished: policy.editPublished, deletePublished: policy.deletePublished,
            editOthers: policy.editOthers, deleteOthers: policy.deleteOthers,
        }, {
            create: 'f2_create', edit: 'f2_edit', publish: 'f2_publish', del: 'f2_delete',
            editPublished: 'f2_edit_live', deletePublished: 'f2_delete_live',
            editOthers: 'f2_edit_others', deleteOthers: 'f2_delete_others',
        });

        const grants = new Set(['f2_edit', 'f2_delete']);
        const user = { id: 7, can: (capability: string) => grants.has(capability) };
        const draft = { type: schema.name, authorId: 7, postStatus: 'draft' };
        const live = { ...draft, postStatus: 'publish' };
        assert.strictEqual(canEditPostRecord(user, draft), true);
        assert.strictEqual(canDeletePostRecord(user, draft), true);
        assert.strictEqual(canReadPostRecord(undefined, { ...draft, postStatus: 'publish' }), true);
        assert.strictEqual(canReadPostRecord(user, { ...draft, authorId: 99 }), false);
        assert.strictEqual(canEditPostRecord(user, live), false);
        assert.strictEqual(canDeletePostRecord(user, live), false);
        grants.add('f2_edit_live');
        grants.add('f2_delete_live');
        grants.add('f2_edit_others');
        assert.strictEqual(canEditPostRecord(user, live), true);
        assert.strictEqual(canDeletePostRecord(user, live), true);
        assert.strictEqual(canReadPostRecord(user, { ...draft, authorId: 99 }), true);
    });

    it('does not publish a REST-exposed type whose schema declares public:false', () => {
        const schema = nativeSchema('f2_private');
        schema.visibility.public = false;
        postTypes.registerContentType(schema);
        registered.add(schema.name);
        const live = { type: schema.name, authorId: 7, postStatus: 'publish' };
        assert.strictEqual(canReadPostRecord(undefined, live), false);
        assert.strictEqual(canReadPostRecord({ id: 7, can: () => false }, live), true);
    });
});

describe('F2 OpenAPI, DTO and client generation', () => {
    it('projects per-type schemas and generic request unions from F1', () => {
        const components = buildContentOpenApiComponents(getBuiltinContentSchemas()) as any;
        assert.ok(components.ContentPostCreateInput);
        assert.ok(components.ContentPageUpdateInput);
        assert.ok(components.ContentPostCreateInput.properties.status.enum.includes('future'));
        assert.ok(components.ContentPageCreateInput.properties.parent);
        assert.ok(components.ContentCreateInput.oneOf.some((ref: any) =>
            ref.$ref === '#/components/schemas/ContentPostCreateInput'));
        assert.ok(Array.isArray(components.ContentUpdateInput.anyOf));
        assert.strictEqual(components.ContentUpdateInput.oneOf, undefined,
            'partial updates overlap when type is omitted and must not use oneOf');

        const collisionComponents = buildContentOpenApiComponents([
            nativeSchema('f2-dash'), nativeSchema('f2_dash'),
        ]) as any;
        const customCreates = Object.keys(collisionComponents)
            .filter((name) => name.endsWith('CreateInput') && name !== 'ContentCreateInput');
        assert.strictEqual(customCreates.length, 2, 'separator-distinct schema names need distinct components');
    });

    it('injects generated DTO refs into the real Swagger document', () => {
        const specs = require('../config/swagger');
        assert.strictEqual(
            specs.paths['/posts'].post.requestBody.content['application/json'].schema.$ref,
            '#/components/schemas/ContentCreateInput',
        );
        assert.strictEqual(
            specs.paths['/posts/{id}'].put.requestBody.content['application/json'].schema.$ref,
            '#/components/schemas/ContentUpdateInput',
        );
        assert.ok(specs.components.schemas.ContentValidationError);
    });

    it('keeps generated artifacts typed and the public content handlers free of req:any', () => {
        const backendGenerated = fs.readFileSync(path.join(__dirname, '..', 'generated', 'content-dtos.generated.ts'), 'utf8');
        const frontendGenerated = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'frontend', 'src', 'lib', 'generated', 'content-client.generated.ts'), 'utf8');
        const postsRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'posts.ts'), 'utf8');
        const frontendApi = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'frontend', 'src', 'lib', 'api.ts'), 'utf8');
        assert.doesNotMatch(backendGenerated, /\bany\b/);
        assert.doesNotMatch(frontendGenerated, /\bany\b/);
        assert.match(backendGenerated, /interface ContentPostCreateInput/);
        assert.match(frontendGenerated, /type CoreContentCreateInput = ContentAttachmentCreateInput \| ContentPageCreateInput \| ContentPostCreateInput/);
        assert.match(backendGenerated, /language\?: string \| null/);
        assert.doesNotMatch(postsRoute, /\breq\s*:\s*any\b/);
        assert.match(postsRoute, /validateCreate/);
        assert.match(postsRoute, /validateUpdate/);
        assert.match(frontendApi, /createContentClient/);
        assert.doesNotMatch(frontendApi, /export interface Post\b/);
    });
});
