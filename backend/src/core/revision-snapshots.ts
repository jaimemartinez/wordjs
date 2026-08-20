/**
 * F4 declarative, versioned revision snapshots.
 *
 * A snapshot is the revision posts row, its raw metadata rows, and one protected manifest. The
 * manifest freezes the field/storage decision made when the snapshot was created. Restores never
 * consult today's plugin registry, so disabling or upgrading a plugin cannot reinterpret history.
 */

const crypto = require('crypto');
const { getContentTypeSchema } = require('./post-types');
const { canonicalMetaKey, isProtectedPostMeta, metaKeyProblem } = require('./protected-meta');
const {
    LEGACY_REVISIONABLE_META_KEYS,
    REVISION_SNAPSHOT_META_KEY,
} = require('./revision-constants');

const SNAPSHOT_FORMAT = 'wordjs.revision.snapshot';
const SNAPSHOT_FORMAT_VERSION = 1;
const CURRENT_CODEC_VERSION = 1;
const LEGACY_CODEC_VERSION = 0;
const INACTIVE_PLUGIN_POLICY = 'snapshot-authoritative';
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_SNAPSHOT_FIELDS = 256;

const SAFE_CONTENT_TYPE = /^[a-z][a-z0-9_-]{0,31}$/;
const SAFE_FIELD_NAME = /^[a-z][a-zA-Z0-9_.:-]{0,127}$/;
const SAFE_META_KEY = /^[_a-zA-Z0-9][-_a-zA-Z0-9.:]{0,127}$/;

/** Columns whose old values are already carried by the historical revision row. */
const REVISION_ROW_COLUMNS: Record<string, string> = Object.freeze({
    post_title: 'post_title',
    post_content: 'post_content',
    post_excerpt: 'post_excerpt',
});

/**
 * Declarative plugins may restore editorial columns, never identity, ownership, type, counters,
 * passwords, GUIDs, server timestamps or translation-group integrity columns.
 */
const RESTORABLE_COLUMNS = new Set([
    'post_title',
    'post_content',
    'post_excerpt',
    'post_status',
    'post_name',
    'post_date',
    'post_date_gmt',
    'post_parent',
    'menu_order',
    'comment_status',
    'post_language',
]);

const CORE_META_DESCRIPTIONS: Record<string, string> = Object.freeze({
    _puck_data: 'Page layout',
    _wjs_template: 'Theme template',
    _thumbnail_id: 'Featured image',
    seo_title: 'SEO title',
    seo_description: 'SEO description',
    og_image: 'Social image',
    noindex: 'Search indexing preference',
});

type JsonScalar = null | boolean | number | string;
type RawMetaRow = { key: string; value: string | null };

interface SnapshotColumnStorage {
    kind: 'column';
    column: string;
}

interface SnapshotMetaStorage {
    kind: 'meta';
    key: string;
}

type SnapshotStorage = SnapshotColumnStorage | SnapshotMetaStorage;

interface SnapshotFieldV1 {
    name: string;
    type: string;
    description: string;
    storage: SnapshotStorage;
    codecVersion: number;
    source: 'revision-row' | 'manifest' | 'revision-meta';
    present: boolean;
    valueCount: number;
    value?: JsonScalar;
}

interface SnapshotEnvelopeV1 {
    format: typeof SNAPSHOT_FORMAT;
    formatVersion: typeof SNAPSHOT_FORMAT_VERSION;
    contentType: string;
    contentSchemaVersion: number;
    contentSchemaFingerprint: string;
    revisionCodecVersion: number;
    inactivePluginPolicy: typeof INACTIVE_PLUGIN_POLICY;
    legacyCompatibility: boolean;
    fields: SnapshotFieldV1[];
}

interface RestoreFieldDescription {
    name: string;
    description: string;
    storage: 'column' | 'meta';
    present: boolean;
    willClear: boolean;
}

interface RestoreDescriptor {
    compatible: boolean;
    legacy: boolean;
    schemaVersion: number;
    codecVersion: number;
    schemaFingerprint: string | null;
    inactivePluginPolicy: typeof INACTIVE_PLUGIN_POLICY;
    preservesUndeclaredFields: true;
    fields: RestoreFieldDescription[];
    errorCode?: string;
}

