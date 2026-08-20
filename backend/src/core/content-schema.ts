/**
 * F1 declarative content-type contract.
 *
 * This module is deliberately pure: it does not touch the database, hooks or the
 * in-memory registry. It validates the serialisable contract and projects it to
 * the historical registerPostType() shape. F2 can therefore generate DTOs,
 * OpenAPI and clients from the same data without importing runtime state.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ContentFieldType =
    | 'string' | 'text' | 'rich-text' | 'integer' | 'number' | 'boolean'
    | 'datetime' | 'slug' | 'email' | 'url' | 'json' | 'media' | 'reference' | 'enum';

export type ContentFieldStorage =
    | { kind: 'column'; column: string }
    | { kind: 'meta'; key: string }
    | { kind: 'computed' };

export interface ContentFieldSchema {
    type: ContentFieldType;
    storage: ContentFieldStorage;
    required: boolean;
    multiple: boolean;
    revisioned: boolean;
    description: string;
    default?: JsonValue;
    enum?: JsonValue[];
}

export type ContentRelationshipStorage =
    | { kind: 'column'; column: string }
    | { kind: 'taxonomy'; taxonomy: string }
    | { kind: 'foreign-key'; table: string; column: string };

export interface ContentRelationshipSchema {
    name: string;
    kind: 'belongs-to' | 'has-many' | 'taxonomy' | 'many-to-many';
    target: string;
    multiple: boolean;
    storage: ContentRelationshipStorage;
}

export interface ContentTypeSchemaV1 {
    schemaVersion: 1;
    name: string;
    labels: { singular: string; plural: string; addNew: string; edit: string };
    description: string;
    visibility: {
        public: boolean;
        showInMenu: boolean;
        showInRest: boolean;
        hasArchive: boolean;
        hierarchical: boolean;
    };
    features: string[];
    fields: Record<string, ContentFieldSchema>;
    relationships: ContentRelationshipSchema[];
    storage: {
        engine: 'posts';
        table: 'posts';
        discriminator: { column: 'post_type'; value: string };
        metaTable: 'post_meta';
    };
    permissions: {
        capabilityType: string;
        operations: Record<string, string>;
    };
    revisions: {
        enabled: boolean;
        strategy: 'snapshot';
        codecVersion: number;
        fields: string[];
        metaKeys: string[];
    };
    presentation: {
        menuIcon: string;
        menuPosition: number;
        rewrite: { slug: string };
    };
    extensions: Record<string, JsonValue>;
}

type UnknownRecord = Record<string, unknown>;

const CONTENT_TYPE_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const FIELD_NAME_RE = /^[a-z][a-zA-Z0-9_.-]{0,63}$/;
const META_KEY_RE = /^[_a-zA-Z0-9][-_a-zA-Z0-9.:]{0,127}$/;
const CAPABILITY_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const CAPABILITY_NAME_RE = /^[a-z][a-z0-9_]{0,127}$/;
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const FIELD_TYPES = new Set<ContentFieldType>([
    'string', 'text', 'rich-text', 'integer', 'number', 'boolean', 'datetime',
    'slug', 'email', 'url', 'json', 'media', 'reference', 'enum',
]);
const RELATIONSHIP_KINDS = new Set(['belongs-to', 'has-many', 'taxonomy', 'many-to-many']);
const POST_COLUMNS = new Set([
    'ID', 'post_author', 'post_date', 'post_date_gmt', 'post_content', 'post_title',
    'post_excerpt', 'post_status', 'comment_status', 'ping_status', 'post_password',
    'post_name', 'post_modified', 'post_modified_gmt', 'post_parent', 'guid',
    'menu_order', 'post_type', 'post_mime_type', 'comment_count', 'post_language',
    'translation_group',
]);
const RELATION_TABLE_COLUMNS: Record<string, Set<string>> = {
    comments: new Set(['comment_post_ID']),
    term_relationships: new Set(['object_id', 'term_taxonomy_id']),
    posts: POST_COLUMNS,
    users: new Set(['ID']),
};
const OPERATION_KEYS = [
    'create', 'edit', 'publish', 'delete', 'editPublished', 'deletePublished',
    'editOthers', 'deleteOthers',
] as const;
const TOP_LEVEL_KEYS = new Set([
    'schemaVersion', 'name', 'labels', 'description', 'visibility', 'features',
    'fields', 'relationships', 'storage', 'permissions', 'revisions',
    'presentation', 'extensions',
]);
const LEGACY_KEYS = new Set([
    'name', 'label', 'labels', 'description', 'public', 'showInMenu', 'showInRest',
    'hasArchive', 'hierarchical', 'supports', 'taxonomies', 'menuIcon',
    'menuPosition', 'rewrite', 'capability_type',
]);

function isPlainRecord(value: unknown): value is UnknownRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function fail(path: string, message: string): never {
    throw new Error(`content schema ${path}: ${message}`);
}

function own(record: UnknownRecord, key: string): unknown {
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function requireRecord(value: unknown, path: string): UnknownRecord {
    if (!isPlainRecord(value)) fail(path, 'must be a plain object');
    return value;
}

function rejectUnknownKeys(record: UnknownRecord, allowed: ReadonlySet<string>, path: string): void {
    for (const key of Object.keys(record)) {
        if (DANGEROUS_KEYS.has(key)) fail(`${path}.${key}`, 'unsafe object key');
        if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown property; use extensions for namespaced data');
    }
}

function requiredString(value: unknown, path: string, max = 512): string {
    if (typeof value !== 'string' || !value.trim()) fail(path, 'must be a non-empty string');
    if (value.length > max) fail(path, `must be at most ${max} characters`);
    return value;
}

function booleanValue(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') fail(path, 'must be a boolean');
    return value;
}

function boundedInteger(value: unknown, path: string, min: number, max: number): number {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
        fail(path, `must be an integer between ${min} and ${max}`);
    }
    return value as number;
}

function safeName(value: unknown, path = 'name'): string {
    const name = requiredString(value, path, 32);
    if (!CONTENT_TYPE_NAME_RE.test(name) || DANGEROUS_KEYS.has(name)) {
        fail(path, 'must be a lowercase slug starting with a letter (max 32 characters)');
    }
    return name;
}

function safeFieldName(value: unknown, path: string): string {
    const name = requiredString(value, path, 64);
    if (!FIELD_NAME_RE.test(name) || DANGEROUS_KEYS.has(name)) fail(path, 'has an invalid field name');
    return name;
}

function safeMetaKey(value: unknown, path: string): string {
    const key = requiredString(value, path, 128);
    if (!META_KEY_RE.test(key) || DANGEROUS_KEYS.has(key)) fail(path, 'has an invalid metadata key');
    return key;
}

function jsonClone(value: unknown, path: string, depth = 0, budget = { nodes: 0 }): JsonValue {
    budget.nodes++;
    if (budget.nodes > 4096) fail(path, 'exceeds the 4096-node JSON budget');
    if (depth > 16) fail(path, 'exceeds the maximum JSON depth of 16');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        if (typeof value === 'string' && value.length > 65_536) fail(path, 'string exceeds 65536 characters');
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) fail(path, 'numbers must be finite');
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length > 1024) fail(path, 'array exceeds 1024 entries');
        return value.map((entry, index) => jsonClone(entry, `${path}[${index}]`, depth + 1, budget));
    }
    if (!isPlainRecord(value)) fail(path, 'must contain JSON values only');
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
        if (DANGEROUS_KEYS.has(key)) fail(`${path}.${key}`, 'unsafe object key');
        output[key] = jsonClone(value[key], `${path}.${key}`, depth + 1, budget);
    }
    return output;
}

function stringList(value: unknown, path: string, max: number, validator?: (entry: string, path: string) => string): string[] {
    if (!Array.isArray(value)) fail(path, 'must be an array');
    if (value.length > max) fail(path, `must contain at most ${max} entries`);
    const result: string[] = [];
    const seen = new Set<string>();
    value.forEach((entry, index) => {
        const itemPath = `${path}[${index}]`;
        const normalized = validator
            ? validator(requiredString(entry, itemPath, 128), itemPath)
            : requiredString(entry, itemPath, 128);
        if (!seen.has(normalized)) {
            seen.add(normalized);
            result.push(normalized);
        }
    });
    return result;
}

function operationsFor(capabilityType: string): Record<string, string> {
    return {
        create: `edit_${capabilityType}s`,
        edit: `edit_${capabilityType}s`,
        publish: `publish_${capabilityType}s`,
        delete: `delete_${capabilityType}s`,
        editPublished: `edit_published_${capabilityType}s`,
        deletePublished: `delete_published_${capabilityType}s`,
        editOthers: `edit_others_${capabilityType}s`,
        deleteOthers: `delete_others_${capabilityType}s`,
    };
}

function normalizeLabels(value: unknown, name: string): ContentTypeSchemaV1['labels'] {
    const labels = requireRecord(value, 'labels');
    rejectUnknownKeys(labels, new Set(['singular', 'plural', 'addNew', 'edit']), 'labels');
    const singular = requiredString(own(labels, 'singular'), 'labels.singular');
    const plural = requiredString(own(labels, 'plural'), 'labels.plural');
    return {
        singular,
        plural,
        addNew: requiredString(own(labels, 'addNew'), 'labels.addNew'),
        edit: requiredString(own(labels, 'edit'), 'labels.edit'),
    };
}

function normalizeFieldStorage(value: unknown, path: string): ContentFieldStorage {
    const storage = requireRecord(value, path);
    const kind = own(storage, 'kind');
    if (kind === 'computed') {
        rejectUnknownKeys(storage, new Set(['kind']), path);
        return { kind };
    }
    if (kind === 'column') {
        rejectUnknownKeys(storage, new Set(['kind', 'column']), path);
        const column = requiredString(own(storage, 'column'), `${path}.column`, 64);
        if (!POST_COLUMNS.has(column)) fail(`${path}.column`, 'is not a declared posts-table column');
        return { kind, column };
    }
    if (kind === 'meta') {
        rejectUnknownKeys(storage, new Set(['kind', 'key']), path);
        return { kind, key: safeMetaKey(own(storage, 'key'), `${path}.key`) };
    }
    return fail(`${path}.kind`, 'must be column, meta or computed');
}

function normalizeFields(value: unknown): Record<string, ContentFieldSchema> {
    const fields = requireRecord(value, 'fields');
    const names = Object.keys(fields);
    if (names.length > 128) fail('fields', 'must contain at most 128 fields');
    const output: Record<string, ContentFieldSchema> = {};
    for (const rawName of names) {
        const name = safeFieldName(rawName, `fields.${rawName}`);
        const path = `fields.${name}`;
        const field = requireRecord(fields[rawName], path);
        rejectUnknownKeys(field, new Set([
            'type', 'storage', 'required', 'multiple', 'revisioned', 'description', 'default', 'enum',
        ]), path);
        const type = own(field, 'type');
        if (typeof type !== 'string' || !FIELD_TYPES.has(type as ContentFieldType)) {
            fail(`${path}.type`, 'is not a supported field type');
        }
        const normalized: ContentFieldSchema = {
            type: type as ContentFieldType,
            storage: normalizeFieldStorage(own(field, 'storage'), `${path}.storage`),
            required: booleanValue(own(field, 'required'), `${path}.required`),
            multiple: booleanValue(own(field, 'multiple'), `${path}.multiple`),
            revisioned: booleanValue(own(field, 'revisioned'), `${path}.revisioned`),
            description: requiredString(own(field, 'description'), `${path}.description`, 2048),
        };
        if (Object.prototype.hasOwnProperty.call(field, 'default')) {
            normalized.default = jsonClone(field.default, `${path}.default`);
        }
        if (Object.prototype.hasOwnProperty.call(field, 'enum')) {
            if (!Array.isArray(field.enum) || field.enum.length === 0 || field.enum.length > 128) {
                fail(`${path}.enum`, 'must contain between 1 and 128 JSON values');
            }
            normalized.enum = field.enum.map((entry, index) => jsonClone(entry, `${path}.enum[${index}]`));
        }
        if (type === 'enum' && !normalized.enum) fail(`${path}.enum`, 'is required for enum fields');
        output[name] = normalized;
    }
    return output;
}

function normalizeRelationshipStorage(value: unknown, path: string): ContentRelationshipStorage {
    const storage = requireRecord(value, path);
    const kind = own(storage, 'kind');
    if (kind === 'column') {
        rejectUnknownKeys(storage, new Set(['kind', 'column']), path);
        const column = requiredString(own(storage, 'column'), `${path}.column`, 64);
        if (!POST_COLUMNS.has(column)) fail(`${path}.column`, 'is not a declared posts-table column');
        return { kind, column };
    }
    if (kind === 'taxonomy') {
        rejectUnknownKeys(storage, new Set(['kind', 'taxonomy']), path);
        const taxonomy = requiredString(own(storage, 'taxonomy'), `${path}.taxonomy`, 32);
        if (!SAFE_SLUG_RE.test(taxonomy) || DANGEROUS_KEYS.has(taxonomy)) fail(`${path}.taxonomy`, 'has an invalid taxonomy slug');
        return { kind, taxonomy };
    }
    if (kind === 'foreign-key') {
        rejectUnknownKeys(storage, new Set(['kind', 'table', 'column']), path);
        const table = requiredString(own(storage, 'table'), `${path}.table`, 64);
        const column = requiredString(own(storage, 'column'), `${path}.column`, 64);
        const columns = RELATION_TABLE_COLUMNS[table];
        if (!columns || !columns.has(column)) fail(path, 'is not an allowlisted relationship table/column');
        return { kind, table, column };
    }
    return fail(`${path}.kind`, 'must be column, taxonomy or foreign-key');
}

function normalizeRelationships(value: unknown): ContentRelationshipSchema[] {
    if (!Array.isArray(value)) fail('relationships', 'must be an array');
    if (value.length > 64) fail('relationships', 'must contain at most 64 relationships');
    const names = new Set<string>();
    return value.map((entry, index) => {
        const path = `relationships[${index}]`;
        const relationship = requireRecord(entry, path);
        rejectUnknownKeys(relationship, new Set(['name', 'kind', 'target', 'multiple', 'storage']), path);
        const name = safeFieldName(own(relationship, 'name'), `${path}.name`);
        if (names.has(name)) fail(`${path}.name`, 'duplicates another relationship');
        names.add(name);
        const kind = own(relationship, 'kind');
        if (typeof kind !== 'string' || !RELATIONSHIP_KINDS.has(kind)) fail(`${path}.kind`, 'is not supported');
        const target = requiredString(own(relationship, 'target'), `${path}.target`, 64);
        if (!SAFE_SLUG_RE.test(target) || DANGEROUS_KEYS.has(target)) fail(`${path}.target`, 'has an invalid target');
        const storage = normalizeRelationshipStorage(own(relationship, 'storage'), `${path}.storage`);
        if (kind === 'taxonomy' && storage.kind !== 'taxonomy') fail(`${path}.storage`, 'taxonomy relationships require taxonomy storage');
        return {
            name,
            kind: kind as ContentRelationshipSchema['kind'],
            target,
            multiple: booleanValue(own(relationship, 'multiple'), `${path}.multiple`),
            storage,
        };
    });
}

export function normalizeContentTypeSchema(value: unknown): ContentTypeSchemaV1 {
    const schema = requireRecord(value, '<root>');
    rejectUnknownKeys(schema, TOP_LEVEL_KEYS, '<root>');
    if (own(schema, 'schemaVersion') !== 1) fail('schemaVersion', 'must equal 1');
    const name = safeName(own(schema, 'name'));
    const visibility = requireRecord(own(schema, 'visibility'), 'visibility');
    rejectUnknownKeys(visibility, new Set(['public', 'showInMenu', 'showInRest', 'hasArchive', 'hierarchical']), 'visibility');
    const storage = requireRecord(own(schema, 'storage'), 'storage');
    rejectUnknownKeys(storage, new Set(['engine', 'table', 'discriminator', 'metaTable']), 'storage');
    if (own(storage, 'engine') !== 'posts' || own(storage, 'table') !== 'posts' || own(storage, 'metaTable') !== 'post_meta') {
        fail('storage', 'F1 supports only the posts/post_meta storage engine');
    }
    const discriminator = requireRecord(own(storage, 'discriminator'), 'storage.discriminator');
    rejectUnknownKeys(discriminator, new Set(['column', 'value']), 'storage.discriminator');
    if (own(discriminator, 'column') !== 'post_type' || own(discriminator, 'value') !== name) {
        fail('storage.discriminator', 'must be { column: "post_type", value: schema.name }');
    }

    const fields = normalizeFields(own(schema, 'fields'));
    const relationships = normalizeRelationships(own(schema, 'relationships'));
    const permissions = requireRecord(own(schema, 'permissions'), 'permissions');
    rejectUnknownKeys(permissions, new Set(['capabilityType', 'operations']), 'permissions');
    const capabilityType = requiredString(own(permissions, 'capabilityType'), 'permissions.capabilityType', 64);
    if (!CAPABILITY_TYPE_RE.test(capabilityType)) fail('permissions.capabilityType', 'has an invalid capability family');
    const operations = requireRecord(own(permissions, 'operations'), 'permissions.operations');
    rejectUnknownKeys(operations, new Set(OPERATION_KEYS), 'permissions.operations');
    const normalizedOperations: Record<string, string> = {};
    for (const key of OPERATION_KEYS) {
        const capability = requiredString(own(operations, key), `permissions.operations.${key}`, 128);
        if (!CAPABILITY_NAME_RE.test(capability)) fail(`permissions.operations.${key}`, 'has an invalid capability');
        normalizedOperations[key] = capability;
    }

    const revisions = requireRecord(own(schema, 'revisions'), 'revisions');
    rejectUnknownKeys(revisions, new Set(['enabled', 'strategy', 'codecVersion', 'fields', 'metaKeys']), 'revisions');
    if (own(revisions, 'strategy') !== 'snapshot') fail('revisions.strategy', 'must equal snapshot');
    const revisionFields = stringList(own(revisions, 'fields'), 'revisions.fields', 128, safeFieldName);
    for (const field of revisionFields) {
        if (!Object.prototype.hasOwnProperty.call(fields, field)) fail('revisions.fields', `references unknown field ${field}`);
    }

    const presentation = requireRecord(own(schema, 'presentation'), 'presentation');
    rejectUnknownKeys(presentation, new Set(['menuIcon', 'menuPosition', 'rewrite']), 'presentation');
    const rewrite = requireRecord(own(presentation, 'rewrite'), 'presentation.rewrite');
    rejectUnknownKeys(rewrite, new Set(['slug']), 'presentation.rewrite');
    const rewriteSlug = requiredString(own(rewrite, 'slug'), 'presentation.rewrite.slug', 128);
    if (!SAFE_SLUG_RE.test(rewriteSlug)) fail('presentation.rewrite.slug', 'has an invalid slug');

    const extensionValue = jsonClone(own(schema, 'extensions'), 'extensions');
    if (!isPlainRecord(extensionValue)) fail('extensions', 'must be a JSON object');

    return {
        schemaVersion: 1,
        name,
        labels: normalizeLabels(own(schema, 'labels'), name),
        description: typeof own(schema, 'description') === 'string'
            ? String(own(schema, 'description')).slice(0, 4096)
            : fail('description', 'must be a string'),
        visibility: {
            public: booleanValue(own(visibility, 'public'), 'visibility.public'),
            showInMenu: booleanValue(own(visibility, 'showInMenu'), 'visibility.showInMenu'),
            showInRest: booleanValue(own(visibility, 'showInRest'), 'visibility.showInRest'),
            hasArchive: booleanValue(own(visibility, 'hasArchive'), 'visibility.hasArchive'),
            hierarchical: booleanValue(own(visibility, 'hierarchical'), 'visibility.hierarchical'),
        },
        features: stringList(own(schema, 'features'), 'features', 64, safeFieldName),
        fields,
        relationships,
        storage: {
            engine: 'posts', table: 'posts',
            discriminator: { column: 'post_type', value: name },
            metaTable: 'post_meta',
        },
        permissions: { capabilityType, operations: normalizedOperations },
        revisions: {
            enabled: booleanValue(own(revisions, 'enabled'), 'revisions.enabled'),
            strategy: 'snapshot',
            codecVersion: boundedInteger(own(revisions, 'codecVersion'), 'revisions.codecVersion', 1, 1_000_000),
            fields: revisionFields,
            metaKeys: stringList(own(revisions, 'metaKeys'), 'revisions.metaKeys', 128, safeMetaKey),
        },
        presentation: {
            menuIcon: requiredString(own(presentation, 'menuIcon'), 'presentation.menuIcon', 128),
            menuPosition: boundedInteger(own(presentation, 'menuPosition'), 'presentation.menuPosition', 0, 10_000),
            rewrite: { slug: rewriteSlug },
        },
        extensions: extensionValue as Record<string, JsonValue>,
    };
}

function field(
    type: ContentFieldType,
    storage: ContentFieldStorage,
    description: string,
    revisioned = false,
    extra: Partial<ContentFieldSchema> = {},
): ContentFieldSchema {
    return {
        type, storage, description, revisioned,
        required: false, multiple: false,
        ...extra,
    };
}

/** Field declarations shared by built-ins and the legacy adapter. */
export function fieldsForFeatures(features: string[]): Record<string, ContentFieldSchema> {
    const enabled = new Set(features);
    const fields: Record<string, ContentFieldSchema> = {
        status: field('enum', { kind: 'column', column: 'post_status' }, 'Publication lifecycle state.', true, {
            required: true, default: 'draft',
            enum: ['draft', 'publish', 'future', 'private', 'pending', 'trash', 'inherit', 'auto-draft'],
        }),
        slug: field('slug', { kind: 'column', column: 'post_name' }, 'Stable URL slug.', true),
        date: field('datetime', { kind: 'column', column: 'post_date' }, 'Publication date.'),
        modified: field('datetime', { kind: 'column', column: 'post_modified' }, 'Last modification date.'),
        language: field('string', { kind: 'column', column: 'post_language' }, 'BCP-47 content language.'),
    };
    if (enabled.has('title')) {
        fields.title = field('string', { kind: 'column', column: 'post_title' }, 'Editorial title.', true, { required: true });
    }
    if (enabled.has('editor')) fields.content = field('rich-text', { kind: 'column', column: 'post_content' }, 'Primary document content.', true);
    if (enabled.has('author')) fields.authorId = field('reference', { kind: 'column', column: 'post_author' }, 'Owning user identifier.');
    if (enabled.has('thumbnail')) fields.thumbnailId = field('media', { kind: 'meta', key: '_thumbnail_id' }, 'Featured media identifier.');
    if (enabled.has('excerpt')) fields.excerpt = field('text', { kind: 'column', column: 'post_excerpt' }, 'Editorial summary.', true);
    if (enabled.has('comments')) fields.commentStatus = field('enum', { kind: 'column', column: 'comment_status' }, 'Comment availability.', false, { enum: ['open', 'closed'] });
    if (enabled.has('page-attributes')) {
        fields.parentId = field('reference', { kind: 'column', column: 'post_parent' }, 'Parent content identifier.', true);
        fields.order = field('integer', { kind: 'column', column: 'menu_order' }, 'Sibling ordering value.', true, { default: 0 });
    }
    return fields;
}

