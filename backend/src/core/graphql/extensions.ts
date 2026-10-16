/**
 * WordJS - GraphQL schema extensions (the seam plugins and host modules extend the schema through).
 *
 * An extension is SDL plus resolvers:
 *
 *   registerGraphQLExtension({
 *       owner: 'my-plugin',
 *       typeDefs: `
 *           type Book { id: Int! title: String }
 *           extend type Query { books(first: Int, after: String): BookConnection! book(id: Int!): Book }
 *           type BookConnection { nodes: [Book!]! totalCount: Int }
 *       `,
 *       resolvers: {
 *           Query: {
 *               // Resolve through REST so authorization is the route's own (ctx.rest = core/graphql/dispatch).
 *               book: { resolve: async (_root, { id }, ctx) => { … }, cost: { rest: true } },
 *           },
 *       },
 *   });
 *
 * or, from code that runs at boot, through the action hook the schema builder fires:
 *
 *   addAction('wordjs_graphql_register_types', (register) => register({ owner, typeDefs, resolvers }));
 *
 * RULES (enforced here, not by convention):
 *  · An extension may ADD types and ADD fields (`extend type Query`, `extend type ContentNode`, …). It may
 *    not attach a resolver to a field that existed before it — core fields keep core resolvers, so an
 *    extension cannot reroute `posts` around the REST authorization.
 *  · Each extension is validated in isolation against the schema built so far. One that fails (bad SDL,
 *    a type-name clash, a resolver for an unknown or pre-existing field) is logged and SKIPPED; it never
 *    takes the endpoint down for everyone else.
 *  · `cost` on a resolver feeds the query-cost rule (core/graphql/limits). Without it a field costs what a
 *    plain field costs (1 for an object, 0 for a scalar), so a field that does real work — a REST read, a
 *    query — MUST declare `{ rest: true }` and, for a page, `{ list: true }`.
 *
 * SANDBOXED PLUGINS. The action hook is host-only (core/hook-access classifies it `denied`): its argument
 * is a function and its product is executable resolvers, neither of which can cross the isolate boundary.
 * Host modules and in-process code use it today; sandboxed plugins get a declarative, route-backed bridge
 * in a later phase (see documentation/graphql.md).
 */

import { extendSchema, parse, GraphQLSchema, isObjectType, isInterfaceType } from 'graphql';
import type { GraphQLFieldResolver } from 'graphql';
import type { FieldCost } from './limits';

export interface GraphQLResolverSpec {
    resolve: GraphQLFieldResolver<any, any, any>;
    cost?: FieldCost;
}

export interface GraphQLExtension {
    /** Who contributed it (a plugin slug or a core module name) — used in logs and for unregistering. */
    owner: string;
    typeDefs: string;
    resolvers?: Record<string, Record<string, GraphQLResolverSpec | GraphQLFieldResolver<any, any, any>>>;
}

export const REGISTER_HOOK = 'wordjs_graphql_register_types';

const registry: GraphQLExtension[] = [];
let version = 0;

export function registerGraphQLExtension(ext: GraphQLExtension): void {
    if (!ext || typeof ext.owner !== 'string' || !ext.owner || typeof ext.typeDefs !== 'string') {
        throw new TypeError('registerGraphQLExtension: { owner, typeDefs } are required');
    }
    registry.push(ext);
    version++;
}

export function unregisterGraphQLExtensions(owner: string): void {
    let removed = false;
    for (let i = registry.length - 1; i >= 0; i--) {
        if (registry[i].owner === owner) { registry.splice(i, 1); removed = true; }
    }
    if (removed) version++;
}

/** Changes whenever the static registry changes (the hook's callbacks are fingerprinted separately). */
export function registryVersion(): number {
    return version;
}

/** Extensions collected from the action hook for ONE build (host callbacks only; see hooks.doActionSync). */
function collectHookExtensions(): GraphQLExtension[] {
    const collected: GraphQLExtension[] = [];
    try {
        const { doActionSync } = require('../hooks');
        doActionSync('wordjs_graphql_register_types', (ext: GraphQLExtension) => {
            if (ext && typeof ext.owner === 'string' && typeof ext.typeDefs === 'string') collected.push(ext);
        });
    } catch (err: any) {
        console.warn(`[graphql] ${REGISTER_HOOK} callback failed: ${err && err.message}`);
    }
    return collected;
}

/** Identity of the hook's current callbacks — the schema is rebuilt when it changes. */
export function hookFingerprint(): readonly unknown[] {
    try {
        const { hooks } = require('../hooks');
        const list = hooks.actions.get(REGISTER_HOOK) || [];
        return list.map((h: any) => h.callback);
    } catch {
        return [];
    }
}

function fieldMap(schema: GraphQLSchema, typeName: string) {
    const type = schema.getType(typeName);
    return type && (isObjectType(type) || isInterfaceType(type)) ? type.getFields() : null;
}

/** Apply one extension on top of `schema`; throws on any rule violation. */
function applyOne(schema: GraphQLSchema, ext: GraphQLExtension): GraphQLSchema {
    const before = new Map<string, Set<string>>();
    for (const typeName of Object.keys(ext.resolvers || {})) {
        const fields = fieldMap(schema, typeName);
        before.set(typeName, new Set(fields ? Object.keys(fields) : []));
    }
    const next = extendSchema(schema, parse(ext.typeDefs), { assumeValidSDL: false });
    for (const [typeName, resolvers] of Object.entries(ext.resolvers || {})) {
        const fields = fieldMap(next, typeName);
        if (!fields) throw new Error(`resolvers for unknown type ${typeName}`);
        for (const [fieldName, spec] of Object.entries(resolvers || {})) {
            const field: any = fields[fieldName];
            if (!field) throw new Error(`resolver for unknown field ${typeName}.${fieldName}`);
            if (before.get(typeName)!.has(fieldName)) {
                throw new Error(`may not replace the resolver of existing field ${typeName}.${fieldName}`);
            }
            const s: GraphQLResolverSpec = typeof spec === 'function' ? { resolve: spec } : spec;
            if (typeof s.resolve !== 'function') throw new Error(`${typeName}.${fieldName}: resolve must be a function`);
            field.resolve = s.resolve;
            if (s.cost) field.extensions = { ...(field.extensions || {}), cost: s.cost };
        }
    }
    return next;
}

/** The core schema with every valid extension applied (static registry first, then the hook's). */
export function applyExtensions(core: GraphQLSchema): GraphQLSchema {
    let schema = core;
    for (const ext of [...registry, ...collectHookExtensions()]) {
        try {
            schema = applyOne(schema, ext);
        } catch (err: any) {
            console.warn(`[graphql] extension from "${ext.owner}" skipped: ${err && err.message}`);
        }
    }
    return schema;
}