interface RevisionRestorePlan {
    descriptor: RestoreDescriptor;
    contentType: string | null;
    columns: Array<{ column: string; value: JsonScalar }>;
    meta: Array<{ key: string; values: Array<string | null>; present: boolean }>;
    frozenFields: Array<Omit<SnapshotFieldV1, 'present' | 'valueCount' | 'value'>>;
}

class RevisionSnapshotError extends Error {
    code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'RevisionSnapshotError';
        this.code = code;
    }
}

function fail(code: string, message: string): never {
    throw new RevisionSnapshotError(code, message);
}

function rejectUnknownKeys(value: Record<string, any>, allowed: Set<string>, path: string): void {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) fail('revision_manifest_invalid', `${path} contains unknown property ${key}`);
    }
}

function asRawMetaRows(rows: any[]): RawMetaRow[] {
    return (Array.isArray(rows) ? rows : []).map((row) => ({
        key: String(row?.key ?? row?.meta_key ?? ''),
        value: row?.value ?? row?.meta_value ?? null,
    }));
}

function stableValue(value: any): any {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
}

function fingerprint(value: any): string {
    return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function schemaFingerprintFor(
    contentType: string,
    schemaVersion: number,
    codecVersion: number,
    legacyCompatibility: boolean,
    fields: Array<Pick<SnapshotFieldV1, 'name' | 'type' | 'description' | 'storage' | 'codecVersion' | 'source'>>,
): string {
    return fingerprint({
        contentType,
        schemaVersion,
        codecVersion,
        legacyCompatibility,
        fields: fields.map(({ name, type, description, storage, codecVersion: fieldCodecVersion, source }) => ({
            name, type, description, storage, codecVersion: fieldCodecVersion, source,
        })),
    });
}

function assertCodec(version: unknown): number {
    if (version !== CURRENT_CODEC_VERSION) {
        fail('revision_codec_unsupported', `Unsupported revision codec version ${String(version)}`);
    }
    return version as number;
}

function assertScalar(value: unknown, path: string): JsonScalar {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        if (typeof value === 'string' && value.length > 65_536) fail('revision_manifest_invalid', `${path} is too long`);
        return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return fail('revision_manifest_invalid', `${path} is not a JSON scalar`);
}

function normalizeFieldStorage(storage: any, name: string): SnapshotStorage {
    if (!storage || typeof storage !== 'object' || Array.isArray(storage)) {
        return fail('revision_field_storage_invalid', `Revision field ${name} has no storage declaration`);
    }
    if (storage.kind === 'column') {
        rejectUnknownKeys(storage, new Set(['kind', 'column']), `fields.${name}.storage`);
        const column = String(storage.column || '');
        if (!RESTORABLE_COLUMNS.has(column)) {
            return fail('revision_column_forbidden', `Revision field ${name} targets forbidden column ${column}`);
        }
        return { kind: 'column', column };
    }
    if (storage.kind === 'meta') {
        rejectUnknownKeys(storage, new Set(['kind', 'key']), `fields.${name}.storage`);
        const key = String(storage.key || '');
        if (!SAFE_META_KEY.test(key) || metaKeyProblem(key) !== null || isProtectedPostMeta(key)) {
            return fail('revision_meta_forbidden', `Revision field ${name} targets forbidden metadata ${key}`);
        }
        return { kind: 'meta', key };
    }
    return fail('revision_field_storage_invalid', `Revision field ${name} must use column or meta storage`);
}

function legacyFieldDefinitions(codecVersion: number): Array<Omit<SnapshotFieldV1, 'present' | 'valueCount' | 'value'>> {
    return [
        ['title', 'string', 'Editorial title', 'post_title'],
        ['content', 'rich-text', 'Primary document content', 'post_content'],
        ['excerpt', 'text', 'Editorial summary', 'post_excerpt'],
    ].map(([name, type, description, column]) => ({
        name,
        type,
        description,
        storage: { kind: 'column', column } as SnapshotColumnStorage,
        codecVersion,
        source: 'revision-row' as const,
    })).concat(LEGACY_REVISIONABLE_META_KEYS.map((key: string) => ({
        name: `meta:${key}`,
        type: 'raw-meta',
        description: CORE_META_DESCRIPTIONS[key] || key,
        storage: { kind: 'meta', key } as SnapshotMetaStorage,
        codecVersion,
        source: 'revision-meta' as const,
    })));
}

function schemaFieldDefinitions(schema: any): Array<Omit<SnapshotFieldV1, 'present' | 'valueCount' | 'value'>> {
    assertCodec(schema.revisions.codecVersion);
    const names = new Set<string>([
        ...Object.entries(schema.fields || {})
            .filter(([, field]: [string, any]) => field?.revisioned === true)
            .map(([name]) => name),
        ...(Array.isArray(schema.revisions.fields) ? schema.revisions.fields : []),
    ]);
    const definitions: Array<Omit<SnapshotFieldV1, 'present' | 'valueCount' | 'value'>> = [];
    const metaTargets = new Set<string>();
    const columnTargets = new Set<string>();

    for (const name of names) {
        const field = schema.fields?.[name];
        if (!field) fail('revision_schema_invalid', `Revision field ${name} is missing from the schema`);
        const storage = normalizeFieldStorage(field.storage, name);
        const target = storage.kind === 'meta' ? canonicalMetaKey(storage.key) : storage.column;
        const targets = storage.kind === 'meta' ? metaTargets : columnTargets;
        if (targets.has(target)) fail('revision_schema_ambiguous', `More than one revision field targets ${target}`);
        targets.add(target);
        definitions.push({
            name,
            type: String(field.type),
            description: String(field.description || name).slice(0, 2048),
            storage,
            codecVersion: schema.revisions.codecVersion,
            source: storage.kind === 'meta'
                ? 'revision-meta'
                : Object.prototype.hasOwnProperty.call(REVISION_ROW_COLUMNS, storage.column)
                    ? 'revision-row'
                    : 'manifest',
        });
    }

    for (const key of Array.isArray(schema.revisions.metaKeys) ? schema.revisions.metaKeys : []) {
        const storage = normalizeFieldStorage({ kind: 'meta', key }, `meta:${key}`) as SnapshotMetaStorage;
        const target = canonicalMetaKey(storage.key);
        if (metaTargets.has(target)) continue;
        metaTargets.add(target);
        definitions.push({
            name: `meta:${key}`,
            type: 'raw-meta',
            description: CORE_META_DESCRIPTIONS[key] || key,
            storage,
            codecVersion: schema.revisions.codecVersion,
            source: 'revision-meta',
        });
    }
    return definitions;
}

/** Build one immutable manifest plus the raw meta rows copied beside it. */
function buildRevisionSnapshot(
    post: any,
    liveMetaRowsValue: any[],
    preserveFieldsValue: Array<Omit<SnapshotFieldV1, 'present' | 'valueCount' | 'value'>> = [],
): { envelope: SnapshotEnvelopeV1; metaRows: RawMetaRow[] } {
    const contentType = String(post?.post_type || 'post');
    if (!SAFE_CONTENT_TYPE.test(contentType)) fail('revision_content_type_invalid', 'The post type cannot be snapshotted');
    const schema = getContentTypeSchema(contentType);
    const declarative = !!(schema && schema.revisions?.enabled);
    const definitions = declarative
        ? schemaFieldDefinitions(schema)
        : legacyFieldDefinitions(CURRENT_CODEC_VERSION);
    // Restoring a snapshot while its plugin is disabled still needs an undo point for those plugin
    // fields. Merge the target snapshot's already-validated declarations into the safety snapshot;
    // otherwise the restore would be atomic but not reversible.
    const targets = new Set(definitions.map((field) => field.storage.kind === 'meta'
        ? `meta:${canonicalMetaKey(field.storage.key)}`
        : `column:${field.storage.column}`));
    for (const preserved of preserveFieldsValue) {
        const storage = normalizeFieldStorage(preserved.storage, preserved.name);
        const target = storage.kind === 'meta' ? `meta:${canonicalMetaKey(storage.key)}` : `column:${storage.column}`;
        if (targets.has(target)) continue;
        targets.add(target);
        definitions.push({
            name: preserved.name,
            type: preserved.type,
            description: preserved.description,
            storage,
            codecVersion: CURRENT_CODEC_VERSION,
            source: storage.kind === 'meta'
                ? 'revision-meta'
                : Object.prototype.hasOwnProperty.call(REVISION_ROW_COLUMNS, storage.column)
                    ? 'revision-row'
                    : 'manifest',
        });
    }
    if (definitions.length > MAX_SNAPSHOT_FIELDS) fail('revision_schema_too_large', 'The revision schema has too many fields');

    const liveMetaRows = asRawMetaRows(liveMetaRowsValue);
    const copiedMeta: RawMetaRow[] = [];
    const fields: SnapshotFieldV1[] = definitions.map((definition) => {
        if (definition.storage.kind === 'meta') {
            const target = canonicalMetaKey(definition.storage.key);
            const values = liveMetaRows.filter((row) => canonicalMetaKey(row.key) === target);
            if (values.length > 100_000) fail('revision_payload_too_large', `Snapshot field ${definition.name} has too many values`);
            for (const row of values) copiedMeta.push({ key: definition.storage.key, value: row.value });
            return { ...definition, present: values.length > 0, valueCount: values.length };
        }
        const value = assertScalar(post?.[definition.storage.column] ?? null, `fields.${definition.name}.value`);
        if (definition.source === 'manifest') {
            return { ...definition, present: true, valueCount: 1, value };
        }
        return { ...definition, present: true, valueCount: 1 };
    });

    const schemaVersion = declarative ? Number(schema.schemaVersion) : 0;
    const codecVersion = declarative ? Number(schema.revisions.codecVersion) : CURRENT_CODEC_VERSION;
    const legacyCompatibility = !declarative;
    const envelope: SnapshotEnvelopeV1 = {
        format: SNAPSHOT_FORMAT,
        formatVersion: SNAPSHOT_FORMAT_VERSION,
        contentType,
        contentSchemaVersion: schemaVersion,
        contentSchemaFingerprint: schemaFingerprintFor(contentType, schemaVersion, codecVersion, legacyCompatibility, fields),
        revisionCodecVersion: codecVersion,
        inactivePluginPolicy: INACTIVE_PLUGIN_POLICY,
        legacyCompatibility,
        fields,
    };
    const serialized = JSON.stringify(envelope);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MANIFEST_BYTES) {
        fail('revision_manifest_too_large', 'The revision manifest exceeds its storage budget');
    }
    return { envelope, metaRows: copiedMeta };
}

