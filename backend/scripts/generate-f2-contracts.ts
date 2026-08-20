/** Deterministic F2 DTO/client code generator. Default mode checks drift; --write regenerates. */

const fs = require('fs');
const path = require('path');
const { getBuiltinContentSchemas } = require('../src/core/content-schemas-builtins');
const { CONTENT_FIELD_WIRE_NAMES } = require('../src/core/content-contract');

type Schema = import('../src/core/content-schema').ContentTypeSchemaV1;
type Field = import('../src/core/content-schema').ContentFieldSchema;

const ROOT = path.resolve(__dirname, '..', '..');
const TARGETS = {
    backend: path.join(ROOT, 'backend', 'src', 'generated', 'content-dtos.generated.ts'),
    frontend: path.join(ROOT, 'frontend', 'src', 'lib', 'generated', 'content-client.generated.ts'),
};

function pascal(value: string): string {
    return value.split(/[-_]/g).filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

function quote(value: string): string {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function scalarType(field: Field): string {
    let result: string;
    switch (field.type) {
        case 'integer':
        case 'number':
        case 'media':
        case 'reference': result = 'number'; break;
        case 'boolean': result = 'boolean'; break;
        case 'json': result = 'JsonValue'; break;
        case 'enum': result = (field.enum || []).map((value) =>
            typeof value === 'string' ? quote(value) : JSON.stringify(value)).join(' | ') || 'never'; break;
        default: result = 'string'; break;
    }
    return field.multiple ? `Array<${result}>` : result;
}

function inputScalarType(field: Field, nullable = true): string {
    let result: string;
    switch (field.type) {
        case 'integer':
        case 'number':
        case 'media':
        case 'reference': result = 'number | string'; break;
        case 'boolean': result = 'boolean'; break;
        case 'json': result = 'JsonValue'; break;
        case 'enum': result = (field.enum || []).map((value) =>
            typeof value === 'string' ? quote(value) : JSON.stringify(value)).join(' | ') || 'never'; break;
        default: result = 'string'; break;
    }
    return field.multiple ? `Array<${result}>` : `${result}${nullable ? ' | null' : ''}`;
}

function propertyName(value: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : quote(value);
}

function generatedMutationDtos(schemas: Schema[]): string[] {
    const exposed = schemas.filter((schema) => schema.visibility.showInRest);
    const lines: string[] = [];

    for (const schema of exposed) {
        for (const operation of ['Create', 'Update'] as const) {
            lines.push(`export interface Content${pascal(schema.name)}${operation}Input {`);
            lines.push(`    type${operation === 'Create' && schema.name !== 'post' ? '' : '?'}: ${quote(schema.name)} | null;`);
            const metaFields: Array<[string, Field]> = [];
            for (const [fieldName, field] of Object.entries(schema.fields)) {
                if (field.storage.kind === 'meta') {
                    metaFields.push([field.storage.key, field]);
                    continue;
                }
                const wireName = CONTENT_FIELD_WIRE_NAMES[fieldName];
                if (!wireName || field.storage.kind === 'computed') continue;
                const required = operation === 'Create' && field.required && field.default === undefined;
                lines.push(`    ${propertyName(wireName)}${required ? '' : '?'}: ${inputScalarType(field, !required)};`);
            }
            if (metaFields.length) {
                lines.push('    meta?: Record<string, unknown> & {');
                for (const [key, field] of metaFields) {
                    const required = operation === 'Create' && field.required && field.default === undefined;
                    lines.push(`        ${propertyName(key)}${required ? '' : '?'}: ${inputScalarType(field, !required)};`);
                }
                lines.push('    };');
            } else {
                lines.push('    meta?: Record<string, unknown>;');
            }
            lines.push('    categories?: number[];', '    tags?: number[];');
            if (operation === 'Update') lines.push('    autosave?: boolean;');
            lines.push('}', '');
        }
    }

    // The generic REST surface also accepts schemas registered at runtime. Its field set is still
    // derived from the built-in F1 declarations; exact per-type DTOs above retain discriminators and
    // enum literals for callers that know the type at compile time.
    const genericFields = new Map<string, { types: Set<string>; present: number; required: number; nullable: boolean }>();
    for (const schema of exposed) {
        for (const [fieldName, field] of Object.entries(schema.fields)) {
            if (field.storage.kind === 'meta' || field.storage.kind === 'computed') continue;
            const wireName = CONTENT_FIELD_WIRE_NAMES[fieldName];
            if (!wireName) continue;
            const current = genericFields.get(wireName)
                || { types: new Set<string>(), present: 0, required: 0, nullable: false };
            current.types.add(inputScalarType(field, false));
            current.present++;
            if (field.required && field.default === undefined) current.required++;
            if (!field.multiple) current.nullable = true;
            genericFields.set(wireName, current);
        }
    }

    for (const operation of ['Create', 'Update'] as const) {
        lines.push(`export interface Content${operation}Input {`, '    type?: string | null;');
        for (const [wireName, info] of genericFields) {
            const required = operation === 'Create' && info.present === exposed.length && info.required === exposed.length;
            const nullable = !required && info.nullable ? ' | null' : '';
            lines.push(`    ${propertyName(wireName)}${required ? '' : '?'}: ${[...info.types].sort().join(' | ')}${nullable};`);
        }
        lines.push('    categories?: number[];', '    tags?: number[];', '    meta?: Record<string, unknown>;');
        if (operation === 'Update') lines.push('    autosave?: boolean;');
        lines.push('}', '');
    }
    lines.push(
        `export type CoreContentCreateInput = ${exposed.map((schema) => `Content${pascal(schema.name)}CreateInput`).join(' | ')};`,
        `export type CoreContentUpdateInput = ${exposed.map((schema) => `Content${pascal(schema.name)}UpdateInput`).join(' | ')};`,
        '',
    );
    return lines;
}

function generatedFields(schemas: Schema[]): string[] {
    const lines: string[] = [];
    for (const schema of schemas) {
        lines.push(`export interface ${pascal(schema.name)}Fields {`);
        for (const [name, field] of Object.entries(schema.fields)) {
            lines.push(`    ${name}${field.required ? '' : '?'}: ${scalarType(field)};`);
        }
        lines.push('}', '');
    }
    lines.push('export interface CoreContentFieldMap {');
    schemas.forEach((schema) => lines.push(`    ${schema.name}: ${pascal(schema.name)}Fields;`));
    lines.push('}', '');
    return lines;
}

function commonPrefix(schemas: Schema[]): string[] {
    const names = schemas.map((schema) => quote(schema.name)).join(', ');
    return [
        '/* Generated by backend/scripts/generate-f2-contracts.ts. Do not edit. */',
        '',
        'export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };',
        '',
        `export const CORE_CONTENT_TYPES = [${names}] as const;`,
        'export type CoreContentTypeName = typeof CORE_CONTENT_TYPES[number];',
        '',
        ...generatedFields(schemas),
        'export interface ContentTermRef {',
        '    id: number;',
        '    name: string;',
        '    slug: string;',
        '}',
        '',
        'export interface ContentRecord {',
        '    id: number;',
        '    title: string;',
        '    slug: string;',
        '    content: string;',
        '    excerpt: string;',
        '    status: string;',
        '    type: string;',
        '    date: string;',
        '    dateGmt?: string;',
        '    author: { id: number; displayName: string };',
        '    commentStatus: string;',
        '    meta?: Record<string, unknown>;',
        '    featuredMedia?: { id: number; url: string; title?: string };',
        '    categories?: ContentTermRef[];',
        '    tags?: ContentTermRef[];',
        '    language?: string | null;',
        '    translations?: Array<{ id: number; language: string; slug: string; type: string; status?: string }>;',
        '}',
        '',
        ...generatedMutationDtos(schemas),
    ];
}

function renderBackend(schemas: Schema[]): string {
    return [...commonPrefix(schemas),
        'export interface ContentListQuery {',
        '    page?: string;',
        '    per_page?: string;',
        '    status?: string;',
        '    type?: string;',
        '    author?: string;',
        '    search?: string;',
        '    orderby?: string;',
        '    order?: string;',
        '    categories?: string;',
        '    tags?: string;',
        '}',
        '',
        'export type Post = ContentRecord;',
        'export type PostTermRef = ContentTermRef;',
        '',
    ].join('\n');
}

function renderFrontend(schemas: Schema[]): string {
    return [...commonPrefix(schemas),
        'export interface ContentListOptions {',
        '    type?: string;',
        '    status?: string;',
        '    page?: number;',
        '    perPage?: number;',
        '    search?: string;',
        '}',
        '',
        'export interface PagedResult<T> {',
        '    data: T;',
        '    total: number;',
        '    totalPages: number;',
        '}',
        '',
        'export interface ContentTransport {',
        '    get<T>(path: string): Promise<T>;',
        '    getPaged<T>(path: string): Promise<PagedResult<T>>;',
        '    post<T>(path: string, body: unknown): Promise<T>;',
        '    put<T>(path: string, body: unknown): Promise<T>;',
        '    delete<T>(path: string): Promise<T>;',
        '}',
        '',
        'export function createContentClient(transport: ContentTransport) {',
        '    return {',
        '        listPaged(opts: ContentListOptions = {}) {',
        "            const params = new URLSearchParams({ type: opts.type || 'post' });",
        "            if (opts.status) params.append('status', opts.status);",
        "            params.append('page', String(opts.page || 1));",
        "            params.append('per_page', String(opts.perPage || 20));",
        "            if (opts.search) params.append('search', opts.search);",
        '            return transport.getPaged<ContentRecord[]>(`/posts?${params.toString()}`);',
        '        },',
        "        list(type = 'post', status?: string) {",
        '            const params = new URLSearchParams({ type });',
        "            if (status) params.append('status', status);",
        '            return transport.get<ContentRecord[]>(`/posts?${params.toString()}`);',
        '        },',
        '        get(id: number) {',
        '            return transport.get<ContentRecord>(`/posts/${id}`);',
        '        },',
        '        getBySlug(slug: string, type?: string) {',
        "            const query = type ? `?type=${encodeURIComponent(type)}` : '';",
        '            return transport.get<ContentRecord>(`/posts/slug/${encodeURIComponent(slug)}${query}`);',
        '        },',
        '        create(data: ContentCreateInput) {',
        "            return transport.post<ContentRecord>('/posts', data);",
        '        },',
        '        update(id: number, data: ContentUpdateInput) {',
        '            return transport.put<ContentRecord>(`/posts/${id}`, data);',
        '        },',
        '        delete(id: number) {',
        '            return transport.delete<ContentRecord>(`/posts/${id}`);',
        '        },',
        '    };',
        '}',
        '',
        'export type Post = ContentRecord;',
        'export type PostTermRef = ContentTermRef;',
        '',
    ].join('\n');
}

function normalized(text: string): string {
    return text.replace(/\r\n/g, '\n');
}

function main(): void {
    const schemas = (getBuiltinContentSchemas() as Schema[]).sort((a, b) => a.name.localeCompare(b.name));
    const expected: Record<string, string> = {
        backend: renderBackend(schemas),
        frontend: renderFrontend(schemas),
    };
    const write = process.argv.includes('--write');
    let drift = false;
    for (const [name, target] of Object.entries(TARGETS)) {
        if (write) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, expected[name], 'utf8');
            console.log(`generated ${path.relative(ROOT, target)}`);
            continue;
        }
        const actual = fs.existsSync(target) ? normalized(fs.readFileSync(target, 'utf8')) : '';
        if (actual !== expected[name]) {
            drift = true;
            console.error(`F2 generated artifact drift: ${path.relative(ROOT, target)}`);
        }
    }
    if (drift) {
        console.error('Run: npm run generate:f2 -- --write');
        process.exitCode = 1;
    } else if (!write) {
        console.log('F2 generated DTO and frontend client artifacts are in sync.');
    }
}

main();
