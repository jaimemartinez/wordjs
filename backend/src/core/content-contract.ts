/**
 * F2 executable contracts generated from the F1 content schema.
 *
 * This module is intentionally pure except for the two registry lookup helpers at
 * the bottom. Validation, policy projection and OpenAPI projection all consume the
 * same normalized schema object; none carries an independent list of content
 * fields or capability names.
 */

import type { ContentFieldSchema, ContentTypeSchemaV1, JsonValue } from './content-schema';

const {
    normalizeContentTypeSchema,
    defaultOperationsFor,
} = require('./content-schema');

export type ContentContractOperation = 'create' | 'update';

export interface ContentValidationIssue {
    path: string;
    code: 'required' | 'type' | 'enum' | 'discriminator';
    message: string;
}

export type ContentValidationResult<T> =
    | { ok: true; value: T }
    | { ok: false; issues: ContentValidationIssue[] };

export interface ContentRoutePolicy {
    capabilityType: string;
    publiclyReadable: boolean;
    create: string;
    edit: string;
    publish: string;
    del: string;
    editPublished: string;
    deletePublished: string;
    editOthers: string;
    deleteOthers: string;
    /** Compatibility read capability until a future schema version declares it explicitly. */
    readPrivate: string;
}

export interface CompiledContentContract {
    schema: ContentTypeSchemaV1;
    policy: ContentRoutePolicy;
    createOpenApi: Record<string, unknown>;
    updateOpenApi: Record<string, unknown>;
    validateCreate<T extends object>(value: unknown): ContentValidationResult<T>;
    validateUpdate<T extends object>(value: unknown): ContentValidationResult<T>;
}