function manifestRows(metaRowsValue: any[]): RawMetaRow[] {
    return asRawMetaRows(metaRowsValue).filter((row) => canonicalMetaKey(row.key) === canonicalMetaKey(REVISION_SNAPSHOT_META_KEY));
}

function parseEnvelope(metaRowsValue: any[]): SnapshotEnvelopeV1 | null {
    const rows = manifestRows(metaRowsValue);
    if (rows.length === 0) return null;
    if (rows.length !== 1 || typeof rows[0].value !== 'string') {
        return fail('revision_manifest_ambiguous', 'The revision has an ambiguous snapshot manifest');
    }
    if (Buffer.byteLength(rows[0].value, 'utf8') > MAX_MANIFEST_BYTES) {
        return fail('revision_manifest_too_large', 'The revision manifest exceeds its read budget');
    }
    let value: any;
    try { value = JSON.parse(rows[0].value); }
    catch { return fail('revision_manifest_invalid', 'The revision manifest is not valid JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('revision_manifest_invalid', 'The revision manifest is not an object');
    rejectUnknownKeys(value, new Set([
        'format', 'formatVersion', 'contentType', 'contentSchemaVersion', 'contentSchemaFingerprint',
        'revisionCodecVersion', 'inactivePluginPolicy', 'legacyCompatibility', 'fields',
    ]), '<manifest>');
    if (value.format !== SNAPSHOT_FORMAT || value.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
        fail('revision_format_unsupported', 'The revision snapshot format is unsupported');
    }
    if (typeof value.contentType !== 'string' || !SAFE_CONTENT_TYPE.test(value.contentType)) fail('revision_manifest_invalid', 'Invalid snapshot content type');
    if (!Number.isInteger(value.contentSchemaVersion) || value.contentSchemaVersion < 0 || value.contentSchemaVersion > 1_000_000) {
        fail('revision_manifest_invalid', 'Invalid snapshot schema version');
    }
    if (typeof value.contentSchemaFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentSchemaFingerprint)) {
        fail('revision_manifest_invalid', 'Invalid snapshot schema fingerprint');
    }
    assertCodec(value.revisionCodecVersion);
    if (value.inactivePluginPolicy !== INACTIVE_PLUGIN_POLICY || typeof value.legacyCompatibility !== 'boolean') {
        fail('revision_manifest_invalid', 'Invalid inactive-plugin policy');
    }
    if (!Array.isArray(value.fields) || value.fields.length > MAX_SNAPSHOT_FIELDS) fail('revision_manifest_invalid', 'Invalid snapshot field list');

    const names = new Set<string>();
    const targets = new Set<string>();
    const fields: SnapshotFieldV1[] = value.fields.map((raw: any, index: number) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('revision_manifest_invalid', `Invalid field ${index}`);
        rejectUnknownKeys(raw, new Set([
            'name', 'type', 'description', 'storage', 'codecVersion', 'source',
            'present', 'valueCount', 'value',
        ]), `fields[${index}]`);
        const name = String(raw.name || '');
        if (!SAFE_FIELD_NAME.test(name) || names.has(name)) fail('revision_manifest_invalid', `Invalid or duplicate field ${name}`);
        names.add(name);
        if (typeof raw.type !== 'string' || raw.type.length > 64) fail('revision_manifest_invalid', `Invalid type for field ${name}`);
        if (typeof raw.description !== 'string' || raw.description.length > 2048) fail('revision_manifest_invalid', `Invalid description for field ${name}`);
        const storage = normalizeFieldStorage(raw.storage, name);
        const target = storage.kind === 'meta' ? `meta:${canonicalMetaKey(storage.key)}` : `column:${storage.column}`;
        if (targets.has(target)) fail('revision_manifest_invalid', `Duplicate snapshot target ${target}`);
        targets.add(target);
        const codecVersion = assertCodec(raw.codecVersion);
        if (!['revision-row', 'manifest', 'revision-meta'].includes(raw.source)) fail('revision_manifest_invalid', `Invalid source for field ${name}`);
        if (storage.kind === 'meta' && raw.source !== 'revision-meta') fail('revision_manifest_invalid', `Invalid metadata source for field ${name}`);
        if (storage.kind === 'column') {
            const expected = Object.prototype.hasOwnProperty.call(REVISION_ROW_COLUMNS, storage.column) ? 'revision-row' : 'manifest';
            if (raw.source !== expected) fail('revision_manifest_invalid', `Invalid column source for field ${name}`);
        }
        if (typeof raw.present !== 'boolean' || !Number.isInteger(raw.valueCount) || raw.valueCount < 0 || raw.valueCount > 100_000) {
            fail('revision_manifest_invalid', `Invalid presence data for field ${name}`);
        }
        if (raw.present !== (raw.valueCount > 0)) fail('revision_manifest_invalid', `Inconsistent presence data for field ${name}`);
        if (storage.kind === 'column' && (!raw.present || raw.valueCount !== 1)) {
            fail('revision_manifest_invalid', `Invalid column payload count for field ${name}`);
        }
        if (raw.source !== 'manifest' && Object.prototype.hasOwnProperty.call(raw, 'value')) {
            fail('revision_manifest_invalid', `Unexpected inline value for field ${name}`);
        }
        const field: SnapshotFieldV1 = {
            name,
            type: raw.type,
            description: raw.description,
            storage,
            codecVersion,
            source: raw.source,
            present: raw.present,
            valueCount: raw.valueCount,
        };
        if (raw.source === 'manifest') field.value = assertScalar(raw.value, `fields.${name}.value`);
        return field;
    });
    const expectedFingerprint = schemaFingerprintFor(
        value.contentType,
        value.contentSchemaVersion,
        value.revisionCodecVersion,
        value.legacyCompatibility,
        fields,
    );
    if (value.contentSchemaFingerprint !== expectedFingerprint) {
        fail('revision_schema_fingerprint_mismatch', 'The snapshot field schema does not match its fingerprint');
    }
    return { ...value, fields } as SnapshotEnvelopeV1;
}

