/**
 * WordJS - GraphQL mutations: every one IS the REST write it is named after.
 *
 * THE SAME RULE AS THE READS (core/graphql/dispatch). A mutation never touches a model: `createContent` is
 * `POST /posts`, `publishContent` is `PUT /posts/:id {status: publish}`, `uploadMedia` is a multipart
 * `POST /media`. The REST route runs for the same caller with its own middleware, so the capability family
 * of the type, the publish gate (a contributor cannot publish), ownership (an author cannot edit someone
 * else's entry), the sudo re-authentication of a profile change, protected meta, sanitizing, revisions,
 * the audit rows, hooks, webhooks and an API token's write scope are exactly the REST ones — there is no
 * second write path to keep in sync.
 *
 * Conventions:
 *  · A refusal is a GraphQL error carrying the REST `code` and HTTP `status` in `extensions` (plus REST's
 *    `params`/`details` when it names them), and `data.<field>` is null. Nothing is partially applied by
 *    GraphQL itself: what REST wrote before answering is what was written.
 *  · Mutation root fields run one after another (GraphQL's own rule); a later one sees what an earlier one
 *    wrote, because every write empties the request's read memo.
 *  · Only a POST may mutate (routes/graphql answers 405 to a mutation over GET; `assertWriteTransport`
 *    below is the same rule at the resolver, for any transport that might ever reach this schema).
 *  · Every mutation costs MUTATION_COST in the cost rule and counts against `maxMutations` per document
 *    (core/graphql/limits).
 */

import {
    GraphQLBoolean,
    GraphQLEnumType,
    GraphQLError,
    GraphQLInputObjectType,
    GraphQLInt,
    GraphQLList,
    GraphQLNonNull,
    GraphQLObjectType,
    GraphQLScalarType,
    GraphQLString,
} from 'graphql';
import type { GraphQLFieldConfig, GraphQLFieldConfigArgumentMap } from 'graphql';
import type { RestResult, WriteMethod, WriteOptions } from './dispatch';
import {
    CommentType,
    ContentNodeType,
    GraphQLJSON,
    MediaItemType,
    MenuItemType,
    MenuType,
    TermType,
    ViewerType,
} from './schema';
import type { GraphQLContext } from './schema';

// ─── Upload (GraphQL multipart request spec) ────────────────────────────────────────────────────────

/** A file routes/graphql read from a multipart GraphQL request. Only that route constructs one. */
export class GraphQLUploadFile {
    constructor(
        readonly filename: string,
        readonly mimetype: string,
        readonly data: Buffer,
    ) {}
}

export const GraphQLUpload = new GraphQLScalarType({
    name: 'Upload',
    description: 'A file sent with the GraphQL multipart request spec (operations + map + file parts). Not representable inline.',
    serialize: () => { throw new GraphQLError('Upload is an input-only scalar.'); },
    parseValue: (v) => {
        if (v instanceof GraphQLUploadFile) return v;
        throw new GraphQLError('Upload values must be sent as a multipart file part (see the GraphQL multipart request spec).', { extensions: { code: 'BAD_USER_INPUT' } });
    },
    parseLiteral: () => {
        throw new GraphQLError('An Upload cannot be written inline; send it as a variable mapped to a multipart file part.', { extensions: { code: 'BAD_USER_INPUT' } });
    },
});

// ─── Plumbing ───────────────────────────────────────────────────────────────────────────────────────

/** The cost marker the limit rule reads: one REST write, counted against the per-document mutation cap. */
const WRITE = { cost: { rest: true, mutation: true } };

/** Mutations exist only on POST. GET is a safe method and carries no CSRF proof. */
export function assertWriteTransport(ctx: GraphQLContext): void {
    if (String(ctx.req && ctx.req.method).toUpperCase() !== 'POST') {
        throw new GraphQLError('Mutations are only accepted over POST.', { extensions: { code: 'GRAPHQL_MUTATION_METHOD', status: 405 } });
    }
}

