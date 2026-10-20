/**
 * WordJS - GraphQL reads beyond the public content surface: users, revisions, members-only access levels
 * and the administrative resources (webhooks, plugins, network sites). Same rule as every other field
 * (core/graphql/dispatch): each one IS the REST read it names, for the same caller, so it is gated
 * exactly as its REST twin —
 *
 *  · users / user(id:)          GET /users (list_users), GET /users/:id (self, or list_users; else null)
 *  · revisions / revision(id:)  GET /revisions/post/:postId, GET /revisions/:id (the entry's edit gate)
 *  · contentAccessLevels         GET /content-access/levels (edit_posts)
 *  · webhooks / webhook(id:)     GET /webhooks, GET /webhooks/:id, …/deliveries (administrators)
 *  · plugins                     GET /plugins (administrators)
 *  · networkSites                GET /network/sites (network administrators, interactive session only)
 *
 * A REST refusal (401/403) is a field error carrying the REST code; a single lookup REST answers 404 is
 * null, as for the content reads.
 */

import {
    GraphQLBoolean,
    GraphQLError,
    GraphQLInt,
    GraphQLList,
    GraphQLNonNull,
    GraphQLObjectType,
    GraphQLString,
} from 'graphql';
import type { GraphQLFieldConfig } from 'graphql';
import { GraphQLJSON, connectionOf, decodeCursor, fetchPage, restError } from './schema';
import type { GraphQLContext } from './schema';

const REST_ONE = { cost: { rest: true } };
const REST_LIST = (defaultFirst = 10) => ({ cost: { rest: true, list: true, defaultFirst } });

const pageArgs = {
    first: { type: GraphQLInt, description: 'Page size (1..maxPageSize, default 10).' },
    after: { type: GraphQLString, description: 'Return items after this cursor.' },
};

function ok(r: { status: number; body: any; headers: Record<string, string> }): any {
    if (r.status >= 200 && r.status < 300) return r.body;
    throw restError(r);
}
function okOrNull(r: { status: number; body: any; headers: Record<string, string> }): any {
    return r.status === 404 ? null : ok(r);
}

const nonNullString = new GraphQLNonNull(GraphQLString);
const stringList = new GraphQLList(nonNullString);

// ─── Users ──────────────────────────────────────────────────────────────────────────────────────────

export const UserType = new GraphQLObjectType({
    name: 'User',
    description: 'A user account as GET /users/:id returns it — to the account itself or a holder of list_users.',
    fields: {
        id: { type: new GraphQLNonNull(GraphQLInt) },
        username: { type: GraphQLString },
        email: { type: GraphQLString },
        displayName: { type: GraphQLString },
        role: { type: GraphQLString },
        capabilities: { type: GraphQLJSON },
        personalEmail: { type: GraphQLString },
        professionalMailbox: { type: GraphQLBoolean },
        url: { type: GraphQLString, resolve: (u) => u.url ?? u.user_url ?? null },
        registered: { type: GraphQLString, resolve: (u) => u.registered ?? u.user_registered ?? null },
        meta: { type: GraphQLJSON, description: 'The meta map REST exposes (sensitive keys are never serialized).' },
    },
});

// ─── Revisions ──────────────────────────────────────────────────────────────────────────────────────

export const RevisionType = new GraphQLObjectType({
    name: 'Revision',
    fields: {
        id: { type: new GraphQLNonNull(GraphQLInt) },
        postId: { type: GraphQLInt },
        authorId: { type: GraphQLInt },
        title: { type: GraphQLString },
        content: { type: GraphQLString },
        excerpt: { type: GraphQLString },
        modified: { type: GraphQLString },
        restore: { type: GraphQLJSON, description: 'What restoring it brings back (REST `restore`).' },
        source: { type: GraphQLJSON, description: 'null for a person\'s save; the agent for an AI agent\'s.' },
        meta: { type: GraphQLJSON },
    },
});

/**
 * GET /revisions/post/:postId pages with limit/offset and answers `{ revisions, total }`; the connection
 * maps `first`/`after` onto it so it reads like every other list.
 */