function descriptorFor(
    envelope: SnapshotEnvelopeV1 | null,
    compatible = true,
    errorCode?: string,
    legacyMetaRowsValue: any[] = [],
): RestoreDescriptor {
    const legacyMetaRows = asRawMetaRows(legacyMetaRowsValue);
    const fields = envelope
        ? envelope.fields
        : legacyFieldDefinitions(LEGACY_CODEC_VERSION).map((field) => {
            if (field.storage.kind === 'column') return { ...field, present: true, valueCount: 1 };
            const metaKey = field.storage.key;
            const count = legacyMetaRows.filter((row) => canonicalMetaKey(row.key) === canonicalMetaKey(metaKey)).length;
            return { ...field, present: count > 0, valueCount: count };
        });
    return {
        compatible,
        legacy: !envelope || envelope.legacyCompatibility,
        schemaVersion: envelope?.contentSchemaVersion ?? 0,
        codecVersion: envelope?.revisionCodecVersion ?? LEGACY_CODEC_VERSION,
        schemaFingerprint: envelope?.contentSchemaFingerprint ?? null,
        inactivePluginPolicy: INACTIVE_PLUGIN_POLICY,
        preservesUndeclaredFields: true,
        fields: fields.map((field) => ({
            name: field.name,
            description: field.description,
            storage: field.storage.kind,
            present: field.present,
            willClear: field.storage.kind === 'meta' && !field.present,
        })),
        ...(errorCode ? { errorCode } : {}),
    };
}