/** Relationship declarations inferred by the compatibility adapter. */
export function relationshipsForLegacy(features: string[], taxonomies: string[]): ContentRelationshipSchema[] {
    const relationships: ContentRelationshipSchema[] = [];
    if (features.includes('author')) {
        relationships.push({ name: 'author', kind: 'belongs-to', target: 'user', multiple: false, storage: { kind: 'column', column: 'post_author' } });
    }
    if (features.includes('comments')) {
        relationships.push({ name: 'comments', kind: 'has-many', target: 'comment', multiple: true, storage: { kind: 'foreign-key', table: 'comments', column: 'comment_post_ID' } });
    }
    if (features.includes('page-attributes')) {
        relationships.push({ name: 'parent', kind: 'belongs-to', target: 'post', multiple: false, storage: { kind: 'column', column: 'post_parent' } });
    }
    for (const taxonomy of taxonomies) {
        relationships.push({ name: taxonomy, kind: 'taxonomy', target: taxonomy, multiple: true, storage: { kind: 'taxonomy', taxonomy } });
    }
    return relationships;
}

function legacyLabels(name: string, args: UnknownRecord): ContentTypeSchemaV1['labels'] {
    const label = typeof args.label === 'string' && args.label ? args.label : name;
    const labels = isPlainRecord(args.labels) ? args.labels : {};
    return {
        singular: typeof labels.singular === 'string' && labels.singular ? labels.singular : label,
        plural: typeof labels.plural === 'string' && labels.plural ? labels.plural : label,
        addNew: typeof labels.addNew === 'string' && labels.addNew ? labels.addNew : `Add New ${label}`,
        edit: typeof labels.edit === 'string' && labels.edit ? labels.edit : `Edit ${label}`,
    };
}