/** A REST refusal as a GraphQL error: the REST code/status, and whatever REST named in `data`. */
export function writeError(result: RestResult): GraphQLError {
    const body = result.body && typeof result.body === 'object' ? result.body : {};
    const message = typeof body.message === 'string' ? body.message
        : typeof body.error === 'string' ? body.error
            : (body.error && typeof body.error.message === 'string') ? body.error.message
                : `Request failed with status ${result.status}.`;
    const extensions: Record<string, any> = {
        code: typeof body.code === 'string' ? body.code : (result.status === 429 ? 'rest_rate_limited' : 'REST_ERROR'),
        status: result.status,
    };
    const data = body.data && typeof body.data === 'object' ? body.data : null;
    if (data) {
        for (const [k, v] of Object.entries(data)) if (k !== 'status') extensions[k] = v;
    }
    return new GraphQLError(message, { extensions });
}

async function write(ctx: GraphQLContext, method: WriteMethod, path: string, opts: Omit<WriteOptions, 'res'> = {}): Promise<any> {
    assertWriteTransport(ctx);
    const r = await ctx.rest.write(method, path, opts);
    if (r.status >= 200 && r.status < 300) return r.body;
    throw writeError(r);
}

/** Copy the defined keys of a GraphQL input into a REST body under REST's own names. */
function restBody(input: any, names: Record<string, string>): Record<string, any> {
    const out: Record<string, any> = {};
    if (!input) return out;
    for (const [gql, rest] of Object.entries(names)) {
        if (input[gql] !== undefined) out[rest] = input[gql];
    }
    return out;
}

const id = { type: new GraphQLNonNull(GraphQLInt) };
const intList = new GraphQLList(new GraphQLNonNull(GraphQLInt));

// ─── Payloads ───────────────────────────────────────────────────────────────────────────────────────

const ContentPayloadType = new GraphQLObjectType({
    name: 'ContentPayload',
    fields: { node: { type: ContentNodeType, description: 'The entry as REST answered the write (its read for this caller).' } },
});

const DeletePayloadType = new GraphQLObjectType({
    name: 'DeletePayload',
    description: 'A permanent delete: REST\'s `{ deleted, previous }`.',
    fields: {
        id: { type: new GraphQLNonNull(GraphQLInt) },
        deleted: { type: new GraphQLNonNull(GraphQLBoolean) },
        previous: { type: GraphQLJSON, description: 'The representation REST returned for what was deleted.' },
    },
});

const TermPayloadType = new GraphQLObjectType({ name: 'TermPayload', fields: { term: { type: TermType } } });
const MediaPayloadType = new GraphQLObjectType({ name: 'MediaPayload', fields: { mediaItem: { type: MediaItemType } } });
const CommentPayloadType = new GraphQLObjectType({ name: 'CommentPayload', fields: { comment: { type: CommentType } } });
const MenuPayloadType = new GraphQLObjectType({ name: 'MenuPayload', fields: { menu: { type: MenuType } } });
const MenuItemPayloadType = new GraphQLObjectType({ name: 'MenuItemPayload', fields: { menuItem: { type: MenuItemType } } });
const SettingsPayloadType = new GraphQLObjectType({
    name: 'SettingsPayload',
    fields: { settings: { type: GraphQLJSON, description: 'The settings REST wrote, keyed as in PUT /settings, with their stored (normalized) values.' } },
});
const ViewerPayloadType = new GraphQLObjectType({ name: 'ViewerPayload', fields: { viewer: { type: ViewerType } } });

// ─── Inputs ─────────────────────────────────────────────────────────────────────────────────────────

const ContentStatusType = new GraphQLEnumType({
    name: 'ContentStatus',
    values: {
        DRAFT: { value: 'draft' }, PENDING: { value: 'pending' }, PUBLISH: { value: 'publish' },
        FUTURE: { value: 'future' }, PRIVATE: { value: 'private' },
    },
});