/** Safe additive API description: corrupt/future manifests remain listable but not restorable. */
function describeRevisionSnapshot(metaRowsValue: any[]): RestoreDescriptor {
    try { return descriptorFor(parseEnvelope(metaRowsValue), true, undefined, metaRowsValue); }
    catch (error: any) {
        return descriptorFor(null, false, error?.code || 'revision_manifest_invalid', metaRowsValue);
    }
}

function validateDecodedColumn(column: string, value: JsonScalar): JsonScalar {
    if (['post_title', 'post_content', 'post_excerpt', 'post_name'].includes(column)) {
        if (typeof value !== 'string') fail('revision_payload_invalid', `${column} must be a string`);
        return value;
    }
    if (column === 'post_status') {
        if (typeof value !== 'string' || !new Set(['draft', 'publish', 'future', 'private', 'pending', 'trash', 'inherit', 'auto-draft']).has(value)) {
            fail('revision_payload_invalid', 'post_status is invalid');
        }
        return value;
    }
    if (column === 'comment_status') {
        if (value !== 'open' && value !== 'closed') fail('revision_payload_invalid', 'comment_status is invalid');
        return value;
    }
    if (column === 'post_parent' || column === 'menu_order') {
        if (!Number.isSafeInteger(value) || (column === 'post_parent' && (value as number) < 0)) {
            fail('revision_payload_invalid', `${column} must be a safe integer`);
        }
        return value;
    }
    if (column === 'post_language') {
        if (value !== null && (typeof value !== 'string' || value.length > 64)) fail('revision_payload_invalid', 'post_language is invalid');
        return value;
    }
    if (column === 'post_date' || column === 'post_date_gmt') {
        if (typeof value !== 'string' || value.length > 64 || Number.isNaN(new Date(value).getTime())) {
            fail('revision_payload_invalid', `${column} is invalid`);
        }
        return value;
    }
    return fail('revision_column_forbidden', `Column ${column} is not restorable`);
}