export async function revisionPage(ctx: GraphQLContext, postId: number, args: any) {
    const max = ctx.maxPageSize;
    const first = args.first === undefined || args.first === null ? 10 : args.first;
    if (!Number.isInteger(first) || first < 1 || first > max) {
        throw new GraphQLError(`"first" must be an integer between 1 and ${max}.`, { extensions: { code: 'BAD_USER_INPUT' } });
    }
    const start = args.after ? decodeCursor(args.after) + 1 : 0;
    const body = ok(await ctx.rest.get(`/revisions/post/${postId}`, { limit: first, offset: start }));
    const items = body && Array.isArray(body.revisions) ? body.revisions : [];
    const total = body && Number.isFinite(Number(body.total)) ? Number(body.total) : null;
    return { items, start, first, total };
}

// ─── Members-only access levels ─────────────────────────────────────────────────────────────────────

export const ContentAccessLevelsType = new GraphQLObjectType({
    name: 'ContentAccessLevels',
    fields: {
        metaKey: { type: GraphQLString, description: 'The meta key an entry\'s access level is stored under.' },
        levels: { type: GraphQLJSON, description: 'The levels the editor may offer, as GET /content-access/levels lists them.' },
    },
});

// ─── Webhooks ───────────────────────────────────────────────────────────────────────────────────────

export const WebhookDeliveryType = new GraphQLObjectType({
    name: 'WebhookDelivery',
    fields: {
        id: { type: new GraphQLNonNull(GraphQLInt) },
        event: { type: GraphQLString },
        status: { type: GraphQLString },
        attempts: { type: GraphQLInt },
        responseStatus: { type: GraphQLInt },
        raw: { type: GraphQLJSON, description: 'The delivery exactly as REST lists it.', resolve: (d) => d },
    },
});

export const WebhookType = new GraphQLObjectType({
    name: 'Webhook',
    description: 'A webhook endpoint (administrators). The signing secret is never readable; only its prefix.',
    fields: () => ({
        id: { type: new GraphQLNonNull(GraphQLInt) },
        userId: { type: GraphQLInt },
        name: { type: GraphQLString },
        url: { type: GraphQLString },
        events: { type: stringList },
        secretPrefix: { type: GraphQLString },
        active: { type: GraphQLBoolean },
        failureCount: { type: GraphQLInt },
        lastDeliveryAt: { type: GraphQLInt },
        createdAt: { type: GraphQLString },
        deliveries: {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(WebhookDeliveryType))),
            description: 'The latest deliveries (GET /webhooks/:id/deliveries).',
            extensions: REST_ONE,
            resolve: async (w, _a, ctx: GraphQLContext) => {
                const body = ok(await ctx.rest.get(`/webhooks/${w.id}/deliveries`));
                return body && Array.isArray(body.deliveries) ? body.deliveries : [];
            },
        },
    }),
});

// ─── Plugins ────────────────────────────────────────────────────────────────────────────────────────

export const PluginType = new GraphQLObjectType({
    name: 'Plugin',
    description: 'An installed plugin as the administrators\' GET /plugins lists it.',
    fields: {
        slug: { type: nonNullString },
        name: { type: GraphQLString },
        version: { type: GraphQLString },
        description: { type: GraphQLString },
        author: { type: GraphQLJSON },
        active: { type: GraphQLBoolean },
        broken: { type: GraphQLBoolean },
        requestedPermissions: { type: GraphQLJSON },
        grantedPermissions: { type: GraphQLJSON },
        raw: { type: GraphQLJSON, description: 'The plugin entry exactly as REST lists it.', resolve: (p) => p },
    },
});

// ─── Network ────────────────────────────────────────────────────────────────────────────────────────

export const NetworkSiteType = new GraphQLObjectType({
    name: 'NetworkSite',
    fields: {
        id: { type: new GraphQLNonNull(GraphQLInt) },
        slug: { type: GraphQLString },
        url: { type: GraphQLString },
        host: { type: GraphQLString },
        status: { type: GraphQLString },
        main: { type: GraphQLBoolean },
        createdAt: { type: GraphQLString },
        updatedAt: { type: GraphQLString },
    },
});

// ─── Query fields ───────────────────────────────────────────────────────────────────────────────────

type Field = GraphQLFieldConfig<any, GraphQLContext>;