const ContentInputType = new GraphQLInputObjectType({
    name: 'ContentInput',
    description: 'The body of POST /posts and PUT /posts/:id, field for field (camelCase here, REST names on the wire).',
    fields: {
        type: { type: GraphQLString, description: 'Post type (create only; default post).' },
        title: { type: GraphQLString },
        content: { type: GraphQLString },
        excerpt: { type: GraphQLString },
        status: { type: ContentStatusType, description: 'Authorized as on REST: publishing needs the type\'s publish capability.' },
        slug: { type: GraphQLString },
        date: { type: GraphQLString, description: 'Publication date (a future date with status FUTURE schedules it).' },
        parentId: { type: GraphQLInt },
        menuOrder: { type: GraphQLInt },
        commentStatus: { type: GraphQLString, description: 'open or closed.' },
        categories: { type: intList },
        tags: { type: intList },
        meta: { type: GraphQLJSON, description: 'Meta map; protected keys are refused exactly as on REST.' },
        language: { type: GraphQLString },
    },
});

const CONTENT_FIELDS = {
    type: 'type', title: 'title', content: 'content', excerpt: 'excerpt', status: 'status', slug: 'slug', date: 'date',
    parentId: 'parent', menuOrder: 'menu_order', commentStatus: 'comment_status', categories: 'categories', tags: 'tags',
    meta: 'meta', language: 'language',
};

const TermTaxonomyType = new GraphQLEnumType({
    name: 'TermTaxonomy',
    values: { CATEGORY: { value: '/categories' }, TAG: { value: '/tags' } },
});

const TermInputType = new GraphQLInputObjectType({
    name: 'TermInput',
    fields: {
        name: { type: GraphQLString },
        slug: { type: GraphQLString },
        description: { type: GraphQLString },
        parentId: { type: GraphQLInt, description: 'Categories only.' },
    },
});

const MediaVisibilityType = new GraphQLEnumType({
    name: 'MediaVisibility',
    values: { PUBLIC: { value: 'public' }, PRIVATE: { value: 'private' } },
});

const MediaInputType = new GraphQLInputObjectType({
    name: 'MediaInput',
    fields: {
        title: { type: GraphQLString },
        description: { type: GraphQLString },
        caption: { type: GraphQLString },
        alt: { type: GraphQLString },
        visibility: { type: MediaVisibilityType },
    },
});

const CommentCreateInputType = new GraphQLInputObjectType({
    name: 'CommentCreateInput',
    fields: {
        postId: { type: new GraphQLNonNull(GraphQLInt) },
        content: { type: new GraphQLNonNull(GraphQLString) },
        parentId: { type: GraphQLInt },
        authorName: { type: GraphQLString, description: 'Anonymous commenters only (a signed-in caller comments as themself).' },
        authorEmail: { type: GraphQLString },
        authorUrl: { type: GraphQLString },
    },
});

const CommentUpdateInputType = new GraphQLInputObjectType({
    name: 'CommentUpdateInput',
    fields: {
        content: { type: GraphQLString },
        status: { type: GraphQLString, description: 'approved, hold, spam or trash — as PUT /comments/:id accepts.' },
        authorName: { type: GraphQLString },
        authorEmail: { type: GraphQLString },
        authorUrl: { type: GraphQLString },
    },
});

const CommentModerationType = new GraphQLEnumType({
    name: 'CommentModeration',
    values: { APPROVE: { value: 'approve' }, SPAM: { value: 'spam' } },
});

const MenuInputType = new GraphQLInputObjectType({
    name: 'MenuInput',
    fields: { name: { type: GraphQLString }, slug: { type: GraphQLString }, description: { type: GraphQLString } },
});

const MenuItemInputType = new GraphQLInputObjectType({
    name: 'MenuItemInput',
    fields: {
        title: { type: GraphQLString },
        url: { type: GraphQLString },
        target: { type: GraphQLString },
        type: { type: GraphQLString },
        objectId: { type: GraphQLInt },
        parentId: { type: GraphQLInt },
        order: { type: GraphQLInt },
        classes: { type: GraphQLString },
    },
});
const MENU_ITEM_FIELDS = {
    title: 'title', url: 'url', target: 'target', type: 'type', objectId: 'objectId', parentId: 'parent', order: 'order', classes: 'classes',
};