function decodeRevisionSnapshot(revisionRow: any, metaRowsValue: any[], parentType: string): RevisionRestorePlan {
    const rawRows = asRawMetaRows(metaRowsValue);
    const envelope = parseEnvelope(rawRows);
    const effectiveEnvelope: SnapshotEnvelopeV1 = envelope || {
        format: SNAPSHOT_FORMAT,
        formatVersion: SNAPSHOT_FORMAT_VERSION,
        contentType: parentType,
        contentSchemaVersion: 0,
        contentSchemaFingerprint: fingerprint({ legacy: true }),
        revisionCodecVersion: LEGACY_CODEC_VERSION,
        inactivePluginPolicy: INACTIVE_PLUGIN_POLICY,
        legacyCompatibility: true,
        fields: legacyFieldDefinitions(CURRENT_CODEC_VERSION).map((field) => ({ ...field, present: true, valueCount: 1 })),
    };
    if (envelope && envelope.contentType !== parentType) {
        fail('revision_content_type_mismatch', 'The snapshot belongs to a different content type');
    }
    const columns: RevisionRestorePlan['columns'] = [];
    const meta: RevisionRestorePlan['meta'] = [];
    for (const field of effectiveEnvelope.fields) {
        if (field.codecVersion !== LEGACY_CODEC_VERSION) assertCodec(field.codecVersion);
        if (field.storage.kind === 'column') {
            const value = field.source === 'revision-row'
                ? assertScalar(revisionRow?.[REVISION_ROW_COLUMNS[field.storage.column]] ?? null, `revision.${field.storage.column}`)
                : assertScalar(field.value, `manifest.${field.name}`);
            columns.push({ column: field.storage.column, value: validateDecodedColumn(field.storage.column, value) });
            continue;
        }
        const target = canonicalMetaKey(field.storage.key);
        const values = rawRows
            .filter((row) => canonicalMetaKey(row.key) === target && canonicalMetaKey(row.key) !== canonicalMetaKey(REVISION_SNAPSHOT_META_KEY))
            .map((row) => row.value);
        if (envelope && values.length !== field.valueCount) {
            fail('revision_payload_incomplete', `Snapshot field ${field.name} payload count does not match its manifest`);
        }
        meta.push({ key: field.storage.key, values, present: field.present });
    }
    return {
        descriptor: envelope ? descriptorFor(envelope) : descriptorFor(null, true, undefined, rawRows),
        contentType: envelope?.contentType ?? null,
        columns,
        meta,
        frozenFields: effectiveEnvelope.fields.map(({ name, type, description, storage, codecVersion, source }) => ({
            name, type, description, storage, codecVersion, source,
        })),
    };
}