export function buildResourceQueryFields(): Record<string, Field> {
    return {
        users: {
            type: new GraphQLNonNull(connectionOf('User', UserType)),
            description: 'GET /users — needs list_users, exactly as REST.',
            args: {
                ...pageArgs,
                search: { type: GraphQLString },
                role: { type: GraphQLString },
                orderBy: { type: GraphQLString, description: 'id, user_login, display_name, user_email or user_registered.' },
                order: { type: GraphQLString, description: 'asc or desc.' },
            },
            extensions: REST_LIST(),
            resolve: (_r, args, ctx) => fetchPage(ctx, '/users', {
                search: args.search, role: args.role, orderby: args.orderBy, order: args.order,
            }, args),
        },
        user: {
            type: UserType,
            description: 'GET /users/:id — the caller themself, or anyone for a holder of list_users; null otherwise.',
            args: { id: { type: new GraphQLNonNull(GraphQLInt) } },
            extensions: REST_ONE,
            resolve: async (_r, args, ctx) => okOrNull(await ctx.rest.get(`/users/${args.id}`)),
        },
        revisions: {
            type: new GraphQLNonNull(connectionOf('Revision', RevisionType)),
            description: 'GET /revisions/post/:postId — the entry\'s own edit gate decides.',
            args: { postId: { type: new GraphQLNonNull(GraphQLInt) }, ...pageArgs },
            extensions: REST_LIST(),
            resolve: (_r, args, ctx) => revisionPage(ctx, args.postId, args),
        },
        revision: {
            type: RevisionType,
            description: 'GET /revisions/:id.',
            args: { id: { type: new GraphQLNonNull(GraphQLInt) } },
            extensions: REST_ONE,
            resolve: async (_r, args, ctx) => okOrNull(await ctx.rest.get(`/revisions/${args.id}`)),
        },
        contentAccessLevels: {
            type: ContentAccessLevelsType,
            description: 'GET /content-access/levels — the members-only levels the editor may offer (edit_posts).',
            extensions: REST_ONE,
            resolve: async (_r, _a, ctx) => ok(await ctx.rest.get('/content-access/levels')),
        },
        webhooks: {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(WebhookType))),
            description: 'GET /webhooks (administrators).',
            extensions: REST_ONE,
            resolve: async (_r, _a, ctx) => {
                const body = ok(await ctx.rest.get('/webhooks'));
                return body && Array.isArray(body.webhooks) ? body.webhooks : [];
            },
        },
        webhook: {
            type: WebhookType,
            description: 'GET /webhooks/:id (administrators).',
            args: { id: { type: new GraphQLNonNull(GraphQLInt) } },
            extensions: REST_ONE,
            resolve: async (_r, args, ctx) => {
                const body = okOrNull(await ctx.rest.get(`/webhooks/${args.id}`));
                return body && body.webhook ? body.webhook : body;
            },
        },
        webhookEvents: {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
            description: 'GET /webhooks/events — the event names an endpoint may subscribe to (administrators).',
            extensions: REST_ONE,
            resolve: async (_r, _a, ctx) => {
                const body = ok(await ctx.rest.get('/webhooks/events'));
                const events = Array.isArray(body) ? body : (body && Array.isArray(body.events) ? body.events : []);
                return events.map((e: any) => (typeof e === 'string' ? e : String(e && (e.name || e.event))));
            },
        },
        plugins: {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PluginType))),
            description: 'GET /plugins (administrators).',
            extensions: REST_ONE,
            resolve: async (_r, _a, ctx) => {
                const body = ok(await ctx.rest.get('/plugins'));
                return Array.isArray(body) ? body : (body && Array.isArray(body.plugins) ? body.plugins : []);
            },
        },
        networkSites: {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(NetworkSiteType))),
            description: 'GET /network/sites (network administrators, interactive session only).',
            extensions: REST_ONE,
            resolve: async (_r, _a, ctx) => {
                const body = ok(await ctx.rest.get('/network/sites'));
                return body && Array.isArray(body.sites) ? body.sites : [];
            },
        },
    };
}

/** Every read added here and the REST read it performs (asserted by the tests, like MUTATION_REST_TWINS). */
export const RESOURCE_REST_TWINS: Readonly<Record<string, string>> = Object.freeze({
    users: 'GET /users',
    user: 'GET /users/:id',
    revisions: 'GET /revisions/post/:postId',
    revision: 'GET /revisions/:id',
    contentAccessLevels: 'GET /content-access/levels',
    webhooks: 'GET /webhooks',
    webhook: 'GET /webhooks/:id',
    webhookEvents: 'GET /webhooks/events',
    plugins: 'GET /plugins',
    networkSites: 'GET /network/sites',
});