const ProfileInputType = new GraphQLInputObjectType({
    name: 'ProfileInput',
    description: 'The body of PUT /users/me. A new password or recovery address needs currentPassword, as on REST.',
    fields: {
        displayName: { type: GraphQLString },
        email: { type: GraphQLString },
        url: { type: GraphQLString },
        personalEmail: { type: GraphQLString },
        password: { type: GraphQLString },
        currentPassword: { type: GraphQLString },
    },
});

// ─── Fields ─────────────────────────────────────────────────────────────────────────────────────────

type Field = GraphQLFieldConfig<any, GraphQLContext>;

function contentCreate(type: string | null, description: string): Field {
    return {
        type: ContentPayloadType,
        description,
        args: { input: { type: new GraphQLNonNull(ContentInputType) } },
        extensions: WRITE,
        resolve: async (_r, args, ctx) => {
            const body = restBody(args.input, CONTENT_FIELDS);
            if (type) body.type = type;
            return { node: await write(ctx, 'POST', '/posts', { body }) };
        },
    };
}

/** PUT /posts/:id with a fixed body (publish / schedule / restore are named transitions of the same write). */
function contentTransition(description: string, args: GraphQLFieldConfigArgumentMap, body: (a: any) => any): Field {
    return {
        type: ContentPayloadType,
        description,
        args: { id, ...args },
        extensions: WRITE,
        resolve: async (_r, a, ctx) => ({ node: await write(ctx, 'PUT', `/posts/${a.id}`, { body: body(a) }) }),
    };
}

function deletePayload(idValue: number, body: any) {
    return { id: idValue, deleted: !!(body && body.deleted), previous: body && body.previous !== undefined ? body.previous : null };
}