export interface LegacyContentTypeAdaptation {
    schema: ContentTypeSchemaV1;
    runtimeExtensions: UnknownRecord;
}

/**
 * Convert the permissive historical API to F1. Unknown keys remain on the
 * runtime object by reference. Only their JSON-safe subset enters the schema.
 */
export function adaptLegacyPostType(nameValue: unknown, argsValue: unknown = {}): LegacyContentTypeAdaptation {
    const name = safeName(nameValue);
    const args = requireRecord(argsValue, 'legacy options');
    const features = Array.isArray(args.supports)
        ? args.supports.filter((item): item is string => typeof item === 'string' && FIELD_NAME_RE.test(item)).slice(0, 64)
        : ['title', 'editor'];
    const taxonomies = Array.isArray(args.taxonomies)
        ? args.taxonomies.filter((item): item is string => typeof item === 'string' && SAFE_SLUG_RE.test(item)).slice(0, 64)
        : [];
    const capabilityType = typeof args.capability_type === 'string' && CAPABILITY_TYPE_RE.test(args.capability_type)
        ? args.capability_type : 'post';
    const runtimeExtensions: UnknownRecord = {};
    const serialisableExtensions: Record<string, JsonValue> = {};
    for (const key of Object.keys(args)) {
        if (LEGACY_KEYS.has(key) || DANGEROUS_KEYS.has(key)) continue;
        runtimeExtensions[key] = args[key];
        try {
            serialisableExtensions[key] = jsonClone(args[key], `legacy.${key}`);
        } catch {
            // Compatibility: runtime-only legacy data keeps working, but it can
            // never enter the portable schema or the isolated plugin bridge.
        }
    }
    const fields = fieldsForFeatures(features);
    const revisionFields = Object.entries(fields).filter(([, definition]) => definition.revisioned).map(([fieldName]) => fieldName);
    const schema: ContentTypeSchemaV1 = {
        schemaVersion: 1,
        name,
        labels: legacyLabels(name, args),
        description: typeof args.description === 'string' ? args.description.slice(0, 4096) : '',
        visibility: {
            public: args.public !== false,
            showInMenu: args.showInMenu !== false,
            showInRest: args.showInRest !== false,
            hasArchive: args.hasArchive === true,
            hierarchical: args.hierarchical === true,
        },
        features: [...new Set(features)],
        fields,
        relationships: relationshipsForLegacy(features, taxonomies),
        storage: { engine: 'posts', table: 'posts', discriminator: { column: 'post_type', value: name }, metaTable: 'post_meta' },
        permissions: { capabilityType, operations: operationsFor(capabilityType) },
        revisions: {
            enabled: features.includes('revisions'), strategy: 'snapshot', codecVersion: 1,
            fields: revisionFields,
            metaKeys: features.includes('revisions') ? ['_puck_data'] : [],
        },
        presentation: {
            menuIcon: typeof args.menuIcon === 'string' && args.menuIcon ? args.menuIcon : 'fa-file',
            menuPosition: Number.isInteger(args.menuPosition) && (args.menuPosition as number) >= 0
                ? Math.min(args.menuPosition as number, 10_000) : 25,
            rewrite: {
                slug: isPlainRecord(args.rewrite) && typeof args.rewrite.slug === 'string' && SAFE_SLUG_RE.test(args.rewrite.slug)
                    ? args.rewrite.slug : name,
            },
        },
        extensions: serialisableExtensions,
    };
    return { schema: normalizeContentTypeSchema(schema), runtimeExtensions };
}

