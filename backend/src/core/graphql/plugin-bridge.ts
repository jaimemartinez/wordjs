/**
 * WordJS - GraphQL for SANDBOXED plugins: a declarative, route-backed schema extension.
 *
 * An isolated plugin cannot hand the host a resolver function (it lives in another process), so it
 * DECLARES its extension instead (wordjs.graphql.extend in the child):
 *
 *   wordjs.graphql.extend({
 *       typeDefs: `
 *           type Book { id: Int! title: String }
 *           extend type Query { books(first: Int): [Book!]! book(id: Int!): Book }
 *       `,
 *       fields: {
 *           'Query.books': { path: '/books', list: true },   // GET /api/v1/plugin/<slug>/books?first=…
 *           'Query.book': { path: '/books/:id' },            // GET /api/v1/plugin/<slug>/books/42
 *       },
 *   });
 *
 * Each declared field is resolved by GETting one of the plugin's OWN routes (wordjs.http.route) AS THE
 * GRAPHQL CALLER: `:name` path segments take the field argument of that name, every other scalar argument
 * goes in the query string, and the route's JSON body is the field's value (a 404 is null). The plugin's
 * route middleware — its `auth`/`admin` options, the site gate — decides who sees what, exactly as for a
 * REST call to that route, and the plugin code that answers runs in its sandbox. Nothing else crosses: the
 * resolvers are built here, on the host, from data.
 *
 * The usual extension rules hold (core/graphql/extensions): new types and new fields only, never a
 * resolver for an existing field; an invalid extension is skipped and logged. Here additionally only
 * `Query.<field>` entry points take a route (nested fields read the route's JSON), at most
 * MAX_FIELDS per plugin, and every routed field is costed as a REST read (a page with `list`).
 */

import { GraphQLError } from 'graphql';
import type { GraphQLExtension, GraphQLResolverSpec } from './extensions';
import type { RestQuery } from './dispatch';

const MAX_TYPEDEFS = 20000;
const MAX_FIELDS = 50;
const FIELD_KEY = /^Query\.([A-Za-z_][A-Za-z0-9_]{0,63})$/;
const PATH_SEGMENT = /^(?:[A-Za-z0-9_.~-]+|:[A-Za-z_][A-Za-z0-9_]{0,63})$/;

export interface PluginFieldSpec { path: string; list?: boolean }
export interface PluginGraphQLDefinition { typeDefs: unknown; fields: unknown }

/** The mount path of a plugin's routes (plugin-isolate mounts them at /api/v1/plugin/<slug>). */
function pluginRoutePrefix(slug: string): string {
    let prefix = '/api/v1';
    try { prefix = String(require('../../config/app').api.prefix || prefix); } catch { /* default */ }
    return `${prefix}/plugin/${slug.replace('theme:', 'theme-')}`;
}

function validPath(p: unknown): p is string {
    if (typeof p !== 'string' || !p.startsWith('/') || p.length > 200) return false;
    const segments = p.slice(1).split('/');
    if (p === '/') return true;
    return segments.every((seg) => seg !== '.' && seg !== '..' && PATH_SEGMENT.test(seg));
}

/**
 * The extension a plugin's declaration describes, or the reason it is refused. `getRouter()` returns the
 * plugin's GET routes for the current request (null while it is not running here).
 */
function buildPluginExtension(
    slug: string,
    site: number,
    def: PluginGraphQLDefinition,
    getRouter: () => any,
): GraphQLExtension | string {
    if (!def || typeof def !== 'object') return 'the definition must be an object { typeDefs, fields }';
    if (typeof def.typeDefs !== 'string' || !def.typeDefs.trim()) return '`typeDefs` must be non-empty SDL';
    if (def.typeDefs.length > MAX_TYPEDEFS) return `\`typeDefs\` is larger than ${MAX_TYPEDEFS} characters`;
    if (!def.fields || typeof def.fields !== 'object' || Array.isArray(def.fields)) return '`fields` must map "Query.<field>" to { path }';
    const entries = Object.entries(def.fields as Record<string, unknown>);
    if (!entries.length) return '`fields` declares no field';
    if (entries.length > MAX_FIELDS) return `at most ${MAX_FIELDS} fields per plugin`;

    const query: Record<string, GraphQLResolverSpec> = Object.create(null);
    for (const [key, raw] of entries) {
        const m = FIELD_KEY.exec(key);
        if (!m) return `"${key}": only Query.<field> entry points can be routed`;
        const spec = raw as PluginFieldSpec;
        if (!spec || typeof spec !== 'object' || !validPath(spec.path)) {
            return `"${key}": \`path\` must be a route path like /books or /books/:id`;
        }
        const routePath = spec.path;
        const params = new Set((routePath.match(/:([A-Za-z_][A-Za-z0-9_]*)/g) || []).map((s) => s.slice(1)));
        query[m[1]] = {
            cost: spec.list ? { rest: true, list: true, defaultFirst: 10 } : { rest: true },
            resolve: async (_root: unknown, args: Record<string, unknown>, ctx: any) => {
                let missing = false;
                const path = routePath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_s, name) => {
                    const v = args ? args[name] : undefined;
                    if (v === undefined || v === null || v === '') { missing = true; return '_'; }
                    return encodeURIComponent(String(v));
                });
                if (missing) return null;
                const qs: RestQuery = {};
                for (const [name, v] of Object.entries(args || {})) {
                    if (params.has(name)) continue;
                    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') qs[name] = v;
                }
                const router = getRouter();
                if (!router) return null; // the plugin is not running on this site
                const { routerGet } = require('./dispatch');
                const r = await routerGet(router, pluginRoutePrefix(slug), ctx.req, path, qs);
                if (r.status >= 200 && r.status < 300) return r.body === undefined ? null : r.body;
                if (r.status === 404) return null;
                throw new GraphQLError(`The plugin route answered ${r.status}.`, {
                    extensions: { code: r.status === 401 ? 'UNAUTHENTICATED' : r.status === 403 ? 'FORBIDDEN' : 'PLUGIN_ROUTE_ERROR', status: r.status },
                });
            },
        };
    }
    return { owner: slug, site, typeDefs: def.typeDefs, resolvers: { Query: query } };
}

module.exports = { buildPluginExtension, pluginRoutePrefix, MAX_FIELDS, MAX_TYPEDEFS };
