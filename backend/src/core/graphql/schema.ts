/**
 * WordJS - GraphQL schema: the Query root and its object types. Mutations live in core/graphql/mutations,
 * the reads of users/revisions/administrative resources in core/graphql/resources and the Subscription
 * root in core/graphql/subscriptions; buildCoreSchema assembles all four.
 *
 * EVERY RESOLVER THAT TOUCHES DATA IS A REST READ (core/graphql/dispatch). A field never loads a model
 * itself: `posts` is `GET /posts`, `post(id:)` is `GET /posts/:id`, `Comment` lists are `GET /comments`,
 * and nested objects the REST payload already embeds (a post's author, featured image, categories and
 * tags) are read straight from that payload. What a caller can see through this schema is therefore
 * exactly what the same caller sees through the REST API, field for field — drafts, private entries,
 * password-protected bodies, non-public types, hidden attachments and unapproved comments included.
 *
 * Conventions:
 *  · A single-object lookup that REST answers 404 (absent OR not visible to this caller — REST does not
 *    distinguish, so neither does this) resolves to null. Any other non-2xx becomes a GraphQL error
 *    carrying the REST `code` and HTTP `status` in `extensions`.
 *  · Lists are cursor connections over REST's page/per_page. `first` is 1..maxPageSize (default 10);
 *    `after` is an opaque cursor. `totalCount` is REST's X-WP-Total.
 *  · `extensions.cost` on a field feeds the cost rule (core/graphql/limits).
 */

import {
    GraphQLBoolean,
    GraphQLEnumType,
    GraphQLError,
    GraphQLInt,
    GraphQLList,
    GraphQLNonNull,
    GraphQLObjectType,
    GraphQLScalarType,
    GraphQLSchema,
    GraphQLString,
    Kind,
} from 'graphql';
import type { GraphQLFieldConfig, GraphQLFieldConfigArgumentMap, ValueNode } from 'graphql';
import type { Request } from 'express';
import type { RestClient, RestQuery, RestResult } from './dispatch';
import type { FieldCost } from './limits';

export interface GraphQLContext {
    req: Request;
    rest: RestClient;
    maxPageSize: number;
}

// ─── Scalars ────────────────────────────────────────────────────────────────────────────────────────

function literalToJs(ast: ValueNode): any {
    switch (ast.kind) {
        case Kind.STRING:
        case Kind.BOOLEAN:
            return ast.value;
        case Kind.INT:
        case Kind.FLOAT:
            return Number(ast.value);
        case Kind.LIST:
            return ast.values.map(literalToJs);
        case Kind.OBJECT: {
            const out: Record<string, any> = Object.create(null);
            for (const f of ast.fields) out[f.name.value] = literalToJs(f.value);
            return out;
        }
        default:
            return null;
    }
}

/** Arbitrary JSON (meta bags, media details, labels) — exactly what REST returns for that key. */
export const GraphQLJSON = new GraphQLScalarType({
    name: 'JSON',
    description: 'Arbitrary JSON value, passed through unchanged from the REST representation.',
    serialize: (v) => v,
    parseValue: (v) => v,
    parseLiteral: literalToJs,
});

// ─── REST plumbing ──────────────────────────────────────────────────────────────────────────────────

export function restError(result: RestResult): GraphQLError {
    const body = result.body && typeof result.body === 'object' ? result.body : {};
    const message = typeof body.message === 'string' ? body.message
        : typeof body.error === 'string' ? body.error
            : `Request failed with status ${result.status}.`;
    return new GraphQLError(message, {
        extensions: { code: typeof body.code === 'string' ? body.code : 'REST_ERROR', status: result.status },
    });
}

function ok(result: RestResult): any {
    if (result.status >= 200 && result.status < 300) return result.body;
    throw restError(result);
}

/** 404 → null (absent or invisible to this caller); any other failure is an error. */
function okOrNull(result: RestResult): any {
    if (result.status === 404) return null;
    return ok(result);
}