export const CONTENT_FIELD_WIRE_NAMES: Readonly<Record<string, string>> = Object.freeze({
    status: 'status',
    slug: 'slug',
    date: 'date',
    language: 'language',
    title: 'title',
    content: 'content',
    excerpt: 'excerpt',
    commentStatus: 'comment_status',
    parentId: 'parent',
    order: 'menu_order',
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function own(record: Record<string, unknown>, key: string): unknown {
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function isDecimalInteger(value: string): boolean {
    const text = value.trim();
    if (!/^-?[0-9]{1,15}$/.test(text)) return false;
    return Number.isSafeInteger(Number(text));
}

function isDecimalNumber(value: string): boolean {
    const text = value.trim();
    if (!/^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text)) return false;
    return Number.isFinite(Number(text));
}

function isJsonValue(value: unknown, depth = 0, budget = { nodes: 0 }, seen = new Set<object>()): value is JsonValue {
    budget.nodes++;
    if (budget.nodes > 4096 || depth > 16) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    let valid: boolean;
    if (Array.isArray(value)) {
        valid = value.length <= 1024
            && value.every((entry) => isJsonValue(entry, depth + 1, budget, seen));
    } else if (isPlainRecord(value)) {
        valid = Object.keys(value).every((key) =>
            key !== '__proto__' && key !== 'prototype' && key !== 'constructor'
            && isJsonValue(value[key], depth + 1, budget, seen));
    } else {
        valid = false;
    }
    seen.delete(value);
    return valid;
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length
            && left.every((entry, index) => jsonValuesEqual(entry, right[index]));
    }
    if (isPlainRecord(left) || isPlainRecord(right)) {
        if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
        const leftKeys = Object.keys(left).sort();
        const rightKeys = Object.keys(right).sort();
        return leftKeys.length === rightKeys.length
            && leftKeys.every((key, index) => key === rightKeys[index]
                && jsonValuesEqual(left[key] as JsonValue, right[key] as JsonValue));
    }
    return false;
}

function scalarMatches(field: ContentFieldSchema, value: unknown): boolean {
    if (value === null) return true; // Existing REST clearing semantics.
    switch (field.type) {
        case 'string':
        case 'text':
        case 'rich-text':
        case 'datetime':
        case 'slug':
        case 'email':
        case 'url':
            return typeof value === 'string';
        case 'integer':
        case 'reference':
            return (typeof value === 'number' && Number.isSafeInteger(value))
                || (typeof value === 'string' && isDecimalInteger(value));
        case 'media':
            // The established REST write contract uses an empty string to clear a media
            // assignment (notably `_thumbnail_id`). Keep that sentinel part of the
            // declarative media type so every generated consumer agrees with runtime.
            return value === ''
                || (typeof value === 'number' && Number.isSafeInteger(value))
                || (typeof value === 'string' && isDecimalInteger(value));
        case 'number':
            return (typeof value === 'number' && Number.isFinite(value))
                || (typeof value === 'string' && isDecimalNumber(value));
        case 'boolean':
            return typeof value === 'boolean';
        case 'json':
            return isJsonValue(value);
        case 'enum':
            return !!field.enum && isJsonValue(value)
                && field.enum.some((candidate) => jsonValuesEqual(candidate, value));
        default:
            return false;
    }
}

function expectedType(field: ContentFieldSchema): string {
    if (field.multiple) return `an array of ${field.type} values`;
    if (field.type === 'media') {
        return 'a safe integer, decimal integer string, or empty string to clear';
    }
    if (field.type === 'integer' || field.type === 'reference') {
        return 'a safe integer or decimal integer string';
    }
    return field.type;
}

function validateField(
    issues: ContentValidationIssue[],
    path: string,
    field: ContentFieldSchema,
    value: unknown,
): void {
    if (field.multiple) {
        if (!Array.isArray(value) || !value.every((entry) => scalarMatches({ ...field, multiple: false }, entry))) {
            issues.push({ path, code: 'type', message: `Expected ${expectedType(field)}.` });
        }
        return;
    }
    if (!scalarMatches(field, value)) {
        issues.push({
            path,
            code: field.type === 'enum' ? 'enum' : 'type',
            message: field.type === 'enum'
                ? `Expected one of: ${(field.enum || []).map(String).join(', ')}.`
                : `Expected ${expectedType(field)}.`,
        });
    }
}

function fieldInput(body: Record<string, unknown>, fieldName: string, field: ContentFieldSchema): { path: string; value: unknown } | null {
    if (field.storage.kind === 'computed') return null;
    if (field.storage.kind === 'meta') {
        const meta = own(body, 'meta');
        if (!isPlainRecord(meta) || !Object.prototype.hasOwnProperty.call(meta, field.storage.key)) return null;
        return { path: `meta.${field.storage.key}`, value: own(meta, field.storage.key) };
    }
    const wireName = CONTENT_FIELD_WIRE_NAMES[fieldName];
    if (!wireName || !Object.prototype.hasOwnProperty.call(body, wireName)) return null;
    return { path: wireName, value: own(body, wireName) };
}

export function validateContentInput<T extends object>(
    schemaValue: unknown,
    operation: ContentContractOperation,
    value: unknown,
): ContentValidationResult<T> {
    const schema = normalizeContentTypeSchema(schemaValue) as ContentTypeSchemaV1;
    if (!isPlainRecord(value)) {
        return { ok: false, issues: [{ path: '<root>', code: 'type', message: 'Expected a JSON object.' }] };
    }

    const issues: ContentValidationIssue[] = [];
    const requestedType = own(value, 'type');
    if (requestedType !== undefined && requestedType !== null && requestedType !== '' && requestedType !== schema.name) {
        issues.push({
            path: 'type', code: 'discriminator',
            message: `Expected content type '${schema.name}'.`,
        });
    }

    for (const [fieldName, field] of Object.entries(schema.fields)) {
        const input = fieldInput(value, fieldName, field);
        if (!input) {
            if (operation === 'create' && field.required && field.default === undefined && field.storage.kind !== 'computed') {
                const requiredPath = field.storage.kind === 'meta'
                    ? `meta.${field.storage.key}`
                    : CONTENT_FIELD_WIRE_NAMES[fieldName];
                if (requiredPath) issues.push({ path: requiredPath, code: 'required', message: 'Field is required.' });
            }
            continue;
        }
        if (operation === 'create' && field.required && field.default === undefined && input.value === null) {
            issues.push({ path: input.path, code: 'required', message: 'Field is required.' });
            continue;
        }
        validateField(issues, input.path, field, input.value);
    }

    return issues.length ? { ok: false, issues } : { ok: true, value: value as T };
}

export function policyFromContentSchema(schemaValue: unknown): ContentRoutePolicy {
    const schema = normalizeContentTypeSchema(schemaValue) as ContentTypeSchemaV1;
    const operations = schema.permissions.operations;
    return {
        capabilityType: schema.permissions.capabilityType,
        publiclyReadable: schema.visibility.public,
        create: operations.create,
        edit: operations.edit,
        publish: operations.publish,
        del: operations.delete,
        editPublished: operations.editPublished,
        deletePublished: operations.deletePublished,
        editOthers: operations.editOthers,
        deleteOthers: operations.deleteOthers,
        readPrivate: `read_private_${schema.permissions.capabilityType}s`,
    };
}

export function policyFromCapabilityType(capabilityType: string): ContentRoutePolicy {
    const operations = defaultOperationsFor(capabilityType);
    return {
        capabilityType,
        publiclyReadable: true,
        create: operations.create,
        edit: operations.edit,
        publish: operations.publish,
        del: operations.delete,
        editPublished: operations.editPublished,
        deletePublished: operations.deletePublished,
        editOthers: operations.editOthers,
        deleteOthers: operations.deleteOthers,
        readPrivate: `read_private_${capabilityType}s`,
    };
}

function openApiScalar(field: ContentFieldSchema, nullable = true): Record<string, unknown> {
    let projected: Record<string, unknown>;
    switch (field.type) {
        case 'integer':
        case 'reference':
            projected = { oneOf: [{ type: 'integer' }, { type: 'string', pattern: '^-?[0-9]{1,15}$' }] };
            break;
        case 'media':
            projected = {
                oneOf: [
                    { type: 'integer' },
                    { type: 'string', pattern: '^-?[0-9]{1,15}$' },
                    { type: 'string', enum: [''] },
                ],
            };
            break;
        case 'number':
            projected = {
                oneOf: [
                    { type: 'number' },
                    { type: 'string', pattern: '^-?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$' },
                ],
            };
            break;
        case 'boolean': projected = { type: 'boolean' }; break;
        case 'json': projected = {}; break;
        case 'datetime': projected = { type: 'string', format: 'date-time' }; break;
        case 'email': projected = { type: 'string', format: 'email' }; break;
        case 'url': projected = { type: 'string', format: 'uri' }; break;
        case 'enum': projected = { enum: field.enum }; break;
        default: projected = { type: 'string' }; break;
    }
    if (field.multiple) projected = { type: 'array', items: projected };
    if (field.default !== undefined) projected.default = field.default;
    projected.description = field.description;
    if (nullable) projected.nullable = true;
    return projected;
}

function openApiInputFor(schema: ContentTypeSchemaV1, operation: ContentContractOperation): Record<string, unknown> {
    const properties: Record<string, unknown> = {
        type: { type: 'string', enum: [schema.name], default: schema.name },
        meta: { type: 'object', additionalProperties: true },
        categories: { type: 'array', items: { type: 'integer' } },
        tags: { type: 'array', items: { type: 'integer' } },
    };
    const required = new Set<string>();
    const requiredMeta = new Set<string>();
    // Compatibility contract of POST /posts: every generic creation requires a title.
    if (operation === 'create') required.add('title');
    if (operation === 'create' && schema.name !== 'post') required.add('type');

    const metaProperties: Record<string, unknown> = {};
    for (const [fieldName, field] of Object.entries(schema.fields)) {
        if (field.storage.kind === 'computed') continue;
        if (field.storage.kind === 'meta') {
            const requiredOnCreate = operation === 'create' && field.required && field.default === undefined;
            metaProperties[field.storage.key] = openApiScalar(field, !requiredOnCreate);
            if (requiredOnCreate) {
                required.add('meta');
                requiredMeta.add(field.storage.key);
            }
            continue;
        }
        const wireName = CONTENT_FIELD_WIRE_NAMES[fieldName];
        if (!wireName) continue;
        const requiredOnCreate = operation === 'create' && field.required && field.default === undefined;
        properties[wireName] = openApiScalar(field, !requiredOnCreate);
        if (requiredOnCreate) required.add(wireName);
    }
    if (operation === 'update') properties.autosave = { type: 'boolean' };
    if (Object.keys(metaProperties).length) {
        properties.meta = {
            type: 'object',
            properties: metaProperties,
            additionalProperties: true,
            ...(requiredMeta.size ? { required: [...requiredMeta].sort() } : {}),
        };
    }

    const result: Record<string, unknown> = { type: 'object', properties, additionalProperties: true };
    if (required.size) result.required = [...required].sort();
    return result;
}

function componentStem(name: string): string {
    return name.split(/([-_])/g).filter(Boolean)
        .map((part) => {
            if (part === '-') return 'Dash';
            if (part === '_') return 'Underscore';
            return part.charAt(0).toUpperCase() + part.slice(1);
        }).join('');
}

export function compileContentContract(schemaValue: unknown): CompiledContentContract {
    const schema = normalizeContentTypeSchema(schemaValue) as ContentTypeSchemaV1;
    return {
        schema,
        policy: policyFromContentSchema(schema),
        createOpenApi: openApiInputFor(schema, 'create'),
        updateOpenApi: openApiInputFor(schema, 'update'),
        validateCreate: <T extends object>(value: unknown) => validateContentInput<T>(schema, 'create', value),
        validateUpdate: <T extends object>(value: unknown) => validateContentInput<T>(schema, 'update', value),
    };
}

export function buildContentOpenApiComponents(schemaValues: unknown[]): Record<string, unknown> {
    const schemas = schemaValues.map((value) => normalizeContentTypeSchema(value) as ContentTypeSchemaV1)
        .filter((schema) => schema.visibility.showInRest)
        .sort((a, b) => a.name.localeCompare(b.name));
    const components: Record<string, unknown> = {};
    const createRefs: Record<string, unknown>[] = [];
    const updateRefs: Record<string, unknown>[] = [];

    for (const schema of schemas) {
        const stem = componentStem(schema.name);
        const contract = compileContentContract(schema);
        const createName = `Content${stem}CreateInput`;
        const updateName = `Content${stem}UpdateInput`;
        components[createName] = contract.createOpenApi;
        components[updateName] = contract.updateOpenApi;
        createRefs.push({ $ref: `#/components/schemas/${createName}` });
        updateRefs.push({ $ref: `#/components/schemas/${updateName}` });
    }

    components.ContentCreateInput = {
        oneOf: createRefs,
        discriminator: { propertyName: 'type' },
        'x-wordjs-schema-version': 1,
    };
    components.ContentUpdateInput = {
        // An update is identified by /posts/{id}; `type` remains optional for REST compatibility,
        // so several per-type schemas can legitimately match the same partial body. `anyOf` models
        // that fact, while create remains a discriminator-backed oneOf.
        anyOf: updateRefs,
        'x-wordjs-schema-version': 1,
    };
    components.ContentValidationError = {
        type: 'object', required: ['code', 'message', 'data'],
        properties: {
            code: { type: 'string', enum: ['rest_content_contract_invalid'] },
            message: { type: 'string' },
            errors: { type: 'array', items: { type: 'object' } },
            data: { type: 'object', properties: { status: { type: 'integer', enum: [400] } } },
        },
    };
    return components;
}

export function contentContractForType(name: string): CompiledContentContract | null {
    const { getContentTypeSchema } = require('./post-types');
    const schema = getContentTypeSchema(name);
    if (!schema) {
        contractCache.delete(name);
        return null;
    }
    const fingerprint = JSON.stringify(schema);
    const cached = contractCache.get(name);
    if (cached && cached.fingerprint === fingerprint) return cached.contract;
    const contract = compileContentContract(schema);
    if (!contractCache.has(name) && contractCache.size >= MAX_CONTRACT_CACHE_ENTRIES) {
        const oldest = contractCache.keys().next().value as string | undefined;
        if (oldest !== undefined) contractCache.delete(oldest);
    }
    contractCache.set(name, { fingerprint, contract });
    return contract;
}

const MAX_CONTRACT_CACHE_ENTRIES = 256;
const contractCache = new Map<string, { fingerprint: string; contract: CompiledContentContract }>();

module.exports = {
    validateContentInput,
    policyFromContentSchema,
    policyFromCapabilityType,
    compileContentContract,
    buildContentOpenApiComponents,
    contentContractForType,
    CONTENT_FIELD_WIRE_NAMES,
};