export function legacyPostTypeToContentSchema(name: unknown, args: unknown = {}): ContentTypeSchemaV1 {
    return adaptLegacyPostType(name, args).schema;
}

export function contentSchemaToPostType(schemaValue: unknown, runtimeExtensions: UnknownRecord = {}): UnknownRecord {
    const schema = normalizeContentTypeSchema(schemaValue);
    const taxonomies = schema.relationships
        .filter((relationship) => relationship.kind === 'taxonomy' && relationship.storage.kind === 'taxonomy')
        .map((relationship) => (relationship.storage as { kind: 'taxonomy'; taxonomy: string }).taxonomy);
    return {
        name: schema.name,
        label: schema.labels.plural,
        labels: { ...schema.labels },
        description: schema.description,
        public: schema.visibility.public,
        showInMenu: schema.visibility.showInMenu,
        showInRest: schema.visibility.showInRest,
        hasArchive: schema.visibility.hasArchive,
        hierarchical: schema.visibility.hierarchical,
        supports: [...schema.features],
        taxonomies,
        menuIcon: schema.presentation.menuIcon,
        menuPosition: schema.presentation.menuPosition,
        rewrite: { ...schema.presentation.rewrite },
        capability_type: schema.permissions.capabilityType,
        ...runtimeExtensions,
    };
}

export function cloneContentTypeSchema(schema: ContentTypeSchemaV1): ContentTypeSchemaV1 {
    return normalizeContentTypeSchema(jsonClone(schema, 'schema clone'));
}

export function defaultOperationsFor(capabilityType: string): Record<string, string> {
    if (!CAPABILITY_TYPE_RE.test(capabilityType)) fail('permissions.capabilityType', 'has an invalid capability family');
    return operationsFor(capabilityType);
}

module.exports = {
    normalizeContentTypeSchema,
    adaptLegacyPostType,
    legacyPostTypeToContentSchema,
    contentSchemaToPostType,
    cloneContentTypeSchema,
    fieldsForFeatures,
    relationshipsForLegacy,
    defaultOperationsFor,
};