const CURSOR_PREFIX = 'wjs:';

export function encodeCursor(offset: number): string {
    return Buffer.from(`${CURSOR_PREFIX}${offset}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): number {
    let raw = '';
    try { raw = Buffer.from(String(cursor), 'base64url').toString('utf8'); } catch { /* fall through */ }
    const n = raw.startsWith(CURSOR_PREFIX) ? Number(raw.slice(CURSOR_PREFIX.length)) : NaN;
    if (!Number.isSafeInteger(n) || n < 0) {
        throw new GraphQLError('Invalid cursor.', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    return n;
}

function pageSize(first: unknown, fallback: number, max: number): number {
    if (first === undefined || first === null) return Math.min(fallback, max);
    if (typeof first !== 'number' || !Number.isInteger(first) || first < 1 || first > max) {
        throw new GraphQLError(`"first" must be an integer between 1 and ${max}.`, { extensions: { code: 'BAD_USER_INPUT' } });
    }
    return first;
}

interface Page { items: any[]; start: number; first: number; total: number | null }

/**
 * Read the window [start, start+first) of a REST list. Aligned windows are one REST page; a window that
 * straddles two REST pages (an `after` cursor from a page of another size) is two reads, sliced.
 */
export async function fetchPage(ctx: GraphQLContext, path: string, query: RestQuery, args: any, defaultFirst = 10): Promise<Page> {
    const first = pageSize(args.first, defaultFirst, ctx.maxPageSize);
    const start = args.after ? decodeCursor(args.after) + 1 : 0;
    const read = async (page: number) => {
        const r = await ctx.rest.get(path, { ...query, per_page: first, page });
        const body = ok(r);
        const total = r.headers['x-wp-total'] !== undefined ? parseInt(r.headers['x-wp-total'], 10) : null;
        return { body: Array.isArray(body) ? body : [], total: Number.isFinite(total as number) ? total : null };
    };
    const page = Math.floor(start / first) + 1;
    const skip = start % first;
    const a = await read(page);
    let items = a.body;
    if (skip > 0) {
        const b = await read(page + 1);
        items = items.concat(b.body).slice(skip, skip + first);
    }
    return { items, start, first, total: a.total };
}

// ─── Connections ────────────────────────────────────────────────────────────────────────────────────

export const PageInfoType = new GraphQLObjectType({
    name: 'PageInfo',
    fields: {
        hasNextPage: { type: new GraphQLNonNull(GraphQLBoolean) },
        hasPreviousPage: { type: new GraphQLNonNull(GraphQLBoolean) },
        startCursor: { type: GraphQLString },
        endCursor: { type: GraphQLString },
    },
});

const connectionTypes = new Map<string, GraphQLObjectType>();

/** `<Name>Connection` with edges/nodes/pageInfo/totalCount over a resolved Page. */
export function connectionOf(name: string, nodeType: GraphQLObjectType): GraphQLObjectType {
    const existing = connectionTypes.get(name);
    if (existing) return existing;
    const edge = new GraphQLObjectType({
        name: `${name}Edge`,
        fields: {
            cursor: { type: new GraphQLNonNull(GraphQLString) },
            node: { type: new GraphQLNonNull(nodeType) },
        },
    });
    const conn = new GraphQLObjectType({
        name: `${name}Connection`,
        fields: {
            edges: {
                type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(edge))),
                resolve: (p: Page) => p.items.map((node, i) => ({ cursor: encodeCursor(p.start + i), node })),
            },
            nodes: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(nodeType))), resolve: (p: Page) => p.items },
            pageInfo: {
                type: new GraphQLNonNull(PageInfoType),
                resolve: (p: Page) => ({
                    hasNextPage: p.total !== null ? p.start + p.first < p.total : p.items.length >= p.first,
                    hasPreviousPage: p.start > 0,
                    startCursor: p.items.length ? encodeCursor(p.start) : null,
                    endCursor: p.items.length ? encodeCursor(p.start + p.items.length - 1) : null,
                }),
            },
            totalCount: {
                type: GraphQLInt,
                description: 'Total matching items for this caller (REST X-WP-Total).',
                resolve: (p: Page) => p.total,
            },
        },
    });
    connectionTypes.set(name, conn);
    return conn;
}

const pageArgs: GraphQLFieldConfigArgumentMap = {
    first: { type: GraphQLInt, description: 'Page size (1..maxPageSize, default 10).' },
    after: { type: GraphQLString, description: 'Return items after this cursor.' },
};

const cost = (c: FieldCost) => ({ cost: c });
const REST_ONE = cost({ rest: true });
const REST_LIST = (defaultFirst = 10) => cost({ rest: true, list: true, defaultFirst });

const OrderType = new GraphQLEnumType({
    name: 'Order',
    values: { ASC: { value: 'asc' }, DESC: { value: 'desc' } },
});

const ContentOrderByType = new GraphQLEnumType({
    name: 'ContentOrderBy',
    values: {
        DATE: { value: 'date' }, MODIFIED: { value: 'modified' }, TITLE: { value: 'title' },
        ID: { value: 'id' }, MENU_ORDER: { value: 'menu_order' },
    },
});

const MediaOrderByType = new GraphQLEnumType({
    name: 'MediaOrderBy',
    values: { DATE: { value: 'date' }, MODIFIED: { value: 'modified' }, TITLE: { value: 'title' }, ID: { value: 'id' } },
});

const CommentOrderByType = new GraphQLEnumType({
    name: 'CommentOrderBy',
    values: { DATE: { value: 'date' }, ID: { value: 'id' } },
});

const TermOrderByType = new GraphQLEnumType({
    name: 'TermOrderBy',
    values: {
        NAME: { value: 'name' }, SLUG: { value: 'slug' }, COUNT: { value: 'count' }, ID: { value: 'term_id' },
    },
});

const csv = (v: unknown): string | undefined => (Array.isArray(v) && v.length ? v.map(String).join(',') : undefined);
const nonNullString = new GraphQLNonNull(GraphQLString);
const stringList = new GraphQLList(nonNullString);

// ─── Object types ───────────────────────────────────────────────────────────────────────────────────

export const AuthorType = new GraphQLObjectType({
    name: 'Author',
    description: 'The public identity of a content author (never the login or email).',
    fields: {
        id: { type: new GraphQLNonNull(GraphQLInt) },
        name: { type: GraphQLString, resolve: (a) => a.displayName },
        slug: { type: GraphQLString },
    },
});

export const TermRefType = new GraphQLObjectType({
    name: 'TermRef',
    fields: {
        id: { type: new GraphQLNonNull(GraphQLInt) },
        name: { type: GraphQLString },
        slug: { type: GraphQLString },
    },
});

// Thunks: ContentNode ↔ Comment ↔ Term reference each other.
export let ContentNodeType: GraphQLObjectType;
export let MediaItemType: GraphQLObjectType;

export const FeaturedMediaType: GraphQLObjectType = new GraphQLObjectType({
    name: 'FeaturedMedia',
    fields: () => ({
        id: { type: new GraphQLNonNull(GraphQLInt) },
        url: { type: GraphQLString },
        path: { type: GraphQLString },
        title: { type: GraphQLString },
        mediaItem: {
            type: MediaItemType,
            description: 'The full media item (GET /media/:id).',
            extensions: REST_ONE,
            resolve: async (f, _a, ctx: GraphQLContext) => okOrNull(await ctx.rest.get(`/media/${f.id}`)),
        },
    }),
});

export const CommentType: GraphQLObjectType = new GraphQLObjectType({
    name: 'Comment',
    description: 'An approved comment, as GET /comments returns it.',
    fields: () => ({
        id: { type: new GraphQLNonNull(GraphQLInt) },
        postId: { type: GraphQLInt },
        authorName: { type: GraphQLString, resolve: (c) => c.author },
        authorUrl: { type: GraphQLString },
        authorAvatarUrl: { type: GraphQLString },
        authorEmail: { type: GraphQLString, description: 'Only for a moderator, as on REST (null otherwise).' },
        userId: { type: GraphQLInt },
        date: { type: GraphQLString },
        dateGmt: { type: GraphQLString },
        content: { type: GraphQLString },
        status: { type: GraphQLString },
        type: { type: GraphQLString },
        parentId: { type: GraphQLInt, resolve: (c) => c.parent },
        replies: {
            type: new GraphQLNonNull(connectionOf('Comment', CommentType)),
            args: { ...pageArgs },
            extensions: REST_LIST(),
            resolve: (c, args, ctx: GraphQLContext) => fetchPage(ctx, '/comments', { post: c.postId, parent: c.id }, args),
        },
    }),
});

export const TermType: GraphQLObjectType = new GraphQLObjectType({
    name: 'Term',
    fields: () => ({
        id: { type: new GraphQLNonNull(GraphQLInt) },
        name: { type: GraphQLString },
        slug: { type: GraphQLString },
        taxonomy: { type: GraphQLString },
        description: { type: GraphQLString },
        parentId: { type: GraphQLInt, resolve: (t) => t.parent },
        count: { type: GraphQLInt },
        contentNodes: {
            type: new GraphQLNonNull(connectionOf('Content', ContentNodeType)),
            description: 'Published posts carrying this category or tag (GET /posts?categories= / ?tags=).',
            args: { ...pageArgs },
            extensions: REST_LIST(),
            resolve: (t, args, ctx: GraphQLContext) => {
                const key = t.taxonomy === 'post_tag' ? 'tags' : t.taxonomy === 'category' ? 'categories' : null;
                if (!key) return { items: [], start: 0, first: 1, total: 0 };
                return fetchPage(ctx, '/posts', { [key]: t.id }, args);
            },
        },
    }),
});

ContentNodeType = new GraphQLObjectType({
    name: 'ContentNode',
    description: 'A post, page or custom-post-type entry, exactly as GET /posts/:id returns it to this caller.',
    fields: () => ({
        id: { type: new GraphQLNonNull(GraphQLInt) },
        type: { type: GraphQLString },
        slug: { type: GraphQLString },
        status: { type: GraphQLString },
        title: { type: GraphQLString },
        excerpt: { type: GraphQLString },
        content: { type: GraphQLString, description: 'Rendered body. Empty for a password-protected entry this caller does not manage.' },
        date: { type: GraphQLString },
        dateGmt: { type: GraphQLString },
        modified: { type: GraphQLString },
        modifiedGmt: { type: GraphQLString },
        link: { type: GraphQLString },
        protected: { type: GraphQLBoolean },
        menuOrder: { type: GraphQLInt },
        commentStatus: { type: GraphQLString },
        pingStatus: { type: GraphQLString },
        mimeType: { type: GraphQLString },
        language: { type: GraphQLString },
        translations: { type: GraphQLJSON },
        meta: { type: GraphQLJSON, description: 'The meta map REST exposes to this caller.' },
        authorId: { type: GraphQLInt },
        author: { type: AuthorType },
        parentId: { type: GraphQLInt, resolve: (p) => p.parent },
        parent: {
            type: ContentNodeType,
            extensions: REST_ONE,
            resolve: async (p, _a, ctx: GraphQLContext) => (p.parent > 0 ? okOrNull(await ctx.rest.get(`/posts/${p.parent}`)) : null),
        },
        featuredMedia: { type: FeaturedMediaType },
        categories: { type: new GraphQLList(new GraphQLNonNull(TermRefType)) },
        tags: { type: new GraphQLList(new GraphQLNonNull(TermRefType)) },
        revisions: {
            type: new GraphQLNonNull(connectionOf('Revision', require('./resources').RevisionType)),
            description: 'Saved revisions (GET /revisions/post/:id) — an error for a caller who may not edit the entry, as on REST.',
            args: { ...pageArgs },
            extensions: REST_LIST(),
            resolve: (p, args, ctx: GraphQLContext) => require('./resources').revisionPage(ctx, p.id, args),
        },
        comments: {
            type: new GraphQLNonNull(connectionOf('Comment', CommentType)),
            description: 'Approved comments on this entry (GET /comments?post=).',
            args: { ...pageArgs, orderBy: { type: CommentOrderByType }, order: { type: OrderType } },
            extensions: REST_LIST(),
            resolve: (p, args, ctx: GraphQLContext) =>
                fetchPage(ctx, '/comments', { post: p.id, orderby: args.orderBy, order: args.order }, args),
        },
    }),
});

MediaItemType = new GraphQLObjectType({
    name: 'MediaItem',
    description: 'A media library item, exactly as GET /media/:id returns it to this caller.',
    fields: () => ({
        id: { type: new GraphQLNonNull(GraphQLInt) },
        slug: { type: GraphQLString },
        title: { type: GraphQLString },
        description: { type: GraphQLString },
        caption: { type: GraphQLString },
        alt: { type: GraphQLString },
        authorId: { type: GraphQLInt, resolve: (m) => m.author },
        parentId: { type: GraphQLInt, resolve: (m) => m.parent },
        visibility: { type: GraphQLString },
        mimeType: { type: GraphQLString },
        url: { type: GraphQLString, description: 'Absolute URL.', resolve: (m) => m.guid },
        sourceUrl: { type: GraphQLString, description: 'Site-relative path (or the remote URL of an offloaded file).' },
        date: { type: GraphQLString },
        dateGmt: { type: GraphQLString },
        modified: { type: GraphQLString },
        modifiedGmt: { type: GraphQLString },
        mediaDetails: { type: GraphQLJSON },
    }),
});

export const TaxonomyType = new GraphQLObjectType({
    name: 'Taxonomy',
    fields: {
        name: { type: nonNullString },
        label: { type: GraphQLString },
        labels: { type: GraphQLJSON },
        description: { type: GraphQLString },
        public: { type: GraphQLBoolean },
        hierarchical: { type: GraphQLBoolean },
        postTypes: { type: stringList },
        rewrite: { type: GraphQLJSON },
    },
});

export const ContentTypeType = new GraphQLObjectType({
    name: 'ContentType',
    fields: {
        name: { type: nonNullString },
        label: { type: GraphQLString },
        labels: { type: GraphQLJSON },
        description: { type: GraphQLString },
        public: { type: GraphQLBoolean },
        hierarchical: { type: GraphQLBoolean },
        hasArchive: { type: GraphQLJSON },
        supports: { type: GraphQLJSON },
        taxonomies: { type: GraphQLJSON },
        menuIcon: { type: GraphQLString },
    },
});

export const MenuItemType: GraphQLObjectType = new GraphQLObjectType({
    name: 'MenuItem',
    fields: () => ({
        id: { type: new GraphQLNonNull(GraphQLInt) },
        menuId: { type: GraphQLInt },
        title: { type: GraphQLString },
        url: { type: GraphQLString },
        target: { type: GraphQLString },
        type: { type: GraphQLString },
        objectId: { type: GraphQLInt },
        parentId: { type: GraphQLInt, resolve: (i) => i.parent },
        order: { type: GraphQLInt },
        classes: { type: GraphQLString },
    }),
});

export const MenuType = new GraphQLObjectType({
    name: 'Menu',
    fields: {
        id: { type: new GraphQLNonNull(GraphQLInt) },
        name: { type: GraphQLString },
        slug: { type: GraphQLString },
        description: { type: GraphQLString },
        items: {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(MenuItemType))),
            description: 'Flat list of items in display order; build the tree with parentId.',
            extensions: REST_ONE,
            resolve: async (m, _a, ctx: GraphQLContext) => {
                if (Array.isArray(m.items)) return m.items;
                const full = okOrNull(await ctx.rest.get(`/menus/${m.id}`));
                return full && Array.isArray(full.items) ? full.items : [];
            },
        },
    },
});

/** Typed view of GET /settings (the public subset). `all` returns the whole public map. */
export const SettingsType = new GraphQLObjectType({
    name: 'Settings',
    fields: {
        title: { type: GraphQLString, resolve: (s) => s.blogname },
        description: { type: GraphQLString, resolve: (s) => s.blogdescription },
        url: { type: GraphQLString, resolve: (s) => s.siteurl },
        home: { type: GraphQLString },
        timezone: { type: GraphQLString, resolve: (s) => s.timezone_string },
        dateFormat: { type: GraphQLString, resolve: (s) => s.date_format },
        timeFormat: { type: GraphQLString, resolve: (s) => s.time_format },
        startOfWeek: { type: GraphQLJSON, resolve: (s) => s.start_of_week },
        postsPerPage: { type: GraphQLJSON, resolve: (s) => s.posts_per_page },
        siteLogo: { type: GraphQLJSON, resolve: (s) => s.site_logo },
        siteIcon: { type: GraphQLJSON, resolve: (s) => s.site_icon },
        homepageId: { type: GraphQLJSON, resolve: (s) => s.homepage_id },
        commentsEnabled: { type: GraphQLJSON, resolve: (s) => s.comments_enabled },
        all: { type: GraphQLJSON, description: 'Every public setting, keyed as in GET /settings.', resolve: (s) => s },
    },
});

export const ViewerType = new GraphQLObjectType({
    name: 'Viewer',
    description: 'The authenticated caller (GET /users/me), reduced to non-sensitive fields.',
    fields: {
        id: { type: new GraphQLNonNull(GraphQLInt) },
        name: { type: GraphQLString, resolve: (u) => u.displayName },
        role: { type: GraphQLString },
        capabilities: { type: GraphQLJSON },
    },
});

// ─── Query root ─────────────────────────────────────────────────────────────────────────────────────

const contentListArgs: GraphQLFieldConfigArgumentMap = {
    ...pageArgs,
    search: { type: GraphQLString, description: 'Full-text search (the same search as GET /posts?search=).' },
    status: { type: GraphQLString, description: 'publish (default), draft, pending, private, future or any — authorized exactly as on REST.' },
    orderBy: { type: ContentOrderByType },
    order: { type: OrderType },
    categories: { type: stringList, description: 'Category ids or slugs (any of).' },
    tags: { type: stringList, description: 'Tag ids or slugs (any of).' },
    author: { type: stringList, description: 'Author ids or slugs (any of).' },
};

function contentList(type: string | null): GraphQLFieldConfig<any, GraphQLContext> {
    return {
        type: new GraphQLNonNull(connectionOf('Content', ContentNodeType)),
        args: type ? contentListArgs : { type: { type: GraphQLString, description: 'Post type name (default post).' }, ...contentListArgs },
        extensions: REST_LIST(),
        resolve: (_root, args, ctx) => fetchPage(ctx, '/posts', {
            type: type || args.type,
            search: args.search,
            status: args.status,
            orderby: args.orderBy,
            order: args.order,
            categories: csv(args.categories),
            tags: csv(args.tags),
            author: csv(args.author),
        }, args),
    };
}

function contentLookup(type: string | null): GraphQLFieldConfig<any, GraphQLContext> {
    return {
        type: ContentNodeType,
        description: 'By id or slug. Null when it does not exist or this caller may not read it.',
        args: {
            id: { type: GraphQLInt },
            slug: { type: GraphQLString },
            ...(type ? {} : { type: { type: GraphQLString, description: 'Narrow a slug lookup to one post type.' } }),
        },
        extensions: REST_ONE,
        resolve: async (_root, args, ctx) => {
            if ((args.id == null) === (args.slug == null)) {
                throw new GraphQLError('Pass exactly one of "id" or "slug".', { extensions: { code: 'BAD_USER_INPUT' } });
            }
            const wanted = type || args.type || undefined;
            if (args.id != null) {
                const node = okOrNull(await ctx.rest.get(`/posts/${args.id}`));
                // GET /posts/:id is type-agnostic; `page(id:)` must not answer with a post.
                return node && wanted && node.type !== wanted ? null : node;
            }
            return okOrNull(await ctx.rest.get(`/posts/slug/${encodeURIComponent(args.slug)}`, { type: wanted }));
        },
    };
}

const termListArgs: GraphQLFieldConfigArgumentMap = {
    ...pageArgs,
    search: { type: GraphQLString },
    parent: { type: GraphQLInt },
    hideEmpty: { type: GraphQLBoolean },
    orderBy: { type: TermOrderByType },
    order: { type: OrderType },
};

function termList(path: string): GraphQLFieldConfig<any, GraphQLContext> {
    return {
        type: new GraphQLNonNull(connectionOf('Term', TermType)),
        args: termListArgs,
        extensions: REST_LIST(),
        resolve: (_root, args, ctx) => fetchPage(ctx, path, {
            search: args.search,
            parent: args.parent,
            hide_empty: args.hideEmpty === undefined || args.hideEmpty === null ? undefined : String(args.hideEmpty),
            orderby: args.orderBy,
            order: args.order,
        }, args),
    };
}

function termLookup(path: string): GraphQLFieldConfig<any, GraphQLContext> {
    return {
        type: TermType,
        args: { id: { type: new GraphQLNonNull(GraphQLInt) } },
        extensions: REST_ONE,
        resolve: async (_root, args, ctx) => okOrNull(await ctx.rest.get(`${path}/${args.id}`)),
    };
}

export function buildQueryFields(): Record<string, GraphQLFieldConfig<any, GraphQLContext>> {
    return {
        contentNodes: { ...contentList(null), description: 'Entries of any REST-exposed post type (GET /posts?type=).' },
        posts: { ...contentList('post'), description: 'Posts (GET /posts).' },
        pages: { ...contentList('page'), description: 'Pages (GET /pages).' },
        contentNode: contentLookup(null),
        post: contentLookup('post'),
        page: contentLookup('page'),

        categories: termList('/categories'),
        category: termLookup('/categories'),
        tags: termList('/tags'),
        tag: termLookup('/tags'),
        taxonomies: {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TaxonomyType))),
            args: { postType: { type: GraphQLString } },
            extensions: REST_ONE,
            resolve: async (_r, args, ctx) => ok(await ctx.rest.get('/taxonomies', { postType: args.postType })),
        },
        taxonomy: {
            type: TaxonomyType,
            args: { name: { type: nonNullString } },
            extensions: REST_ONE,
            resolve: async (_r, args, ctx) => okOrNull(await ctx.rest.get(`/taxonomies/${encodeURIComponent(args.name)}`)),
        },
        contentTypes: {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ContentTypeType))),
            extensions: REST_ONE,
            resolve: async (_r, _a, ctx) => ok(await ctx.rest.get('/types')),
        },
        contentType: {
            type: ContentTypeType,
            args: { name: { type: nonNullString } },
            extensions: REST_ONE,
            resolve: async (_r, args, ctx) => okOrNull(await ctx.rest.get(`/types/${encodeURIComponent(args.name)}`)),
        },

        mediaItems: {
            type: new GraphQLNonNull(connectionOf('Media', MediaItemType)),
            args: { ...pageArgs, search: { type: GraphQLString }, mimeType: { type: GraphQLString }, orderBy: { type: MediaOrderByType }, order: { type: OrderType } },
            extensions: REST_LIST(),
            resolve: (_r, args, ctx) => fetchPage(ctx, '/media', {
                search: args.search, mime_type: args.mimeType, orderby: args.orderBy, order: args.order,
            }, args),
        },
        mediaItem: {
            type: MediaItemType,
            args: { id: { type: new GraphQLNonNull(GraphQLInt) } },
            extensions: REST_ONE,
            resolve: async (_r, args, ctx) => okOrNull(await ctx.rest.get(`/media/${args.id}`)),
        },

        menus: {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(MenuType))),
            extensions: REST_ONE,
            resolve: async (_r, _a, ctx) => ok(await ctx.rest.get('/menus')),
        },
        menu: {
            type: MenuType,
            description: 'By id, or by theme location.',
            args: { id: { type: GraphQLInt }, location: { type: GraphQLString } },
            extensions: REST_ONE,
            resolve: async (_r, args, ctx) => {
                if ((args.id == null) === (args.location == null)) {
                    throw new GraphQLError('Pass exactly one of "id" or "location".', { extensions: { code: 'BAD_USER_INPUT' } });
                }
                return args.id != null
                    ? okOrNull(await ctx.rest.get(`/menus/${args.id}`))
                    : okOrNull(await ctx.rest.get(`/menus/location/${encodeURIComponent(args.location)}`));
            },
        },

        comments: {
            type: new GraphQLNonNull(connectionOf('Comment', CommentType)),
            description: 'Comments (GET /comments): the approved ones, or another status for a moderator.',
            args: {
                ...pageArgs,
                postId: { type: GraphQLInt },
                parentId: { type: GraphQLInt },
                search: { type: GraphQLString },
                status: { type: GraphQLString, description: 'hold, approved (default), spam or trash — honoured for a moderator only, as on REST.' },
                orderBy: { type: CommentOrderByType },
                order: { type: OrderType },
            },
            extensions: REST_LIST(),
            resolve: (_r, args, ctx) => fetchPage(ctx, '/comments', {
                post: args.postId, parent: args.parentId, search: args.search, status: args.status, orderby: args.orderBy, order: args.order,
            }, args),
        },
        comment: {
            type: CommentType,
            args: { id: { type: new GraphQLNonNull(GraphQLInt) } },
            extensions: REST_ONE,
            resolve: async (_r, args, ctx) => okOrNull(await ctx.rest.get(`/comments/${args.id}`)),
        },

        settings: {
            type: new GraphQLNonNull(SettingsType),
            extensions: REST_ONE,
            resolve: async (_r, _a, ctx) => ok(await ctx.rest.get('/settings')),
        },
        viewer: {
            type: ViewerType,
            description: 'The authenticated caller, or null for an anonymous request.',
            extensions: REST_ONE,
            resolve: async (_r, _a, ctx) => {
                const r = await ctx.rest.get('/users/me');
                return r.status === 401 || r.status === 403 ? null : ok(r);
            },
        },
    };
}

/** The core schema (queries, mutations, subscriptions), before any extension is applied. */
export function buildCoreSchema(): GraphQLSchema {
    // Required here, not at load: both modules import this one's types.
    const { buildMutationFields } = require('./mutations');
    const { buildResourceQueryFields } = require('./resources');
    const { buildSubscriptionFields } = require('./subscriptions');
    return new GraphQLSchema({
        query: new GraphQLObjectType({ name: 'Query', fields: () => ({ ...buildQueryFields(), ...buildResourceQueryFields() }) }),
        mutation: new GraphQLObjectType({ name: 'Mutation', fields: buildMutationFields }),
        subscription: new GraphQLObjectType({ name: 'Subscription', fields: buildSubscriptionFields }),
    });
}