export function buildMutationFields(): Record<string, Field> {
    return {
        // ── Content (posts, pages, any REST-exposed type) ──
        createContent: contentCreate(null, 'POST /posts — any REST-exposed type (input.type, default post).'),
        createPost: contentCreate('post', 'POST /posts with type post.'),
        createPage: contentCreate('page', 'POST /posts with type page.'),
        updateContent: {
            type: ContentPayloadType,
            description: 'PUT /posts/:id.',
            args: { id, input: { type: new GraphQLNonNull(ContentInputType) } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => {
                const body = restBody(a.input, CONTENT_FIELDS);
                delete body.type; // REST ignores a type change on update; do not imply one.
                return { node: await write(ctx, 'PUT', `/posts/${a.id}`, { body }) };
            },
        },
        publishContent: contentTransition('PUT /posts/:id {status: publish}.', {}, () => ({ status: 'publish' })),
        scheduleContent: contentTransition('PUT /posts/:id {status: future, date}.',
            { date: { type: new GraphQLNonNull(GraphQLString), description: 'The future publication date (ISO 8601).' } },
            (a) => ({ status: 'future', date: a.date })),
        unpublishContent: contentTransition('PUT /posts/:id {status: draft}.', {}, () => ({ status: 'draft' })),
        trashContent: {
            type: ContentPayloadType,
            description: 'DELETE /posts/:id (to the trash).',
            args: { id },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => ({ node: await write(ctx, 'DELETE', `/posts/${a.id}`) }),
        },
        // Out of the trash ONLY through POST /posts/:id/restore, as on REST: it returns the entry to the
        // status it had before the trash under the restore and publish gates. A trashed entry refuses every
        // in-place write (PUT answers 409), so a status given here is applied AFTER the restore, by a PUT
        // that takes the ordinary edit and publish gates.
        restoreContent: {
            type: ContentPayloadType,
            description: 'POST /posts/:id/restore (back to the status it had before the trash), then PUT /posts/:id {status} when a status is given.',
            args: { id, status: { type: ContentStatusType } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => {
                const restored = await write(ctx, 'POST', `/posts/${a.id}/restore`);
                if (!a.status || (restored && restored.status === a.status)) return { node: restored };
                return { node: await write(ctx, 'PUT', `/posts/${a.id}`, { body: { status: a.status } }) };
            },
        },
        deleteContent: {
            type: DeletePayloadType,
            description: 'DELETE /posts/:id?force=true — permanent.',
            args: { id },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => deletePayload(a.id, await write(ctx, 'DELETE', `/posts/${a.id}`, { query: { force: 'true' } })),
        },
        setContentMeta: {
            type: GraphQLJSON,
            description: 'POST /posts/:id/meta {key, value}. Returns REST\'s answer.',
            args: { id, key: { type: new GraphQLNonNull(GraphQLString) }, value: { type: GraphQLJSON } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => write(ctx, 'POST', `/posts/${a.id}/meta`, { body: { key: a.key, value: a.value } }),
        },

        restoreRevision: {
            type: ContentPayloadType,
            description: 'POST /revisions/:id/restore — the entry\'s own edit (and publish) gate applies. Returns the restored entry.',
            args: { id, postId: { type: new GraphQLNonNull(GraphQLInt), description: 'The entry the revision belongs to (read back after the restore).' } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => {
                await write(ctx, 'POST', `/revisions/${a.id}/restore`, { body: {} });
                const r = await ctx.rest.get(`/posts/${a.postId}`);
                return { node: r.status >= 200 && r.status < 300 ? r.body : null };
            },
        },
        deleteRevision: {
            type: DeletePayloadType,
            description: 'DELETE /revisions/:id.',
            args: { id },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => {
                const body = await write(ctx, 'DELETE', `/revisions/${a.id}`);
                return { id: a.id, deleted: !!(body && body.success), previous: null };
            },
        },

        // ── Terms ──
        createTerm: {
            type: TermPayloadType,
            description: 'POST /categories or /tags.',
            args: { taxonomy: { type: new GraphQLNonNull(TermTaxonomyType) }, input: { type: new GraphQLNonNull(TermInputType) } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => ({ term: await write(ctx, 'POST', a.taxonomy, { body: restBody(a.input, { name: 'name', slug: 'slug', description: 'description', parentId: 'parent' }) }) }),
        },
        updateTerm: {
            type: TermPayloadType,
            description: 'PUT /categories/:id or /tags/:id.',
            args: { taxonomy: { type: new GraphQLNonNull(TermTaxonomyType) }, id, input: { type: new GraphQLNonNull(TermInputType) } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => ({ term: await write(ctx, 'PUT', `${a.taxonomy}/${a.id}`, { body: restBody(a.input, { name: 'name', slug: 'slug', description: 'description', parentId: 'parent' }) }) }),
        },
        deleteTerm: {
            type: DeletePayloadType,
            description: 'DELETE /categories/:id or /tags/:id.',
            args: { taxonomy: { type: new GraphQLNonNull(TermTaxonomyType) }, id },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => deletePayload(a.id, await write(ctx, 'DELETE', `${a.taxonomy}/${a.id}`)),
        },

        // ── Media ──
        uploadMedia: {
            type: MediaPayloadType,
            description: 'POST /media (multipart). Send the file with the GraphQL multipart request spec.',
            args: { file: { type: new GraphQLNonNull(GraphQLUpload) }, input: { type: MediaInputType } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => {
                const file: GraphQLUploadFile = a.file;
                const input = a.input || {};
                const fields = restBody(input, { title: 'title', description: 'description', caption: 'caption', alt: 'alt' });
                const body = await write(ctx, 'POST', '/media', {
                    // A private upload is chosen in the QUERY STRING, as on REST: multer picks the private root
                    // from it before the bytes reach disk.
                    query: { visibility: input.visibility },
                    multipart: { fields, file: { field: 'file', filename: file.filename, contentType: file.mimetype, data: file.data } },
                });
                return { mediaItem: body };
            },
        },
        updateMedia: {
            type: MediaPayloadType,
            description: 'PUT /media/:id.',
            args: { id, input: { type: new GraphQLNonNull(MediaInputType) } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => ({ mediaItem: await write(ctx, 'PUT', `/media/${a.id}`, { body: restBody(a.input, { title: 'title', description: 'description', caption: 'caption', alt: 'alt', visibility: 'visibility' }) }) }),
        },
        deleteMedia: {
            type: DeletePayloadType,
            description: 'DELETE /media/:id (the file and its sizes).',
            args: { id },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => deletePayload(a.id, await write(ctx, 'DELETE', `/media/${a.id}`)),
        },

        // ── Comments ──
        createComment: {
            type: CommentPayloadType,
            description: 'POST /comments — the same moderation, throttle and spam checks as the REST form.',
            args: { input: { type: new GraphQLNonNull(CommentCreateInputType) } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => ({ comment: await write(ctx, 'POST', '/comments', { body: restBody(a.input, { postId: 'post', content: 'content', parentId: 'parent', authorName: 'author_name', authorEmail: 'author_email', authorUrl: 'author_url' }) }) }),
        },
        updateComment: {
            type: CommentPayloadType,
            description: 'PUT /comments/:id (edit_comments).',
            args: { id, input: { type: new GraphQLNonNull(CommentUpdateInputType) } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => ({ comment: await write(ctx, 'PUT', `/comments/${a.id}`, { body: restBody(a.input, { content: 'content', status: 'status', authorName: 'author', authorEmail: 'author_email', authorUrl: 'author_url' }) }) }),
        },
        moderateComment: {
            type: CommentPayloadType,
            description: 'POST /comments/:id/approve or /spam (moderate_comments).',
            args: { id, action: { type: new GraphQLNonNull(CommentModerationType) } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => ({ comment: await write(ctx, 'POST', `/comments/${a.id}/${a.action}`, { body: {} }) }),
        },
        deleteComment: {
            type: DeletePayloadType,
            description: 'DELETE /comments/:id (trash; force: true deletes permanently).',
            args: { id, force: { type: GraphQLBoolean } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => {
                const body = await write(ctx, 'DELETE', `/comments/${a.id}`, { query: { force: a.force ? 'true' : undefined } });
                // Without force REST trashes the comment and answers with it: nothing was deleted yet.
                return a.force ? deletePayload(a.id, body) : { id: a.id, deleted: false, previous: body };
            },
        },

        // ── Menus ──
        createMenu: {
            type: MenuPayloadType,
            description: 'POST /menus (administrators).',
            args: { input: { type: new GraphQLNonNull(MenuInputType) } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => ({ menu: await write(ctx, 'POST', '/menus', { body: restBody(a.input, { name: 'name', slug: 'slug', description: 'description' }) }) }),
        },
        updateMenu: {
            type: MenuPayloadType,
            description: 'PUT /menus/:id.',
            args: { id, input: { type: new GraphQLNonNull(MenuInputType) } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => ({ menu: await write(ctx, 'PUT', `/menus/${a.id}`, { body: restBody(a.input, { name: 'name', slug: 'slug', description: 'description' }) }) }),
        },
        deleteMenu: {
            type: DeletePayloadType,
            description: 'DELETE /menus/:id.',
            args: { id },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => deletePayload(a.id, await write(ctx, 'DELETE', `/menus/${a.id}`)),
        },
        assignMenuLocation: {
            type: GraphQLJSON,
            description: 'POST /menus/:id/location {location}. Returns REST\'s answer.',
            args: { id, location: { type: new GraphQLNonNull(GraphQLString) } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => write(ctx, 'POST', `/menus/${a.id}/location`, { body: { location: a.location } }),
        },
        addMenuItem: {
            type: MenuItemPayloadType,
            description: 'POST /menus/:id/items.',
            args: { menuId: id, input: { type: new GraphQLNonNull(MenuItemInputType) } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => ({ menuItem: await write(ctx, 'POST', `/menus/${a.menuId}/items`, { body: restBody(a.input, MENU_ITEM_FIELDS) }) }),
        },
        updateMenuItem: {
            type: MenuItemPayloadType,
            description: 'PUT /menus/items/:itemId.',
            args: { id, input: { type: new GraphQLNonNull(MenuItemInputType) } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => ({ menuItem: await write(ctx, 'PUT', `/menus/items/${a.id}`, { body: restBody(a.input, MENU_ITEM_FIELDS) }) }),
        },
        deleteMenuItem: {
            type: DeletePayloadType,
            description: 'DELETE /menus/items/:itemId.',
            args: { id },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => deletePayload(a.id, await write(ctx, 'DELETE', `/menus/items/${a.id}`)),
        },

        // ── Settings (what PUT /settings allows: administrators, the REST allow-list, the REST validators) ──
        updateSettings: {
            type: SettingsPayloadType,
            description: 'PUT /settings with a { key: value } map. Keys REST does not write are ignored exactly as there.',
            args: { values: { type: new GraphQLNonNull(GraphQLJSON) } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => {
                if (!a.values || typeof a.values !== 'object' || Array.isArray(a.values)) {
                    throw new GraphQLError('"values" must be an object of setting keys.', { extensions: { code: 'BAD_USER_INPUT' } });
                }
                return { settings: await write(ctx, 'PUT', '/settings', { body: a.values }) };
            },
        },
        updateSetting: {
            type: SettingsPayloadType,
            description: 'PUT /settings/:key {value}.',
            args: { key: { type: new GraphQLNonNull(GraphQLString) }, value: { type: GraphQLJSON } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => {
                const body = await write(ctx, 'PUT', `/settings/${encodeURIComponent(a.key)}`, { body: { value: a.value } });
                return { settings: body && typeof body === 'object' && 'key' in body ? { [body.key]: body.value } : body };
            },
        },

        // ── The caller's own profile ──
        updateViewer: {
            type: ViewerPayloadType,
            description: 'PUT /users/me. Changing the password or a recovery address re-authenticates with currentPassword.',
            args: { input: { type: new GraphQLNonNull(ProfileInputType) } },
            extensions: WRITE,
            resolve: async (_r, a, ctx) => ({ viewer: await write(ctx, 'PUT', '/users/me', { body: restBody(a.input, { displayName: 'displayName', email: 'email', url: 'url', personalEmail: 'personalEmail', password: 'password', currentPassword: 'currentPassword' }) }) }),
        },
    };
}

/**
 * Every mutation field and the REST write it performs — the documented contract, asserted by the tests
 * (each row must exist in the schema, and the REST twin must be a real route).
 */
export const MUTATION_REST_TWINS: Readonly<Record<string, string>> = Object.freeze({
    createContent: 'POST /posts',
    createPost: 'POST /posts',
    createPage: 'POST /posts',
    updateContent: 'PUT /posts/:id',
    publishContent: 'PUT /posts/:id',
    scheduleContent: 'PUT /posts/:id',
    unpublishContent: 'PUT /posts/:id',
    trashContent: 'DELETE /posts/:id',
    restoreContent: 'POST /posts/:id/restore',
    deleteContent: 'DELETE /posts/:id',
    setContentMeta: 'POST /posts/:id/meta',
    restoreRevision: 'POST /revisions/:id/restore',
    deleteRevision: 'DELETE /revisions/:id',
    createTerm: 'POST /categories|/tags',
    updateTerm: 'PUT /categories/:id|/tags/:id',
    deleteTerm: 'DELETE /categories/:id|/tags/:id',
    uploadMedia: 'POST /media',
    updateMedia: 'PUT /media/:id',
    deleteMedia: 'DELETE /media/:id',
    createComment: 'POST /comments',
    updateComment: 'PUT /comments/:id',
    moderateComment: 'POST /comments/:id/approve|spam',
    deleteComment: 'DELETE /comments/:id',
    createMenu: 'POST /menus',
    updateMenu: 'PUT /menus/:id',
    deleteMenu: 'DELETE /menus/:id',
    assignMenuLocation: 'POST /menus/:id/location',
    addMenuItem: 'POST /menus/:id/items',
    updateMenuItem: 'PUT /menus/items/:itemId',
    deleteMenuItem: 'DELETE /menus/items/:itemId',
    updateSettings: 'PUT /settings',
    updateSetting: 'PUT /settings/:key',
    updateViewer: 'PUT /users/me',
});