function serializeRevisionEnvelope(envelope: SnapshotEnvelopeV1): string {
    return JSON.stringify(envelope);
}

function isRevisionableMetaForType(key: unknown, contentType?: unknown): boolean {
    if (typeof key !== 'string') return false;
    const target = canonicalMetaKey(key);
    if (typeof contentType === 'string') {
        const schema = getContentTypeSchema(contentType);
        if (schema?.revisions?.enabled) {
            const declared = [
                ...(Array.isArray(schema.revisions.metaKeys) ? schema.revisions.metaKeys : []),
                ...Object.values(schema.fields || {})
                    .filter((field: any) => field?.revisioned && field.storage?.kind === 'meta')
                    .map((field: any) => field.storage.key),
            ];
            return declared.some((declaredKey: string) => canonicalMetaKey(declaredKey) === target);
        }
    }
    return LEGACY_REVISIONABLE_META_KEYS.some((legacyKey: string) => canonicalMetaKey(legacyKey) === target);
}

module.exports = {
    SNAPSHOT_FORMAT,
    SNAPSHOT_FORMAT_VERSION,
    CURRENT_CODEC_VERSION,
    LEGACY_CODEC_VERSION,
    INACTIVE_PLUGIN_POLICY,
    RESTORABLE_COLUMNS,
    RevisionSnapshotError,
    buildRevisionSnapshot,
    serializeRevisionEnvelope,
    describeRevisionSnapshot,
    decodeRevisionSnapshot,
    isRevisionableMetaForType,
};
