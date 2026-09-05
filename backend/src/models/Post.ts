/**
 * WordJS - Post Model
 * Equivalent to wp-includes/class-wp-post.php and wp-includes/post.php
 */

const database = require('../config/database');
const { db, dbAsync, getDbType } = database;
const { doShortcode, doShortcodeAsync, stripShortcodes } = require('../core/shortcodes');
const { sanitizeTitle, sanitizeContent, generateExcerpt, currentTimeGMT, currentTime, formatDate, boundSlug } = require('../core/formatting');
const config = require('../config/app');
const cache = require('../core/cache');
const { saveRevision } = require('../core/revisions');
const { randomUUID } = require('crypto');
// parseLanguageTag validates + canonicalizes a BCP-47 tag, returning null for anything that is not a
// language tag (a post's language must never silently become 'en' — null means "no language set").
const { parseLanguageTag } = require('../core/language-tag');
const {
    runContentMutation,
    recordContentEvent,
    isContentMutationActive,
} = require('../core/content-outbox');

/**
 * Marks a post whose stored post_date is a leftover from a schedule that was CANCELLED — i.e. a
 * future date nobody is asking for any more. Written by Post.update when a 'future' post leaves that
 * status with no new date; cleared by the next explicit date or by the publish that consumes it.
 *
 * It exists because the alternative is guessing: at the moment "Publish" arrives with no date, a
 * leftover December date and a December date the author deliberately typed on a draft look exactly
 * the same, and the two need opposite treatment (publish now vs schedule). Protected (`_` prefix),
 * one row, only on a transition that already writes several.
 */
const UNSCHEDULED_DATE_META = '_wjs_unscheduled_date';

/**
 * THE SINK'S OWN TYPE CHECK — the last member of the "guard and sink disagree" class.
 *
 * Every route in front of this model normalizes its string fields at the boundary, and that is where
 * a caller gets a 400. This function is the statement that the COLUMN's contract does not depend on a
 * caller having done so: an Array reaching a bound parameter is flattened back into a string by
 * better-sqlite3 and by mysql2, so a non-string here means the value that was authorized and the value
 * that is stored are two different things. That is a programming error at the call site, not a request
 * to be repaired quietly, so it THROWS — loudly, in development, in the caller's own stack — instead
 * of coercing and writing something nobody checked.
 *
 * null/undefined/'' are ABSENT and take the documented default; that is a real, ordinary shape (the
 * editor sends `parent: ''` for "no parent") and has never been the bug.
 */
/**
 * Put one row into a meta map WITHOUT letting the row's key choose what the map inherits.
 *
 * THE CLASS: every object this codebase builds by ASSIGNING a key that came from data. `meta[k] = v`
 * with `k === '__proto__'` defines NO property — it swaps the object's PROTOTYPE — so a single row
 * makes every key that has no row of its own resolve to attacker-chosen data through the prototype
 * chain (models/Media.ts reads `allMeta['_wp_attached_file']` precisely that way), while
 * `Object.keys()` and `JSON.stringify()` show a clean map: invisible to any check made through the
 * API response. `constructor` and `prototype` are the same defect one name over.
 *
 * The WRITE side refuses those names now (core/protected-meta.metaKeyProblem), but a row can predate
 * that rule or arrive through an import, so the READER must be safe on its own: defineProperty always
 * creates an OWN, enumerable, plain data property, whatever the name is. The map keeps Object.prototype
 * so every existing consumer (spread, JSON.stringify, `.hasOwnProperty`) behaves exactly as before —
 * which Object.create(null) would have quietly changed.
 */
function defineMetaEntry(target: Record<string, any>, key: string, value: any): void {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function scalarString(value: unknown, field: string, fallback: string): string {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value !== 'string') {
        throw new TypeError(`Post.${field} must be a string, got ${Array.isArray(value) ? 'array' : typeof value}`);
    }
    return value;
}

/**
 * The author a serialised post carries — the SAME three fields the public surfaces need and no more.
 *
 * `toJSON()` used to emit `author: this.authorId`, a bare number, while the generated content contract
 * (frontend/src/lib/generated/content-client.generated.ts, ContentRecord) has always typed it as an
 * object: every consumer written against the contract — the OpenGraph `authors`, the JSON-LD `author`
 * and the blog roll's byline — read `post.author?.displayName` off a number and got `undefined`
 * forever. The CODE is what moves to the CONTRACT here.
 *
 * `slug` is the public author identity — `user_nicename`, and NEVER `user_login`. It is an OUTPUT, so
 * it may only carry a value that was chosen to be public: the login is what the login form takes, and
 * a byline that spells it turns every public page into a username enumerator. Where the column is
 * still empty the slug is the user ID, which `?author=` and `/author/<id>` already resolve — so a
 * public page can always link to `/author/<slug>` and narrow `GET /posts?author=<slug>` with the very
 * value it was handed. (The INPUT side of that filter still matches a login as well; accepting an
 * identifier someone already knows is not the same act as publishing one.)
 *
 * NOTHING ELSE FROM THE ROW. `users` also holds the e-mail and the password hash; an author byline is
 * not an account listing, and `/users` is authenticated precisely so a public post cannot become one.
 */
interface PostAuthorRef {
    id: number;
    displayName: string;
    slug: string;
}

/**
 * A `categories` / `tags` / `author` filter, normalised into the two identities the list accepts.
 *
 * WordPress addresses a term or an author by numeric id; a public page only ever has the SLUG (that is
 * what its URL carries). Both are therefore accepted in the same comma-separated list and split by
 * SHAPE — all-digits is an id, anything else is a slug — which is the same rule the author feed uses
 * for its path segment, so the two surfaces cannot disagree about what `/author/2` means.
 */
interface PostIdentityFilter {
    ids: number[];
    slugs: string[];
}

class Post {
    id?: number;
    authorId?: number;
    postDate?: string;
    postDateGmt?: string;
    postContent?: string;
    postTitle?: string;
    postExcerpt?: string;
    postStatus?: string;
    commentStatus?: string;
    pingStatus?: string;
    postPassword?: string;
    postName?: string;
    postModified?: string;
    postModifiedGmt?: string;
    postParent?: number;
    guid?: string;
    menuOrder?: number;
    postType?: string;
    postMimeType?: string;
    commentCount?: number;
    // MULTILINGUAL (opt-in). NULL on a monolingual site — see migration 0011.
    postLanguage?: string | null;
    translationGroup?: string | null;
    // Optional pre-loaded meta (set by hydrateRelations to avoid N+1 in toJSON).
    // When undefined, toJSON falls back to a per-post DB query (identical behavior).
    _metaCache?: { [key: string]: any };
    // Optional pre-loaded featured image (set by hydrateRelations to avoid the
    // per-post findById + _wp_attached_file lookups in getFeaturedImage()/toJSON()).
    // When undefined, those methods fall back to per-post queries (identical behavior).
    // Shape: { post: Post|null, attachedFile: string|null } — null `post` means
    // "resolved, no featured image".
    _featuredImageCache?: { post: any; attachedFile: any } | undefined;
    // Optional pre-loaded terms (set by hydrateRelations to avoid the per-post taxonomy query in
    // toJSON()). Same contract as _featuredImageCache: `undefined` means "not resolved yet" and
    // toJSON falls back to ONE per-post query; a post with no terms gets an empty-but-DEFINED bucket
    // per taxonomy so the fallback is skipped (the "resolved none" branch).
    // Shape: { category: [{id,name,slug}], post_tag: [...] } — only the taxonomies toJSON emits.
    _termsCache?: Record<string, Array<{ id: number; name: string; slug: string }>> | undefined;
    // Optional pre-loaded author identity (set by hydrateRelations, same contract as the two above:
    // `undefined` means "not resolved yet" and toJSON falls back to ONE per-post query). Serializing
    // the author as an object without this would turn every listing into an N+1 over `users`.
    _authorCache?: PostAuthorRef | undefined;

    constructor(data: any) {
        this.id = data.id;
        this.authorId = data.author_id;
        this.postDate = data.post_date;
        this.postDateGmt = data.post_date_gmt;
        this.postContent = data.post_content;
        this.postTitle = data.post_title;
        this.postExcerpt = data.post_excerpt;
        this.postStatus = data.post_status;
        this.commentStatus = data.comment_status;
        this.pingStatus = data.ping_status;
        this.postPassword = data.post_password;
        this.postName = data.post_name;
        this.postModified = data.post_modified;
        this.postModifiedGmt = data.post_modified_gmt;
        this.postParent = data.post_parent;
        this.guid = data.guid;
        this.menuOrder = data.menu_order;
        this.postType = data.post_type;
        this.postMimeType = data.post_mime_type;
        this.commentCount = data.comment_count;
        // NULL when unset (older rows / monolingual sites); `?? null` normalizes an undefined column
        // (a row selected before migration 0011) to the same absent value.
        this.postLanguage = data.post_language ?? null;
        this.translationGroup = data.translation_group ?? null;
        // Lazy load for async access patterns - meta might need explicit hydration
    }

    /**
     * Get post meta
     * Equivalent to get_post_meta()
     */
    async getMeta(key: string, single = true) {
        return await Post.getMeta(this.id, key, single);
    }

    /**
     * Get post terms
     */
    async getTerms(taxonomy: string) {
        const stmt = `
      SELECT t.*, tt.taxonomy, tt.description, tt.parent, tt.count
      FROM terms t
      JOIN term_taxonomy tt ON t.term_id = tt.term_id
      JOIN term_relationships tr ON tt.term_taxonomy_id = tr.term_taxonomy_id
      WHERE tr.object_id = ? AND tt.taxonomy = ?
    `;
        return await dbAsync.all(stmt, [this.id, taxonomy]);
    }

    /**
     * Las taxonomías que `toJSON()` serializa — y por tanto las únicas que se hidratan en lote.
     * Deliberadamente NO es "todas": `nav_menu` cuelga de los `nav_menu_item`, y arrastrarla aquí
     * metería cientos de filas de menú en la respuesta de un listado de entradas.
     */
    static SERIALIZED_TAXONOMIES = ['category', 'post_tag'] as const;

    /** Un bucket vacío pero DEFINIDO para cada taxonomía serializada ("resuelto: ninguno"). */
    static emptyTermsBucket(): Record<string, Array<{ id: number; name: string; slug: string }>> {
        const bucket: Record<string, Array<{ id: number; name: string; slug: string }>> = {};
        for (const taxonomy of Post.SERIALIZED_TAXONOMIES) bucket[taxonomy] = [];
        return bucket;
    }

    /**
     * Los términos de VARIOS posts en UNA sola consulta, agrupados por id de post y taxonomía.
     *
     * Es el gemelo de `getAllMetaForIds` para la taxonomía: sin esto, serializar los términos en
     * `toJSON()` convertiría cualquier listado en un N+1 (una consulta de taxonomía por entrada).
     * Todo id pedido sale con bucket definido, incluso si no tiene ningún término.
     */
    static async getTermsForIds(ids: any[]): Promise<Record<string, Record<string, Array<{ id: number; name: string; slug: string }>>>> {
        const result: Record<string, Record<string, Array<{ id: number; name: string; slug: string }>>> = {};
        const wanted = (Array.isArray(ids) ? ids : []).filter((id) => id != null);
        for (const id of wanted) result[id] = Post.emptyTermsBucket();
        if (wanted.length === 0) return result;

        const idPh = wanted.map(() => '?').join(',');
        const taxPh = Post.SERIALIZED_TAXONOMIES.map(() => '?').join(',');
        const rows = await dbAsync.all(
            `SELECT tr.object_id, t.term_id, t.name, t.slug, tt.taxonomy
             FROM term_relationships tr
             JOIN term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
             JOIN terms t ON t.term_id = tt.term_id
             WHERE tr.object_id IN (${idPh}) AND tt.taxonomy IN (${taxPh})
             ORDER BY t.name`,
            [...wanted, ...Post.SERIALIZED_TAXONOMIES]
        );
        for (const row of rows) {
            const bucket = result[row.object_id];
            if (!bucket) continue; // un id que no pedimos (no debería pasar) nunca crea entrada
            const list = bucket[row.taxonomy];
            if (!list) continue;
            list.push({ id: row.term_id, name: row.name, slug: row.slug });
        }
        return result;
    }

    /**
     * Los términos serializables de ESTE post. Prefiere el lote de `hydrateRelations`; si no lo hay
     * (ruta de post único), hace UNA consulta y la memoriza en la instancia — mismo patrón exacto que
     * el respaldo de la imagen destacada.
     */
    async getSerializedTerms(): Promise<Record<string, Array<{ id: number; name: string; slug: string }>>> {
        if (this._termsCache !== undefined) return this._termsCache;
        if (this.id == null) return (this._termsCache = Post.emptyTermsBucket());
        const byId = await Post.getTermsForIds([this.id]);
        return (this._termsCache = byId[this.id as any] || Post.emptyTermsBucket());
    }

    /**
     * The author identity of a post whose `users` row is gone (or was never there: `author_id` 0 on
     * imported content). The KEY stays present and the shape stays the declared one — an absent key
     * is indistinguishable from "the server does not send it" and forces every consumer to be
     * fail-closed, which is the exact bug the terms bucket above exists to avoid.
     */
    static unknownAuthor(authorId: any): PostAuthorRef {
        const numeric = Number(authorId);
        return { id: Number.isFinite(numeric) ? numeric : 0, displayName: '', slug: '' };
    }

    /**
     * The public author identity of SEVERAL posts in ONE query, keyed by user id.
     *
     * The twin of getTermsForIds/getAllMetaForIds for `users`: serialising the author as an object
     * without this would make every listing an N+1 over the user table.
     *
     * `user_login` IS NOT SELECTED, and that is the point rather than an economy. It used to be the
     * fallback for both fields, and `user_nicename` was a column nothing ever wrote (NOT NULL DEFAULT
     * '', config/database.ts) while `display_name` defaults to the login too (User.create) — so on a
     * default install BOTH emitted strings were verbatim `users.user_login`, the exact value the login
     * form takes, published by an anonymous `GET /posts` for every account that has ever posted. A
     * byline is not an account listing. `user_nicename` is now derived at creation (models/User.ts)
     * and backfilled for existing rows (migration 0015), and where it is still empty the fallback is
     * the user ID — an identity `?author=` already resolves and `/author/<id>` is already addressed
     * by. Not selecting the column at all is what keeps a future edit from reintroducing the leak.
     */
    static async getAuthorsForIds(ids: any[]): Promise<Record<string, PostAuthorRef>> {
        const result: Record<string, PostAuthorRef> = {};
        const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => id != null && id !== ''))];
        if (wanted.length === 0) return result;

        const placeholders = wanted.map(() => '?').join(',');
        const rows = await dbAsync.all(
            `SELECT id, display_name, user_nicename FROM users WHERE id IN (${placeholders})`,
            wanted
        );
        for (const row of rows) {
            const nicename = row.user_nicename == null ? '' : String(row.user_nicename).trim();
            result[row.id] = {
                id: row.id,
                displayName: String(row.display_name || row.id),
                slug: nicename || String(row.id),
            };
        }
        return result;
    }

    /**
     * THIS post's author, preferring hydrateRelations' batch and otherwise doing ONE query it
     * memoizes on the instance — the same fallback contract as the featured image and the terms.
     */
    async getSerializedAuthor(): Promise<PostAuthorRef> {
        if (this._authorCache !== undefined) return this._authorCache;
        if (this.authorId == null) return (this._authorCache = Post.unknownAuthor(this.authorId));
        const byId = await Post.getAuthorsForIds([this.authorId]);
        return (this._authorCache = byId[this.authorId as any] || Post.unknownAuthor(this.authorId));
    }

    /**
     * Get categories
     */
    async getCategories() {
        return await this.getTerms('category');
    }

    /**
     * Get tags
     */
    async getTags() {
        return await this.getTerms('post_tag');
    }

    /**
     * Get permalink
     * Equivalent to get_permalink()
     */
    getPermalink() {
        if (this.postType === 'page') {
            return `${config.site.url}/${this.postName}/`;
        }
        return `${config.site.url}/${this.postType}/${this.postName}/`;
    }

    /**
     * Get author
     */
    async getAuthor() {
        const User = require('./User');
        return await User.findById(this.authorId);
    }

    /**
     * Get featured image
     */
    async getFeaturedImage() {
        // Prefer pre-loaded featured image (hydrateRelations) to avoid an extra per-post query.
        if (this._featuredImageCache !== undefined) {
            return this._featuredImageCache.post;
        }
        // Prefer pre-loaded meta (hydrateRelations) to avoid an extra per-post query.
        const thumbnailId = (this._metaCache !== undefined && '_thumbnail_id' in this._metaCache)
            ? this._metaCache['_thumbnail_id']
            : await this.getMeta('_thumbnail_id');
        if (!thumbnailId) return null;
        return await Post.findById(thumbnailId);
    }

    /**
     * Convert to JSON (for API responses)
     */
    async toJSON(includeContent = true) {
        // Use pre-loaded meta if hydrateRelations() ran; otherwise query per-post (identical result).
        // Either way, keep it on the instance: getFeaturedImage() and later toJSON() calls on the
        // same post re-consulted the DB for meta this call already fetched.
        const meta = this._metaCache !== undefined ? this._metaCache : (this._metaCache = await Post.getAllMeta(this.id));

        const json: any = {
            id: this.id,
            date: this.postDate,
            dateGmt: this.postDateGmt,
            modified: this.postModified,
            modifiedGmt: this.postModifiedGmt,
            slug: this.postName,
            status: this.postStatus,
            type: this.postType,
            link: this.getPermalink(),
            title: this.postTitle,
            excerpt: stripShortcodes(this.postExcerpt || generateExcerpt(this.postContent)),
            // THE CONTRACT, NOT THE COLUMN. See PostAuthorRef: this key has been typed as an object by
            // the generated content client since F2 while the model sent the bare `author_id`, so every
            // consumer that reads `author.displayName` read `undefined`. `authorId` is emitted
            // alongside it so anything that was really after the id keeps a name for it.
            author: await this.getSerializedAuthor(),
            authorId: this.authorId,
            parent: this.postParent,
            menuOrder: this.menuOrder,
            commentStatus: this.commentStatus,
            pingStatus: this.pingStatus,
            mimeType: this.postMimeType,
            // MULTILINGUAL (opt-in): the post's own language tag (null on a monolingual site) and its
            // PUBLISHED translations in other languages. `translations` is what the public page turns
            // into <link rel="alternate" hreflang> tags — a post with no group emits an empty list.
            language: this.postLanguage || null,
            translations: await Post.getTranslations(this.id, this.translationGroup),
            meta: meta
        };

        if (includeContent) {
            json.content = await doShortcodeAsync(this.postContent);
        }

        // Add featured image
        const featuredImage = await this.getFeaturedImage();
        if (featuredImage) {
            // Dynamic URL for featured image
            // We need to fetch the file path meta to construct it safely
            // Circular dependency risk if we require Media here, so we do it manually or assume standard path
            // Prefer the pre-loaded attached file (hydrateRelations) to avoid a per-post query.
            const attachedFile = (this._featuredImageCache !== undefined)
                ? this._featuredImageCache.attachedFile
                : await Post.getMeta(featuredImage.id, '_wp_attached_file');
            let dynamicUrl = featuredImage.guid;

            if (attachedFile) {
                const safePath = attachedFile.replace(/\\/g, '/');
                dynamicUrl = `${config.site.url}/uploads/${safePath}`;
            }

            json.featuredMedia = {
                id: featuredImage.id,
                url: dynamicUrl,
                title: featuredImage.postTitle
            };
        }

        // TAXONOMÍA. Ninguna ruta devolvía los términos de un post, así que el editor no podía sembrar
        // un control de categoría/etiquetas: cualquier selector que mandase su valor BORRABA (setTerms
        // REEMPLAZA) los términos que llegaron por importación o por API. Se emiten SIEMPRE las dos
        // claves — un array vacío significa "este post no tiene ninguno", que es información, mientras
        // que una clave ausente es indistinguible de "el servidor no lo manda" y obliga al cliente a
        // ser fail-closed. `id` es el `term_id`, que es lo que `setTerms` espera de vuelta.
        const terms = await this.getSerializedTerms();
        json.categories = terms.category || [];
        json.tags = terms.post_tag || [];

        return json;
    }

    // Static methods

    /**
     * Create a new post
     * Equivalent to wp_insert_post()
     */
    static async create(data: any) {
        // Every direct model caller gets the same durable boundary as the REST service. When a route,
        // importer or media operation already owns the boundary this recursive call simply joins it.
        if (!isContentMutationActive()) return await runContentMutation(() => Post.create(data));

        const {
            authorId,
            title,
            content = '',
            excerpt = '',
            status = 'draft',
            type = 'post',
            slug,
            parent = 0,
            menuOrder = 0,
            commentStatus = 'open',
            pingStatus = 'open',
            password = '',
            mimeType = '',
            date,
            language,
            translationGroup
        } = data;

        // MULTILINGUAL: a language is validated to a canonical BCP-47 tag (or NULL — never a silent
        // fallback), and a translation group is a uuid string (or NULL). Both default to NULL so an
        // ordinary create is byte-identical to before.
        const postLanguage = language != null && language !== '' ? parseLanguageTag(language) : null;
        const postTranslationGroup = typeof translationGroup === 'string' && translationGroup ? translationGroup : null;

        // THE COLUMNS' TYPES ARE THE MODEL'S BUSINESS — see scalarString above. Every one of these is
        // compared against a string literal by SOME caller before it gets here (the publish gate reads
        // `status`, the capability gate reads `type`), and the driver would flatten an Array back into
        // the string those comparisons decided they were not looking at. The routes answer 400 for the
        // request; this answers "not a legal call" for everything else, so the column's contract does
        // not depend on which door the write came through.
        const postType = scalarString(type, 'type', 'post');
        const requestedStatus = scalarString(status, 'status', 'draft');
        const postCommentStatus = scalarString(commentStatus, 'commentStatus', 'open');
        const postPingStatus = scalarString(pingStatus, 'pingStatus', 'open');
        const postPassword = scalarString(password, 'password', '');
        const postMimeType = scalarString(mimeType, 'mimeType', '');

        // Generate slug from title if not provided. The caller's slug is kept VERBATIM here on
        // purpose — the WXR importer must preserve a foreign permalink, including a percent-encoded
        // non-latin one — and is BOUNDED inside generateUniqueSlug, which is the one point every
        // writer of post_name passes through. Requests get the stricter treatment one level up, where
        // routes/posts.ts runs the body's slug through sanitizeTitle before calling this.
        let postName = scalarString(slug, 'slug', '') || sanitizeTitle(title);

        // Ensure unique slug
        postName = await Post.generateUniqueSlug(postName, postType);

        // Sanitize content
        const sanitizedContent = sanitizeContent(content);

        const now = currentTime();
        const nowGmt = currentTimeGMT();

        // Scheduled publishing (WordPress parity): a caller-supplied post_date decides post_date /
        // post_date_gmt, and a 'publish' whose date is in the FUTURE is stored as 'future' + armed with a
        // one-off cron event that flips it live at that moment. A past/now date publishes immediately.
        const scheduledPublish = require('../core/scheduled-publish');
        let postDate = now;
        let postDateGmt = nowGmt;
        let effectiveStatus = requestedStatus;
        let scheduledWhenMs: number | null = null;
        if (date !== undefined && date !== null && date !== '') {
            const d = new Date(date);
            if (!Number.isNaN(d.getTime())) {
                postDate = formatDate(d);
                postDateGmt = d.toISOString().slice(0, 19).replace('T', ' ');
                effectiveStatus = scheduledPublish.resolveScheduledStatus(requestedStatus, d.getTime());
                if (effectiveStatus === 'future') scheduledWhenMs = d.getTime();
            }
        }

        // Generate GUID
        const guid = `${config.site.url}/?p=${Date.now()}`;

        // Postgres requires RETURNING id to get the inserted ID
        const result = await dbAsync.run(`
      INSERT INTO posts (
        author_id, post_date, post_date_gmt, post_content, post_title, post_excerpt,
        post_status, comment_status, ping_status, post_password, post_name,
        post_modified, post_modified_gmt, post_parent, guid, menu_order, post_type, post_mime_type,
        post_language, translation_group
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [
            authorId || 0,
            postDate,
            postDateGmt,
            sanitizedContent,
            title,
            excerpt,
            effectiveStatus,
            postCommentStatus,
            postPingStatus,
            postPassword,
            postName,
            now,
            nowGmt,
            parent,
            guid,
            menuOrder,
            postType,
            postMimeType,
            postLanguage,
            postTranslationGroup
        ]);

        const postId = result.lastID;

        // Update GUID with actual post ID
        await dbAsync.run('UPDATE posts SET guid = ? WHERE id = ?', [`${config.site.url}/?p=${postId}`, postId]);

        // Arm the flip event for a scheduled post (only once we know its id).
        if (scheduledWhenMs !== null) {
            await scheduledPublish.scheduleFuturePublish(postId, scheduledWhenMs);
        }

        // A 404 for this slug may be negative-cached (findBySlug) — the new post must resolve on
        // the very next read, not when the sentinel expires.
        if (postName) {
            await cache.del(`post:slug:${postType}:${postName}`);
            await cache.del(`post:slug:any:${postName}`);
        }

        // The semantic event is durable in the SAME transaction. Its dispatcher invalidates again as
        // a crash-safe backstop and runs wp_insert_post only after COMMIT.
        Post._invalidateCounts();
        recordContentEvent('post.created', Number(postId), {
            data,
            previousType: postType,
            previousSlug: postName,
        });

        return await Post.findById(postId);
    }

    /**
     * Generate unique slug
     *
     * THE BOUND LIVES HERE, AT THE WRITE, not only in the producer.
     *
     * THE CLASS: a rule enforced in the function that USUALLY makes the value, while the column can be
     * reached by a caller that makes it some other way. `sanitizeTitle` bounds the slug it derives from
     * a title, so a 300-character TITLE was fine — but `Post.create({slug})` took the caller's slug
     * verbatim and wrote 300 characters into `posts.post_name`, which drivers/mysql-text-rule narrows
     * to VARCHAR(255) the moment idx_posts_name is created: ERROR 1406 under STRICT_TRANS_TABLES, i.e.
     * an unmapped 500 on MySQL and nothing at all on SQLite, which is why the suite stayed green.
     *
     * Every writer of post_name goes through this function (create, update, and the importer through
     * create), and it is also where the `-2`, `-3`, … suffix is appended — so this is the only place
     * that can promise the FINAL value fits. Bounding here, rather than at each caller, is what makes
     * "the checked representation and the written representation are the same" true by construction.
     */
    static async generateUniqueSlug(slug: string, postType: string, excludeId: any = null) {
        // The BASE is bounded once, and every disambiguated variant is built from the bounded base —
        // not from the caller's original string, or the suffix would push the value back over.
        const base = boundSlug(slug);
        let uniqueSlug = base;
        let counter = 1;

        while (true) {
            let query = 'SELECT id FROM posts WHERE post_name = ? AND post_type = ?';
            const params = [uniqueSlug, postType];

            if (excludeId) {
                query += ' AND id != ?';
                params.push(excludeId);
            }

            const existing = await dbAsync.get(query, params);
            if (!existing) break;

            counter++;
            uniqueSlug = `${base}-${counter}`;
        }

        return uniqueSlug;
    }

    /**
     * Find post by ID
     * Equivalent to get_post()
     */
    static async findById(id: any) {
        if (!id) return null;

        // 1. Try Cache
        const cacheKey = `post:id:${id}`;
        const cached = await cache.get(cacheKey);
        if (cached) return new Post(cached);

        // 2. Database
        const row = await dbAsync.get('SELECT * FROM posts WHERE id = ?', [id]);
        if (!row) return null;

        const post = new Post(row);

        // 3. Store in Cache
        await cache.set(cacheKey, row);

        return post;
    }

    static async findBySlug(slug: string, type: any = null) {
        if (!slug) return null;

        // 1. Try Cache
        const cacheKey = `post:slug:${type || 'any'}:${slug}`;
        const cached = await cache.get(cacheKey);
        if (cached) {
            if (cached.__miss) return null; // cached ABSENCE — a 404 crawl is no longer a DB workout
            return new Post(cached);
        }

        // 2. Database
        let sql = 'SELECT * FROM posts WHERE post_name = ?';
        const params = [slug];

        if (type && type !== 'any') {
            sql += ' AND post_type = ?';
            params.push(type);
        }

        const row = await dbAsync.get(sql, params);
        if (!row) {
            // Negative cache, short TTL. create() dels this key, so a brand-new post with a
            // previously-404 slug resolves on the very next read.
            await cache.set(cacheKey, { __miss: 1 }, 10);
            return null;
        }

        const post = new Post(row);

        // 3. Store in Cache
        await cache.set(cacheKey, row);
        // Also store by ID in cache since we have it now
        await cache.set(`post:id:${row.id}`, row);

        return post;
    }

    /**
     * Find one post by criteria
     */
    static async findOne(criteria: any) {
        const posts = await Post.findAll({ ...criteria, limit: 1 });
        return posts.length > 0 ? posts[0] : null;
    }

    /**
     * Find posts by term ID
     */
    static async findByTerm(termId: any, limit = 10) {
        const sql = `
            SELECT p.* FROM posts p
            JOIN term_relationships tr ON p.id = tr.object_id
            JOIN term_taxonomy tt ON tr.term_taxonomy_id = tt.term_taxonomy_id
            WHERE tt.term_id = ? AND p.post_status = 'publish'
            ORDER BY p.post_date DESC
            LIMIT ?
        `;
        const rows = await dbAsync.all(sql, [termId, limit]);
        return rows.map((row: any) => new Post(row));
    }

    /**
     * Get recent posts
     */
    static async getRecent(limit = 10, type = 'post') {
        return await Post.findAll({ limit, type, status: 'publish' });
    }

    /**
     * A `categories` / `tags` / `author` value, whatever shape the caller had, as ids + slugs.
     *
     * The HTTP contract (which spellings are legal, and which answer 400) belongs to the route —
     * routes/posts.ts validates before it ever gets here. This is the tolerant normaliser the model
     * owes its DIRECT callers (a plugin, a test, core code holding a term id), and it accepts the four
     * shapes those callers actually have: a number, an array, a comma-separated string, or the
     * already-parsed selector. Returns null for "no filter", never an empty selector — the difference
     * between "filter by nothing" and "do not filter" is the difference between zero rows and all of
     * them, and only the caller knows which it meant.
     */
    static identityFilter(value: any): PostIdentityFilter | null {
        if (value === undefined || value === null || value === '') return null;
        if (typeof value === 'object' && !Array.isArray(value)
            && (Array.isArray(value.ids) || Array.isArray(value.slugs))) {
            const ids = (value.ids || []).map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id));
            const slugs = (value.slugs || []).map((slug: any) => String(slug)).filter(Boolean);
            return ids.length || slugs.length ? { ids, slugs } : null;
        }
        const tokens: any[] = Array.isArray(value) ? value : String(value).split(',');
        const ids: number[] = [];
        const slugs: string[] = [];
        for (const token of tokens) {
            const text = typeof token === 'number' ? String(token) : String(token == null ? '' : token).trim();
            if (!text) continue;
            // Split by SHAPE, exactly as the author feed reads its path segment: all-digits is an id.
            if (/^[0-9]+$/.test(text)) ids.push(Number(text));
            else slugs.push(text);
        }
        return ids.length || slugs.length ? { ids, slugs } : null;
    }

    /**
     * The WHERE fragment for one taxonomy filter, as a semi-join on the term relationships.
     *
     * `<posts>.id IN (SELECT tr.object_id …)` rather than a JOIN on purpose: a JOIN would multiply the
     * row by the number of matching terms, which silently breaks BOTH halves of the pagination it has
     * to keep honest (LIMIT/OFFSET over duplicated rows, and a COUNT(*) that counts relationships
     * instead of posts). The subquery reads three tables none of which is `posts`, so it is also the
     * one shape MySQL accepts here — its ER 1093 refusal is about a subquery over the statement's OWN
     * table, and there is no LIMIT inside it (ER 1235).
     *
     * Every value is a placeholder, on all three drivers, so the identity a caller sent can only ever
     * be compared — never parsed as SQL.
     */
    static _taxonomyCondition(selector: PostIdentityFilter, taxonomy: string, col: string) {
        const parts: string[] = [];
        const params: any[] = [taxonomy];
        if (selector.ids.length) {
            parts.push(`t.term_id IN (${selector.ids.map(() => '?').join(',')})`);
            params.push(...selector.ids);
        }
        if (selector.slugs.length) {
            parts.push(`t.slug IN (${selector.slugs.map(() => '?').join(',')})`);
            params.push(...selector.slugs);
        }
        // An empty selector cannot reach here (identityFilter answers null), but an impossible
        // condition — never a dropped filter — is the fail-closed answer if it ever did.
        if (parts.length === 0) return { sql: '1 = 0', params: [] as any[] };
        return {
            sql: `${col}id IN (`
                + 'SELECT tr.object_id FROM term_relationships tr '
                + 'JOIN term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id '
                + 'JOIN terms t ON t.term_id = tt.term_id '
                + `WHERE tt.taxonomy = ? AND (${parts.join(' OR ')}))`,
            params,
        };
    }

    /**
     * The WHERE fragment for the author filter, or null when there is none.
     *
     * A bare number keeps the EXACT `author_id = ?` shape this model has always emitted — the list
     * route's authorization forces a concrete id (or the -1 sentinel that must match nothing) into
     * this option and nothing about that may change. Anything else is the ids/slugs selector: ids are
     * compared against the column, slugs are resolved through `users` in a subquery so a public page
     * can narrow by nicename without a users endpoint to enumerate — and, as the slug branch spells
     * out, without the subquery itself becoming the enumeration.
     */
    static _authorCondition(author: any, col: string): { sql: string; params: any[] } | null {
        if (author === undefined || author === null || author === '') return null;
        if (typeof author === 'number') {
            if (!Number.isFinite(author) || author === 0) return null;
            return { sql: `${col}author_id = ?`, params: [author] };
        }
        const selector = Post.identityFilter(author);
        if (!selector) return null;

        const parts: string[] = [];
        const params: any[] = [];
        if (selector.ids.length) {
            parts.push(`${col}author_id IN (${selector.ids.map(() => '?').join(',')})`);
            params.push(...selector.ids);
        }
        if (selector.slugs.length) {
            const ph = selector.slugs.map(() => '?').join(',');
            // THE SLUG IS `user_nicename`. `user_login` is accepted only for an account that has no
            // nicename — the pre-0015 rows the backfill could not name — and NEVER as an alias for
            // one that does.
            //
            // The unconditional `OR user_login IN (…)` this replaces was a login-existence ORACLE on
            // an anonymous endpoint: `?author=<guess>` returned that account's posts on a hit and an
            // empty list on a miss, so the filter answered "does this login exist" for any guess, one
            // request at a time. That is the same fact the serialiser stopped publishing two hundred
            // lines up; leaving the query able to confirm it one login at a time would have moved the
            // leak rather than closed it. An input may accept an identifier the caller already holds
            // — it may not become a way to discover one.
            //
            // `user_nicename <> ''` on the first branch because this schema defaults that column to
            // the empty string: without it a slug that normalised to '' would match every account at
            // once. The `IS NULL` on the second is defensive — the column is NOT NULL on all three
            // drivers, and a future one that isn't must not silently turn the login back into a
            // universal alias.
            parts.push(`${col}author_id IN (SELECT id FROM users `
                + `WHERE (user_nicename IN (${ph}) AND user_nicename <> '') `
                + `OR (user_login IN (${ph}) AND (user_nicename IS NULL OR user_nicename = '')))`);
            params.push(...selector.slugs, ...selector.slugs);
        }
        if (parts.length === 0) return { sql: '1 = 0', params: [] };
        return { sql: parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`, params };
    }

    /**
     * Build the shared WHERE clause used by BOTH findAll() and count() so the two
     * can never drift. Returns { joins, conditions, params }. The `alias` param
     * controls column prefixing: pass 'p' when querying `posts p` (findAll), or ''
     * for bare columns (count). The metaKey JOIN is only emitted when an alias is
     * supplied (count() does not select rows, so it needs no meta join).
     */
    static buildWhere(options: any = {}, alias = 'p') {
        const {
            type = 'post',
            status = 'publish',
            author,
            search,
            parent,
            includeStatuses = null,
            metaKey,
            metaValue,
            mimeType,
            categories,
            tags
        } = options;

        const col = alias ? `${alias}.` : '';
        const joins: string[] = [];
        const conditions: string[] = [];
        const params: any[] = [];

        // Meta query join (only meaningful when selecting rows via an alias)
        if (metaKey && alias) {
            joins.push(`JOIN post_meta pm ON ${alias}.id = pm.post_id`);
            conditions.push('pm.meta_key = ?');
            params.push(metaKey);
            if (metaValue !== undefined) {
                conditions.push('pm.meta_value = ?');
                params.push(metaValue);
            }
        }

        // Post type
        if (type) {
            if (Array.isArray(type)) {
                conditions.push(`${col}post_type IN (${type.map(() => '?').join(',')})`);
                params.push(...type);
            } else {
                conditions.push(`${col}post_type = ?`);
                params.push(type);
            }
        }

        // Post status.
        //
        // `status: 'any'` is a WordPress-compatible PSEUDO-status meaning "every status a reader could
        // legitimately be shown", NOT a literal value: it used to fall through to `post_status = 'any'`,
        // a string that matches no row, so every caller asking for 'any' silently got ZERO posts
        // (exportSite() exported an empty site on an install with 17 posts + 38 pages — F7/H1). It is
        // resolved here, in the ONE shared builder, so findAll() and count() can never disagree and no
        // caller needs a local patch.
        //
        // Semantics (WordPress `post_status=any`): everything EXCEPT the statuses WP marks
        // exclude_from_search — 'trash' (soft-deleted: restoring it is the trash UI's job, an export or
        // a listing must not resurrect it) and 'auto-draft' (an empty row the editor created and the
        // author never saved). 'inherit' stays IN, as in WP: attachments carry it (revisions do too, but
        // they are excluded by post_type, never by status).
        //
        // Callers that really want EVERY row, trash included, ask explicitly: pass
        // `includeStatuses: [...]` with the exact list, or `status: null` for no status filter at all.
        if (includeStatuses) {
            conditions.push(`${col}post_status IN (${includeStatuses.map(() => '?').join(',')})`);
            params.push(...includeStatuses);
        } else if (status) {
            if (status === 'any') {
                conditions.push(`${col}post_status NOT IN (?, ?)`);
                params.push('trash', 'auto-draft');
            } else if (Array.isArray(status)) {
                conditions.push(`${col}post_status IN (${status.map(() => '?').join(',')})`);
                params.push(...status);
            } else {
                conditions.push(`${col}post_status = ?`);
                params.push(status);
            }
        }

        // Author — a bare id (every existing caller), or the ids/slugs selector the list route parses.
        const authorClause = Post._authorCondition(author, col);
        if (authorClause) {
            conditions.push(authorClause.sql);
            params.push(...authorClause.params);
        }

        // TAXONOMY FILTERS — `categories` and `tags`, the two taxonomies toJSON() serialises.
        //
        // They were destructured by the list route and passed to NOTHING, so `?categories=3` returned
        // exactly the rows no filter returns: a listing that answered a different question than the
        // one it was asked, confidently, with the matching X-WP-Total. They live HERE, in the shared
        // builder, for the same reason `mimeType` does — a filter applied only to the rows would leave
        // the paginator counting the whole site and announcing pages that come back empty.
        //
        // AND ACROSS taxonomies (two conditions, ANDed like every other filter here), OR WITHIN a list
        // (one condition per taxonomy whose subquery matches any of the requested terms) — WordPress's
        // `categories=`/`tags=` semantics.
        for (const [value, taxonomy] of [[categories, 'category'], [tags, 'post_tag']] as const) {
            const selector = Post.identityFilter(value);
            if (!selector) continue;
            const clause = Post._taxonomyCondition(selector, taxonomy, col);
            conditions.push(clause.sql);
            params.push(...clause.params);
        }

        // Parent
        if (parent !== undefined) {
            conditions.push(`${col}post_parent = ?`);
            params.push(parent);
        }

        // MIME type (lo usa la biblioteca de medios: los adjuntos guardan su tipo en post_mime_type).
        // Vive AQUÍ, en el constructor compartido, precisamente para que el listado y el COUNT(*) no
        // puedan divergir — un filtro aplicado sólo a las filas dejaría el paginador contando toda la
        // biblioteca y anunciando páginas vacías.
        //
        // Dos formas, como acepta WordPress: 'image/png' filtra EXACTO, y 'image' o 'image/' filtra por
        // familia. El caso exacto usa `=`, así que no hay comodines que escapar; el de familia usa LIKE,
        // y por eso el prefijo se valida contra un juego de caracteres sin '%' ni '_' (que en LIKE SON
        // comodines: un `mime_type=%` habría listado la biblioteca entera fingiendo ser un filtro).
        // Un prefijo que no valida NO se ignora — se emite una condición imposible, para que filtro y
        // total digan lo mismo (0) en vez de devolver la biblioteca completa.
        if (mimeType !== undefined && mimeType !== null && String(mimeType).trim() !== '') {
            const requested = String(mimeType).trim().replace(/\/+$/, '');
            if (requested.includes('/')) {
                conditions.push(`${col}post_mime_type = ?`);
                params.push(requested);
            } else if (/^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/.test(requested)) {
                conditions.push(`${col}post_mime_type LIKE ?`);
                params.push(`${requested}/%`);
            } else {
                conditions.push('1 = 0');
            }
        }

        // Search — the engine's native full-text index when this install has one, else the LIKE scan.
        // The concrete engine is resolved ONCE (async) by findAll/count and threaded in as
        // `options._searchEngine`; a direct, synchronous buildWhere caller (e.g. a unit test) gets the
        // SQLite answer from the sync probe. Either way the FILTER produced here composes with every
        // other condition AND with the COUNT(*) that reuses this builder.
        if (search) {
            const engine = options._searchEngine !== undefined ? options._searchEngine : Post._syncSearchEngine();
            const clauses = Post._searchClauses(engine, search, col);
            if (clauses) {
                conditions.push(clauses.filterSql);
                params.push(...clauses.filterParams);
            } else {
                // Best-effort fallback: no usable FTS engine (sqlite-legacy, FTS5 compiled out, a term
                // too short for MySQL's min token size, or nothing indexable survived sanitisation).
                conditions.push(`(${col}post_title LIKE ? OR ${col}post_content LIKE ?)`);
                const searchTerm = `%${search}%`;
                params.push(searchTerm, searchTerm);
            }
        }

        return { joins, conditions, params };
    }

    /**
     * The full-text engine backing THIS install's search, or null when none applies (→ LIKE).
     *
     *   'fts5'  → SQLite with the posts_fts index (bm25 relevance)
     *   'pg'    → Postgres with the search_vector tsvector column (ts_rank relevance)
     *   'mysql' → MySQL/InnoDB with the FULLTEXT index (MATCH…AGAINST relevance)
     *
     * Resolved ONCE per process and cached. Postgres/MySQL need an async catalog probe (their drivers
     * expose no synchronous handle), so the async resolver is what findAll/count call; the sync probe
     * below only ever answers for SQLite and is the default for direct buildWhere callers.
     */
    static _searchEngineCache: string | null | undefined = undefined;

    static _syncSearchEngine(): string | null {
        // Synchronous best-effort: only SQLite exposes a sync handle here. Anything else stays null
        // until the async resolver has run (which findAll/count always do before a search query).
        return Post._ftsAvailable() ? 'fts5' : null;
    }

    static async _resolveSearchEngine(): Promise<string | null> {
        if (Post._searchEngineCache !== undefined) return Post._searchEngineCache;
        try {
            const { getDbType } = require('../config/database');
            const driver = typeof getDbType === 'function' ? getDbType().driver : null;
            if (driver && String(driver).startsWith('sqlite')) {
                return (Post._searchEngineCache = Post._ftsAvailable() ? 'fts5' : null);
            }
            if (driver === 'postgres') {
                const row = await dbAsync.get(
                    `SELECT 1 AS ok FROM information_schema.columns ` +
                    `WHERE table_name = 'posts' AND column_name = 'search_vector' LIMIT 1`
                );
                return (Post._searchEngineCache = row ? 'pg' : null);
            }
            if (driver === 'mysql' || driver === 'mariadb') {
                const row = await dbAsync.get(
                    `SELECT 1 AS ok FROM information_schema.statistics ` +
                    `WHERE table_schema = DATABASE() AND table_name = 'posts' AND index_name = 'ftidx_posts_search' LIMIT 1`
                );
                return (Post._searchEngineCache = row ? 'mysql' : null);
            }
            return (Post._searchEngineCache = null);
        } catch {
            return (Post._searchEngineCache = null);
        }
    }

    /**
     * The per-engine SEARCH clauses for one query string, or null to signal "fall back to LIKE".
     *
     * Returns a filter (used by the WHERE of both the rows query and COUNT(*)) and a relevance order
     * (used only by the rows query) so that EVERY engine returns the more-relevant document first
     * behind one uniform interface — callers never branch on the driver.
     *
     *   fts5  : filter = rowid IN (MATCH …); order = bm25() ASC (more negative = better match)
     *   pg    : filter = search_vector @@ plainto_tsquery(…); order = ts_rank(…) DESC
     *   mysql : filter = MATCH…AGAINST(… NATURAL LANGUAGE); order = the same score DESC
     *
     * INJECTION / PARSE SAFETY — the whole point of the sanitising here:
     *   • fts5  strips FTS5 syntax characters and re-quotes each token as a literal phrase, so a stray
     *           `"` or `NEAR(` is text, never an operator or a SQLITE_ERROR thrown at the visitor.
     *   • pg    uses plainto_tsquery, which parses the input as PLAIN TEXT (operators are ignored, it
     *           never raises the syntax error that raw to_tsquery would) and the value is a bound param.
     *   • mysql uses NATURAL LANGUAGE MODE, where + - * and quotes are NOT operators, and a bound param.
     * In all three the query value is a placeholder, so SQL injection is structurally impossible.
     */
    static _searchClauses(
        engine: string | null,
        search: string,
        col: string
    ): { filterSql: string; filterParams: any[]; orderSql: string; orderParams: any[] } | null {
        if (!engine) return null;

        if (engine === 'fts5') {
            const match = Post._ftsMatchQuery(search);
            if (!match) return null;
            return {
                filterSql: `${col}id IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)`,
                filterParams: [match],
                // bm25() lives inside a query over posts_fts; a correlated subquery pulls the score for
                // each already-matched row. bm25 returns a negative number where MORE negative = better,
                // so ASC orders best-first. Only the matched set is walked, so this stays cheap.
                orderSql: `(SELECT bm25(posts_fts) FROM posts_fts WHERE posts_fts MATCH ? AND rowid = ${col}id) ASC`,
                orderParams: [match]
            };
        }

        if (engine === 'pg') {
            const q = String(search).trim();
            if (!q) return null;
            const cols = `${col}search_vector`;
            return {
                filterSql: `${cols} @@ plainto_tsquery('english', ?)`,
                filterParams: [q],
                orderSql: `ts_rank(${cols}, plainto_tsquery('english', ?)) DESC`,
                orderParams: [q]
            };
        }

        if (engine === 'mysql') {
            const q = String(search).trim();
            // MySQL's InnoDB FULLTEXT ignores tokens below innodb_ft_min_token_size (default 3). A query
            // with no indexable token (e.g. "hi", "a b") would MATCH nothing in NATURAL LANGUAGE mode, so
            // fall back to LIKE for those — documented, graceful, never an empty result where LIKE finds one.
            if (!Post._mysqlHasIndexableToken(q)) return null;
            const expr = `MATCH(${col}post_title, ${col}post_content, ${col}post_excerpt) AGAINST(? IN NATURAL LANGUAGE MODE)`;
            return {
                filterSql: expr,
                filterParams: [q],
                orderSql: `${expr} DESC`,
                orderParams: [q]
            };
        }

        return null;
    }

    /** True when a query has at least one token long enough for MySQL's FULLTEXT min token size. */
    static _mysqlHasIndexableToken(search: string, minLen = 3): boolean {
        return String(search)
            .split(/[^0-9A-Za-zÀ-￿]+/)
            .some((t) => t.length >= minLen);
    }

    /**
     * Is the FTS5 index present? Probed ONCE per process against sqlite_master and cached — the
     * answer only changes when migration 0008 runs, which happens at boot before any query.
     * Anything that is not a SQLite install with FTS5 compiled in resolves to false, and search
     * keeps using the LIKE scan with byte-identical behaviour.
     */
    static _ftsProbe: boolean | null = null;
    static _ftsAvailable(): boolean {
        if (Post._ftsProbe !== null) return Post._ftsProbe;
        try {
            const { db, getDbType } = require('../config/database');
            const type = typeof getDbType === 'function' ? getDbType() : null;
            if (type && type.driver && !String(type.driver).startsWith('sqlite')) {
                return (Post._ftsProbe = false);
            }
            const row = db.prepare
                ? db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts_fts'").get()
                : null;
            return (Post._ftsProbe = !!row);
        } catch {
            return (Post._ftsProbe = false);
        }
    }

    /**
     * Turn a user's search box input into an FTS5 MATCH expression.
     *
     * User text can NEVER be passed through raw: FTS5 has its own query language (quotes, NEAR,
     * column filters, `-` negation, `*`), so a stray character is either a SQLITE_ERROR thrown at
     * the visitor or an operator they did not intend. Every token is therefore stripped of syntax
     * characters and re-quoted as a literal phrase, and the LAST token gets a `*` so type-ahead
     * ("word" while typing "wordjs") still matches — the closest honest equivalent of the old
     * substring LIKE. Returns null when nothing usable survives, and the caller falls back to LIKE.
     */
    static _ftsMatchQuery(search: string): string | null {
        const tokens = String(search)
            .replace(/["'^*():-]/g, ' ')   // FTS5 syntax characters — never let them through
            .split(/\s+/)
            .map((t) => t.trim())
            .filter(Boolean);
        if (!tokens.length) return null;
        return tokens
            .map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`))
            .join(' AND ');
    }

    /**
     * Query posts
     * Equivalent to WP_Query
     */
    static async findAll(options: any = {}) {
        const {
            limit = 10,
            offset = 0,
            orderBy = 'post_date',
            order = 'DESC'
        } = options;

        let sql = 'SELECT p.* FROM posts p';

        // Resolve the full-text engine ONCE per search so the WHERE filter (here and in COUNT) and the
        // relevance ORDER BY below agree on the same backend. Non-search queries never pay the probe.
        const searchEngine = options.search ? await Post._resolveSearchEngine() : null;
        const whereOptions = options.search ? { ...options, _searchEngine: searchEngine } : options;

        const { joins, conditions, params } = Post.buildWhere(whereOptions, 'p');

        if (joins.length > 0) {
            sql += ' ' + joins.join(' ');
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }

        // Order
        // Safe check for order by column
        const allowedOrderBy = ['id', 'post_date', 'post_title', 'post_modified', 'menu_order', 'comment_count'];
        const safeOrderBy = allowedOrderBy.includes(orderBy) ? `p.${orderBy}` : 'p.post_date';
        const safeOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        // RELEVANCE FIRST for a search: every engine returns the more-relevant document ahead of the
        // less-relevant one, with the requested column (date by default) only breaking ties. The order
        // params sit between the WHERE params and LIMIT/OFFSET — exactly their `?` position in the SQL.
        const searchOrder = options.search ? Post._searchClauses(searchEngine, options.search, 'p.') : null;
        if (searchOrder && searchOrder.orderSql) {
            sql += ` ORDER BY ${searchOrder.orderSql}, ${safeOrderBy} ${safeOrder}`;
            params.push(...searchOrder.orderParams);
        } else {
            sql += ` ORDER BY ${safeOrderBy} ${safeOrder}`;
        }

        // Pagination
        // Use params for limit/offset
        sql += ' LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const rows = await dbAsync.all(sql, params);

        return rows.map((row: any) => new Post(row));
    }

    /**
     * UNIFIED search entry point — engine-agnostic full-text search with relevance ordering.
     *
     * Callers hand it a query string and the usual listing options (type/status/author/paging); it
     * returns Post rows most-relevant first on WHATEVER engine backs this install (SQLite FTS5,
     * Postgres tsvector, MySQL FULLTEXT) and degrades to a LIKE scan where none is available. This is
     * the single path the REST list route and the public /search page flow through, so improving the
     * engine here improves every caller at once — none of them branch on the driver.
     */
    static async search(query: string, options: any = {}) {
        return Post.findAllWithRelations({ ...options, search: query });
    }

    /**
     * Count posts
     * Equivalent to wp_count_posts()
     */
    /**
     * Generation stamp for cached COUNT(*) results. Bumped by every write that can change a count
     * (create / update / delete), which retires every cached entry at once — the alternative would
     * be enumerating cache keys built from arbitrary SQL + params.
     */
    static _countGen = 0;
    static _invalidateCounts() {
        if (database.afterCommit(() => Post._invalidateCounts())) return;
        Post._countGen++;
    }

    static async count(options: any = {}) {
        // Reuse the exact same WHERE logic as findAll() so the two cannot drift.
        // Use bare columns (no alias) since this is a single-table COUNT(*).
        let sql = 'SELECT COUNT(*) as count FROM posts';

        // Same engine resolution as findAll so the COUNT filter matches the rows filter exactly — a
        // drift here would report a total that disagrees with the page it accompanies.
        const searchEngine = options.search ? await Post._resolveSearchEngine() : null;
        const whereOptions = options.search ? { ...options, _searchEngine: searchEngine } : options;

        const { conditions, params } = Post.buildWhere(whereOptions, '');

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }

        // Every paginated listing pays this COUNT(*) alongside its rows (it is the X-WP-Total
        // header), and paging through a list or typing in a search box repeats it unchanged.
        //
        // A plain TTL cache would be WRONG here: publishing a post and immediately looking at the
        // list must show the new total, not a number up to N seconds old. So the key carries a
        // GENERATION that every post write bumps — a create/update/delete invalidates every cached
        // count at once, and this node reads its own writes instantly. The TTL then only bounds the
        // multi-node case, where another replica's write has not bumped this process's generation.
        const cacheKey = `postcount:${Post._countGen}:${sql}|${JSON.stringify(params)}`;
        const cached = await cache.get(cacheKey);
        if (cached && typeof cached.n === 'number') return cached.n;

        const row = await dbAsync.get(sql, params);
        await cache.set(cacheKey, { n: row.count }, 10);
        return row.count;
    }

    /**
     * Update a post
     * Equivalent to wp_update_post()
     */
    static async update(id: any, data: any) {
        if (!isContentMutationActive()) return await runContentMutation(() => Post.update(id, data));
        const post = await Post.findById(id);
        if (!post) throw new Error('Post not found');

        // THE SAME SINK-SIDE TYPE CONTRACT AS Post.create — see scalarString. `status` is the field
        // that decides public visibility and it is compared against literals in three places between
        // here and the route; an Array reaching a bound parameter would be flattened back into the
        // string those comparisons rejected. Absent stays absent (undefined), because "key not sent"
        // means "leave the column alone" everywhere in this method.
        if (data.status !== undefined) scalarString(data.status, 'status', 'draft');
        if (data.slug !== undefined) scalarString(data.slug, 'slug', '');
        if (data.commentStatus !== undefined) scalarString(data.commentStatus, 'commentStatus', 'open');
        if (data.language !== undefined && data.language !== null) scalarString(data.language, 'language', '');

        const updates: string[] = [];
        const values: any[] = [];

        // Scheduled publishing (WordPress parity). Resolve the target date + status BEFORE building the
        // UPDATE so the row is written with the correct 'future'/'publish' state, then arm/cancel the
        // flip event AFTER the write. `scheduledWhenMs` is the moment to (re)arm for; `cancelSchedule`
        // marks a post leaving 'future' so its pending event is cleared (no orphan events).
        const scheduledPublish = require('../core/scheduled-publish');
        let whenMs: number | null = null;
        /** Did the CALLER name a date (as opposed to one this method stamped)? */
        let explicitDate = false;
        if (data.date !== undefined && data.date !== null && data.date !== '') {
            const d = new Date(data.date);
            if (!Number.isNaN(d.getTime())) {
                whenMs = d.getTime();
                explicitDate = true;
                updates.push('post_date = ?', 'post_date_gmt = ?');
                values.push(formatDate(d), d.toISOString().slice(0, 19).replace('T', ' '));
            }
        }

        // A bare "Publish" must never be turned into a SCHEDULE by a date nobody asked for.
        //
        // The block above only touches the date columns when `data.date` arrives, so a post that had
        // once been scheduled for December kept that post_date_gmt through un-scheduling (the editor
        // sends {status:'draft'} with NO date). The next plain {status:'publish'} then re-evaluated
        // against that ORPHAN stored date a few lines below and resolveScheduledStatus turned it into
        // 'future' again: the author pressed Publish and the post did not publish.
        //
        // Fix in the shape of wp_publish_post(): a publish with no explicit date whose STORED date
        // would schedule it is stamped with the current time instead. The "would schedule it" test
        // goes through resolveScheduledStatus itself, so this branch and the resolution below cannot
        // disagree about what counts as future (same whole-second comparison, same injectable clock).
        // Deliberately narrow:
        //   - only when `data.status === 'publish'` was explicitly requested — a date-only edit or a
        //     bare re-save keeps re-evaluating as before;
        //   - never for a post already in 'future', so re-saving a scheduled post does not publish it
        //     early (that is what the cron flip event is for);
        //   - never when the stored date is in the PAST, so untrash() (which publishes with no date)
        //     restores a post at its original publication date instead of moving it to now;
        //   - and ONLY for a date that is genuinely ORPHANED (see UNSCHEDULED_DATE_META below).
        //
        // That last condition is the adversarial re-verify of the fix: two very different situations
        // arrive here byte-for-byte identical — a leftover date from a schedule the author CANCELLED,
        // and a future date the author TYPED on a draft and has not published yet. Stamping "now" is
        // right for the first and destroys the second's data with no warning and no undo. So the model
        // stops guessing and reads the mark it wrote at the only moment the two can be told apart: the
        // un-scheduling itself. No mark ⇒ the date is the author's ⇒ a publish over a future date
        // SCHEDULES, which is both WordPress's behaviour and what the person asked for.
        let stampedOrphanDate = false;
        if (whenMs === null && data.status === 'publish' && post.postStatus !== 'future') {
            const storedMs = scheduledPublish.parseDbDateMs(post.postDateGmt, true);
            if (scheduledPublish.resolveScheduledStatus('publish', storedMs) === 'future'
                && await Post.getMeta(id, UNSCHEDULED_DATE_META)) {
                const nowDate = new Date(scheduledPublish.nowMs());
                whenMs = nowDate.getTime();
                stampedOrphanDate = true;
                updates.push('post_date = ?', 'post_date_gmt = ?');
                values.push(formatDate(nowDate), nowDate.toISOString().slice(0, 19).replace('T', ' '));
            }
        }

        // The status we intend the post to end up in: an explicit request wins; a date-only edit
        // re-evaluates the CURRENT status against the new date (publish→future or future→publish); a
        // bare re-save of a still-'future' post re-evaluates too (so a passed date self-heals to publish).
        let intendedStatus: any;
        if (data.status !== undefined) intendedStatus = data.status;
        else if (whenMs !== null) intendedStatus = post.postStatus;
        else if (post.postStatus === 'future') intendedStatus = 'future';
        else intendedStatus = undefined;

        let effectiveStatus: string | undefined;
        let scheduledWhenMs: number | null = null;
        let cancelSchedule = false;
        if (intendedStatus !== undefined) {
            const evalWhen = whenMs !== null
                ? whenMs
                : scheduledPublish.parseDbDateMs(post.postDateGmt, true);
            effectiveStatus = scheduledPublish.resolveScheduledStatus(intendedStatus, evalWhen);
            if (effectiveStatus === 'future') {
                scheduledWhenMs = evalWhen;
            } else if (post.postStatus === 'future') {
                // Leaving 'future' (published now, or moved to draft/pending/trash) → drop the event.
                cancelSchedule = true;
            }
        }

        if (data.title !== undefined) {
            updates.push('post_title = ?');
            values.push(data.title);
        }

        if (data.content !== undefined) {
            updates.push('post_content = ?');
            values.push(sanitizeContent(data.content));
        }

        if (data.excerpt !== undefined) {
            updates.push('post_excerpt = ?');
            values.push(data.excerpt);
        }

        if (effectiveStatus !== undefined) {
            updates.push('post_status = ?');
            values.push(effectiveStatus);
        }

        if (data.slug !== undefined) {
            const uniqueSlug = await Post.generateUniqueSlug(sanitizeTitle(data.slug as string) as string, post.postType as string, id);
            updates.push('post_name = ?');
            values.push(uniqueSlug);
        }

        if (data.parent !== undefined) {
            updates.push('post_parent = ?');
            values.push(data.parent);
        }

        if (data.menuOrder !== undefined) {
            updates.push('menu_order = ?');
            values.push(data.menuOrder);
        }

        if (data.commentStatus !== undefined) {
            updates.push('comment_status = ?');
            values.push(data.commentStatus);
        }

        if (data.authorId !== undefined) {
            updates.push('author_id = ?');
            values.push(data.authorId);
        }

        // MULTILINGUAL: set or CLEAR the post's language. An explicit null/'' (or an unparseable tag)
        // clears it back to NULL; a valid tag is stored canonicalized. Absent key → column untouched.
        if (data.language !== undefined) {
            updates.push('post_language = ?');
            values.push(data.language != null && data.language !== '' ? parseLanguageTag(data.language) : null);
        }

        // Always update modified date
        updates.push('post_modified = ?', 'post_modified_gmt = ?');
        values.push(currentTime(), currentTimeGMT());

        // term_taxonomy.count materialises "how many PUBLISHED posts are attached to this term", so
        // every crossing of the publish/non-publish boundary changes it. Before, the ONLY writer was
        // setTerms(), which a status-only save never calls: "Move to trash" and "Publish" send
        // {status} with no `categories` key, so the number stayed frozen — a trashed post kept
        // inflating its category for ever, and a draft published without re-sending its terms stayed
        // at 0, which makes hide_empty HIDE a category that has content. Recount here so the
        // maintenance is a consequence of the TRANSITION instead of a side effect of the caller
        // happening to re-send the terms.
        const crossesPublishBoundary =
            effectiveStatus !== undefined && (effectiveStatus === 'publish') !== (post.postStatus === 'publish');

        if (updates.length > 0) {
            values.push(id);
            const sql = `UPDATE posts SET ${updates.join(', ')} WHERE id = ?`;
            if (crossesPublishBoundary && typeof dbAsync.transaction === 'function') {
                // The row write and the recount must not be observable apart — a reader in between
                // would see the new status with the old count. One transaction, the same shape
                // setTerms() already uses; the fallback keeps working on a driver without it.
                await dbAsync.transaction(async (q: any) => {
                    await q.run(sql, values);
                    await Post._recountTermsForPost(id, q);
                });
            } else {
                await dbAsync.run(sql, values);
                if (crossesPublishBoundary) await Post._recountTermsForPost(id, dbAsync);
            }
        }

        // (Re)arm or cancel the flip event now that the row reflects the target state.
        if (scheduledWhenMs !== null) {
            await scheduledPublish.scheduleFuturePublish(id, scheduledWhenMs);
        } else if (cancelSchedule) {
            await scheduledPublish.cancelFuturePublish(id);
        }

        // The ORPHAN-DATE MARK (see the stamping branch above). Written exactly when a scheduled post
        // is un-scheduled without a new date — the moment a future post_date stops being anybody's
        // intention — and cleared as soon as it stops being true: any explicit date is a fresh
        // statement of intent, and a publish that consumed the mark has no further use for it.
        if (explicitDate || stampedOrphanDate || effectiveStatus === 'future') {
            await Post.deleteMeta(id, UNSCHEDULED_DATE_META);
        } else if (post.postStatus === 'future' && effectiveStatus !== undefined && effectiveStatus !== 'future') {
            await Post.updateMeta(id, UNSCHEDULED_DATE_META, '1');
        }

        // Invalidate Cache
        await cache.del(`post:id:${id}`);
        if (post.postName) {
            await cache.del(`post:slug:${post.postType}:${post.postName}`);
            await cache.del(`post:slug:any:${post.postName}`);
        }
        if (data.slug) {
            await cache.del(`post:slug:${post.postType}:${data.slug}`);
            await cache.del(`post:slug:any:${data.slug}`);
        }

        // Durable semantic event. Pass the PRIOR status so listeners can detect a real transition
        // (draft→publish, →trash) rather than re-firing on every re-save.
        Post._invalidateCounts();
        recordContentEvent('post.updated', Number(id), {
            data,
            previousStatus: post.postStatus,
            previousType: post.postType,
            previousSlug: post.postName,
        });

        return await Post.findById(id);
    }

    // ---- MULTILINGUAL (opt-in) --------------------------------------------------
    //
    // A post carries an optional BCP-47 language tag and an optional translation_group uuid. Two posts
    // are translations of one another iff they share the same non-NULL group, so linking is symmetric
    // and idempotent by construction (both get the same group) and "translations of X" is a lookup by
    // that group. Nothing here runs for a monolingual post (group NULL → early return, zero queries).

    /**
     * Invalidate the id + slug caches for one post row. Shared by the linking writers so a translation
     * edit is visible on the very next public read (the same keys create()/update() clear).
     */
    static async _invalidatePostCacheById(id: any) {
        const row = await dbAsync.get('SELECT post_name, post_type FROM posts WHERE id = ?', [id]);
        await cache.del(`post:id:${id}`);
        if (row && row.post_name) {
            await cache.del(`post:slug:${row.post_type}:${row.post_name}`);
            await cache.del(`post:slug:any:${row.post_name}`);
        }
    }

    /**
     * Set (or clear) a post's content language. A valid tag is stored canonicalized; null/''/an
     * unparseable value clears it back to NULL. Returns the stored tag (or null). Idempotent.
     */
    static async setLanguage(id: any, language: any): Promise<string | null> {
        const tag = language != null && language !== '' ? parseLanguageTag(language) : null;
        await Post.update(id, { language: tag });
        return tag;
    }

    /**
     * List a post's translations in OTHER languages: the sibling posts sharing its translation_group,
     * each carrying a declared language. PUBLISHED-only by default (the public hreflang set must not
     * point at drafts); pass { includeUnpublished: true } for an admin/management view.
     *
     * `group` is an optimization for callers (toJSON) that already hold the group — pass it to skip the
     * lookup. Omit it (public API) and the group is resolved from the id. A post with no group → [].
     */
    static async getTranslations(
        id: any,
        group?: string | null,
        opts: { includeUnpublished?: boolean } = {}
    ): Promise<Array<{ id: number; language: string; slug: string; type: string; status: string }>> {
        let translationGroup: string | null | undefined = group;
        if (translationGroup === undefined) {
            const row = await dbAsync.get('SELECT translation_group FROM posts WHERE id = ?', [id]);
            translationGroup = row ? row.translation_group : null;
        }
        if (!translationGroup) return [];

        const statusClause = opts.includeUnpublished === true ? '' : " AND post_status = 'publish'";
        const rows = await dbAsync.all(
            `SELECT id, post_name, post_type, post_language, post_status FROM posts
             WHERE translation_group = ? AND id != ? AND post_language IS NOT NULL${statusClause}
             ORDER BY post_language`,
            [translationGroup, id]
        );
        return rows.map((r: any) => ({
            id: r.id,
            language: r.post_language,
            slug: r.post_name,
            type: r.post_type,
            status: r.post_status
        }));
    }

    /**
     * Link two posts as translations of each other. SYMMETRIC and IDEMPOTENT: both end up in one
     * translation_group. If either already belongs to a group, that group survives (A's wins) and the
     * other whole set is folded into it — merging sets, not just the two posts; if neither does, a new
     * uuid is minted. Returns the surviving group id, or null when a post id is invalid/equal.
     */
    static async linkTranslations(idA: any, idB: any): Promise<string | null> {
        if (!isContentMutationActive()) return await runContentMutation(() => Post.linkTranslations(idA, idB));
        const a2 = Number(idA);
        const b2 = Number(idB);
        if (!a2 || !b2 || a2 === b2) return null;
        const a = await dbAsync.get('SELECT translation_group FROM posts WHERE id = ?', [a2]);
        const b = await dbAsync.get('SELECT translation_group FROM posts WHERE id = ?', [b2]);
        if (!a || !b) return null;

        const groupA = a.translation_group || null;
        const groupB = b.translation_group || null;
        const target = groupA || groupB || randomUUID();

        // Existing groups (other than the survivor) whose every member must be re-pointed at `target`.
        const mergeGroups: string[] = [];
        if (groupA && groupA !== target) mergeGroups.push(groupA);
        if (groupB && groupB !== target) mergeGroups.push(groupB);

        // Every post id that will change, gathered BEFORE the write so we can clear their caches after.
        const affected = new Set<any>([a2, b2]);
        if (mergeGroups.length) {
            const ph = mergeGroups.map(() => '?').join(',');
            const members = await dbAsync.all(`SELECT id FROM posts WHERE translation_group IN (${ph})`, mergeGroups);
            for (const m of members) affected.add(m.id);
        }

        const affectedIds = [...affected];
        const affectedRows = affectedIds.length
            ? await dbAsync.all(
                `SELECT id, post_status, post_type, post_name FROM posts WHERE id IN (${affectedIds.map(() => '?').join(',')})`,
                affectedIds
            )
            : [];

        const writes = async (q: any) => {
            await q.run('UPDATE posts SET translation_group = ? WHERE id = ? OR id = ?', [target, a2, b2]);
            if (mergeGroups.length) {
                const ph = mergeGroups.map(() => '?').join(',');
                await q.run(`UPDATE posts SET translation_group = ? WHERE translation_group IN (${ph})`, [target, ...mergeGroups]);
            }
        };
        if (typeof dbAsync.transaction === 'function') await dbAsync.transaction(writes);
        else await writes(dbAsync);

        for (const pid of affected) await Post._invalidatePostCacheById(pid);
        for (const changed of affectedRows) {
            recordContentEvent('post.updated', Number(changed.id), {
                data: { translationGroup: target },
                previousStatus: changed.post_status,
                previousType: changed.post_type,
                previousSlug: changed.post_name,
            });
        }
        return target;
    }

    /**
     * Remove ONE post from its translation set (clears its group to NULL). The rest of the set stays
     * linked. Returns false for an unknown id. Idempotent (a post with no group stays NULL).
     */
    static async unlinkTranslation(id: any): Promise<boolean> {
        if (!isContentMutationActive()) return await runContentMutation(() => Post.unlinkTranslation(id));
        const pid = Number(id);
        const row = await dbAsync.get('SELECT id, post_status, post_type, post_name FROM posts WHERE id = ?', [pid]);
        if (!row) return false;
        await dbAsync.run('UPDATE posts SET translation_group = NULL WHERE id = ?', [pid]);
        await Post._invalidatePostCacheById(pid);
        recordContentEvent('post.updated', pid, {
            data: { translationGroup: null },
            previousStatus: row.post_status,
            previousType: row.post_type,
            previousSlug: row.post_name,
        });
        return true;
    }

    /**
     * Delete a post
     * Equivalent to wp_delete_post()
     */
    static async delete(id: any, forceDelete = false) {
        if (!isContentMutationActive()) return await runContentMutation(() => Post.delete(id, forceDelete));
        const post = await Post.findById(id);
        if (!post) return false;

        if (forceDelete) {
            const writes = async (q: any) => {
                // Read the term_taxonomy rows this post belongs to BEFORE its relationships are
                // deleted — afterwards nothing records which counters this delete invalidated, which
                // is exactly why the raw DELETE used to leave `count = 1` behind with zero
                // relationship rows.
                //
                // INSIDE the transaction, with the transaction's own connection `q`. It used to run
                // on the loose connection before BEGIN, so a relationship attached in between (a
                // concurrent setTerms, the importer) was deleted by this transaction while its
                // term_taxonomy_id was missing from the list being recounted — an inflated count, for
                // ever. Post.update already reads and recounts inside its own transaction; this is
                // the same rule, applied to its twin.
                const affectedTerms = await Post._termTaxonomiesForPost(id, q);

                // Delete meta
                await q.run('DELETE FROM post_meta WHERE post_id = ?', [id]);

                // Delete term relationships
                await q.run('DELETE FROM term_relationships WHERE object_id = ?', [id]);

                // Delete post
                const res = await q.run('DELETE FROM posts WHERE id = ?', [id]);

                // Recount AFTER the rows are gone, inside the same transaction, so no reader ever
                // sees the post deleted while its terms still claim it.
                await Post._recountTermTaxonomies(affectedTerms, q);
                return res;
            };

            // These three writes ran auto-committed and independently before: a failure between them
            // left orphan meta or relationships pointing at a post that no longer exists. One
            // transaction — the same helper setTerms()/linkTranslations() already use a few lines
            // away — makes the delete and its counter maintenance all-or-nothing.
            const result = typeof dbAsync.transaction === 'function'
                ? await dbAsync.transaction(writes)
                : await writes(dbAsync);

            // Invalidate Cache
            await cache.del(`post:id:${id}`);
            if (post.postName) {
                await cache.del(`post:slug:${post.postType}:${post.postName}`);
                await cache.del(`post:slug:any:${post.postName}`);
            }

            // Pass the prior status so a listener can avoid re-emitting "deleted" when the post was
            // already trashed (the trash transition already signaled it).
            Post._invalidateCounts();
            recordContentEvent('post.deleted', Number(id), {
                previousStatus: post.postStatus,
                previousType: post.postType,
                previousSlug: post.postName,
            });

            return result.changes > 0;
        } else {
            // Move to trash
            return await Post.update(id, { status: 'trash' });
        }
    }

    /**
     * Trash a post
     * Equivalent to wp_trash_post()
     */
    static async trash(id: any) {
        if (!isContentMutationActive()) return await runContentMutation(() => Post.trash(id));
        const post = await Post.findById(id);
        if (!post) return false;

        // Store original status in meta
        await Post.updateMeta(id, '_wp_trash_meta_status', post.postStatus);
        await Post.updateMeta(id, '_wp_trash_meta_time', Date.now());

        return await Post.update(id, { status: 'trash' });
    }

    /**
     * Restore a post from trash
     * Equivalent to wp_untrash_post()
     */
    static async untrash(id: any) {
        if (!isContentMutationActive()) return await runContentMutation(() => Post.untrash(id));
        const post = await Post.findById(id);
        if (!post || post.postStatus !== 'trash') return false;

        const originalStatus = (await Post.getMeta(id, '_wp_trash_meta_status')) || 'draft';

        // Delete trash meta
        await Post.deleteMeta(id, '_wp_trash_meta_status');
        await Post.deleteMeta(id, '_wp_trash_meta_time');

        return await Post.update(id, { status: originalStatus });
    }

    /**
     * Update post meta
     * Equivalent to update_post_meta()
     */
    static async updateMeta(postId: any, key: string, value: any) {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);

        // UPDATE first and INSERT only when it matched nothing: the common case (a key that already
        // exists — every re-save of a page's _puck_data) drops from SELECT+UPDATE to one statement.
        // Deliberately NOT an ON CONFLICT upsert: that needs a UNIQUE index on
        // (post_id, meta_key), which existing installs may not be able to create (legacy duplicate
        // rows) — adding one would need a dedupe migration first. This keeps today's semantics
        // exactly, including how duplicates behave (the UPDATE touches them all, as before).
        const res = await dbAsync.run('UPDATE post_meta SET meta_value = ? WHERE post_id = ? AND meta_key = ?', [serialized, postId, key]);
        const changed = res && (res.changes ?? res.rowCount ?? 0);
        if (!changed) {
            await dbAsync.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)', [postId, key, serialized]);
        }

        // Invalidate Post Cache because meta impacts toJSON/frontend view
        await cache.del(`post:id:${postId}`);
        // We don't necessarily know the slug here easily without fetch, but usually invalidating by ID is enough 
        // as findBySlug results will have the same ID. 
        // However, findBySlug cache stores the WHOLE post row. 
        // If we want total consistency, we'd need to fetch and invalidate slug too.
        const post = await dbAsync.get('SELECT post_name, post_type FROM posts WHERE id = ?', [postId]);
        if (post) {
            await cache.del(`post:slug:${post.post_type}:${post.post_name}`);
            await cache.del(`post:slug:any:${post.post_name}`);
        }
    }

    /**
     * Get post meta
     * Equivalent to get_post_meta()
     */
    static async getMeta(postId: any, key: string, single = true) {
        if (single) {
            const row = await dbAsync.get('SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = ? LIMIT 1', [postId, key]);
            if (!row) return null;
            try {
                return JSON.parse(row.meta_value);
            } catch {
                return row.meta_value;
            }
        } else {
            const rows = await dbAsync.all('SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = ?', [postId, key]);
            return rows.map((row: any) => {
                try {
                    return JSON.parse(row.meta_value);
                } catch {
                    return row.meta_value;
                }
            });
        }
    }

    /**
     * Delete post meta
     * Equivalent to delete_post_meta()
     */
    static async deleteMeta(postId: any, key: string) {
        const result = await dbAsync.run('DELETE FROM post_meta WHERE post_id = ? AND meta_key = ?', [postId, key]);
        const success = result.changes > 0;
        if (success) {
            await cache.del(`post:id:${postId}`);
            const post = await dbAsync.get('SELECT post_name, post_type FROM posts WHERE id = ?', [postId]);
            if (post) {
                await cache.del(`post:slug:${post.post_type}:${post.post_name}`);
                await cache.del(`post:slug:any:${post.post_name}`);
            }
        }
        return success;
    }

    /**
     * Get all meta for a post
     */
    static async getAllMeta(postId: any) {
        const rows = await dbAsync.all('SELECT meta_key, meta_value FROM post_meta WHERE post_id = ?', [postId]);

        const meta: Record<string, any> = {};
        for (const row of rows) {
            let value: any;
            try {
                value = JSON.parse(row.meta_value);
            } catch {
                value = row.meta_value;
            }
            defineMetaEntry(meta, row.meta_key, value);
        }
        return meta;
    }

    /**
     * Batch-load all meta for many post IDs in a single query.
     * Returns a map of postId -> { meta_key: parsedValue }, with an entry for
     * every requested id (empty object if the post has no meta). This produces
     * the exact same per-post shape as getAllMeta().
     */
    static async getAllMetaForIds(ids: any) {
        const result: Record<string, any> = {};
        if (!Array.isArray(ids) || ids.length === 0) return result;

        // De-duplicate and seed empty buckets so every id has an entry.
        const uniqueIds = [...new Set(ids)];
        for (const id of uniqueIds) result[id] = {};

        const placeholders = uniqueIds.map(() => '?').join(',');
        const rows = await dbAsync.all(
            `SELECT post_id, meta_key, meta_value FROM post_meta WHERE post_id IN (${placeholders})`,
            uniqueIds
        );

        for (const row of rows) {
            const bucket = result[row.post_id];
            if (!bucket) continue;
            let value: any;
            try {
                value = JSON.parse(row.meta_value);
            } catch {
                value = row.meta_value;
            }
            // Same reader rule as getAllMeta — this is the BATCH twin, and models/Media.ts reads its
            // `_wp_attached_file` out of exactly these buckets.
            defineMetaEntry(bucket, row.meta_key, value);
        }
        return result;
    }

    /**
     * Batch-load all meta for many post IDs, RAW — meta_value exactly as stored, never JSON.parse()d.
     *
     * getAllMeta()/getAllMetaForIds() parse each value for API consumers, which is lossy for a
     * byte-faithful export: JSON.parse -> JSON.stringify drops the original whitespace and turns a
     * stored `"changed"` into `changed`. The WXR exporter must ship the bytes the editor wrote
     * (_puck_data is the whole page tree), so it reads through here instead.
     *
     * Returns { [postId]: Array<{ key, value }> } with an entry for every requested id (empty array if
     * the post has no meta). Order within a post is the DB's row order for that post_id, which keeps a
     * re-export of a re-import stable. Chunked so a 10k-post export cannot blow the driver's bound-
     * parameter ceiling (SQLite/MySQL both cap it).
     */
    static async getAllMetaRawForIds(ids: any) {
        const result: Record<string, Array<{ key: string; value: string }>> = {};
        if (!Array.isArray(ids) || ids.length === 0) return result;

        const uniqueIds = [...new Set(ids)].filter((id) => id != null);
        for (const id of uniqueIds) result[id] = [];

        const CHUNK = 500;
        for (let i = 0; i < uniqueIds.length; i += CHUNK) {
            const chunk = uniqueIds.slice(i, i + CHUNK);
            const placeholders = chunk.map(() => '?').join(',');
            const rows = await dbAsync.all(
                `SELECT post_id, meta_key, meta_value FROM post_meta WHERE post_id IN (${placeholders}) ORDER BY meta_id ASC`,
                chunk
            );
            for (const row of rows) {
                const bucket = result[row.post_id];
                if (!bucket) continue;
                bucket.push({ key: row.meta_key, value: row.meta_value == null ? '' : String(row.meta_value) });
            }
        }
        return result;
    }

    /**
     * Pre-load relations (meta) for a list of Post instances so that a
     * subsequent toJSON() on each costs O(1) meta queries total instead of O(N).
     * Mutates each post's _metaCache. Behavior of toJSON() is unchanged; this
     * only swaps where the meta comes from. Returns the same array for chaining.
     */
    static async hydrateRelations(posts: any) {
        if (!Array.isArray(posts) || posts.length === 0) return posts;
        const ids = posts.map(p => p.id).filter(id => id != null);
        const metaById = await Post.getAllMetaForIds(ids);
        for (const post of posts) {
            post._metaCache = metaById[post.id] || {};
        }

        // Batch-hydrate featured images to eliminate the per-post N+1 in
        // getFeaturedImage()/toJSON() (Post.findById + _wp_attached_file lookup each).
        // Collect every distinct _thumbnail_id, fetch those attachment posts and
        // their _wp_attached_file in two IN-queries, then stash per-post.
        const thumbnailIds = [...new Set(
            posts
                .map(p => p._metaCache && p._metaCache['_thumbnail_id'])
                .filter(id => id != null && id !== '')
        )];

        if (thumbnailIds.length > 0) {
            const placeholders = thumbnailIds.map(() => '?').join(',');
            const attachmentRows = await dbAsync.all(
                `SELECT * FROM posts WHERE id IN (${placeholders})`,
                thumbnailIds
            );
            const attachmentById: Record<string, any> = {};
            for (const row of attachmentRows) {
                attachmentById[row.id] = new Post(row);
            }
            // One IN-query for the attached-file meta of all attachments.
            const attachmentMetaById = await Post.getAllMetaForIds(
                attachmentRows.map((row: any) => row.id)
            );

            for (const post of posts) {
                const thumbnailId = post._metaCache && post._metaCache['_thumbnail_id'];
                if (thumbnailId == null || thumbnailId === '') {
                    // No featured image: cache the resolved "none" so getFeaturedImage skips DB.
                    post._featuredImageCache = { post: null, attachedFile: null };
                    continue;
                }
                const attachment = attachmentById[thumbnailId] || null;
                const bucket = attachmentMetaById[thumbnailId] || {};
                post._featuredImageCache = {
                    post: attachment,
                    attachedFile: bucket['_wp_attached_file'] != null ? bucket['_wp_attached_file'] : null
                };
            }
        } else {
            // No posts have a thumbnail: mark all as resolved-none to avoid per-post queries.
            for (const post of posts) {
                post._featuredImageCache = { post: null, attachedFile: null };
            }
        }

        // Batch-hydrate the taxonomy terms toJSON() serializes, in ONE query for the whole page.
        // Same shape of contract as the two above: EVERY post ends with a defined bucket (empty when
        // it has no terms), so toJSON never falls back to a per-post query on a hydrated list.
        const termsById = await Post.getTermsForIds(ids);
        for (const post of posts) {
            post._termsCache = termsById[post.id] || Post.emptyTermsBucket();
        }

        // Batch-hydrate the AUTHOR toJSON() now serialises as an object. Same contract again: every
        // post leaves here with a DEFINED identity (the "resolved, no such user" value when the row is
        // gone), so a listing never falls back to the per-post users query.
        const authorsById = await Post.getAuthorsForIds(posts.map((p: any) => p.authorId));
        for (const post of posts) {
            post._authorCache = authorsById[post.authorId] || Post.unknownAuthor(post.authorId);
        }

        return posts;
    }

    /**
     * Like findAll(), but pre-loads meta in a single batched query so that
     * callers mapping toJSON() over the result avoid N+1 meta queries.
     * Output of each Post and its toJSON() is identical to findAll().
     */
    static async findAllWithRelations(options: any = {}) {
        const posts = await Post.findAll(options);
        return await Post.hydrateRelations(posts);
    }

    /**
     * Set post terms
     * Equivalent to wp_set_post_terms()
     */
    /**
     * Attach a post's terms for one taxonomy.
     *
     * Cost, before: 1 DELETE + THREE queries per term (resolve term_taxonomy_id, probe for an
     * existing relationship, insert) + a recount of EVERY term in the taxonomy. Saving a post with
     * 5 categories was ~17 statements, each its own fsync on the default SQLite install.
     *
     * Now: one IN() resolves every term_taxonomy_id, one IN() reads the relationships that already
     * exist, and the writes run inside ONE transaction (one fsync) — with the recount SCOPED to the
     * term_taxonomy rows this call actually touched instead of the whole taxonomy.
     */
    static async setTerms(postId: any, termIds: any, taxonomy: string, append = false) {
        const ids = (Array.isArray(termIds) ? termIds : []).filter((t: any) => t !== undefined && t !== null);

        // EVERY read this write depends on happens INSIDE the transaction, on its connection.
        //
        // They used to run on the loose connection first, which made the same window Post.delete had:
        // a relationship attached between "which counters does this call change?" and the DELETE below
        // was removed by the DELETE (it takes the whole taxonomy) while its term_taxonomy_id was
        // missing from the recount list — a count inflated for ever, the exact #16 symptom. The
        // resolve and the already-attached probe move with it for the same reason: a term deleted, or
        // a relationship inserted, in that window would otherwise produce a dangling row or a
        // duplicate.
        const writes = async (q: any) => {
            // Resolve every requested term in ONE query (was one per term).
            let rows: any[] = [];
            if (ids.length) {
                const ph = ids.map(() => '?').join(',');
                rows = await q.all(
                    `SELECT term_taxonomy_id, term_id FROM term_taxonomy WHERE taxonomy = ? AND term_id IN (${ph})`,
                    [taxonomy, ...ids]
                );
            }
            const ttIds: any[] = rows.map((r: any) => r.term_taxonomy_id);

            // Which relationships already exist (only matters when appending — a non-append call
            // deletes them first, so every insert below is new).
            let existing = new Set<any>();
            if (append && ttIds.length) {
                const ph = ttIds.map(() => '?').join(',');
                const have = await q.all(
                    `SELECT term_taxonomy_id FROM term_relationships WHERE object_id = ? AND term_taxonomy_id IN (${ph})`,
                    [postId, ...ttIds]
                );
                existing = new Set(have.map((r: any) => r.term_taxonomy_id));
            }

            // The rows whose count this call can change: the ones being attached, PLUS (on a replace)
            // whatever the post was in before — otherwise a term the post just LEFT keeps a stale count.
            const affected = new Set<any>(ttIds);
            if (!append) {
                const prev = await q.all(`
                    SELECT tr.term_taxonomy_id FROM term_relationships tr
                    JOIN term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
                    WHERE tr.object_id = ? AND tt.taxonomy = ?
                `, [postId, taxonomy]);
                for (const r of prev) affected.add(r.term_taxonomy_id);
            }

            if (!append) {
                await q.run(`
                    DELETE FROM term_relationships
                    WHERE object_id = ?
                    AND term_taxonomy_id IN (
                      SELECT term_taxonomy_id FROM term_taxonomy WHERE taxonomy = ?
                    )
                `, [postId, taxonomy]);
            }
            for (const ttId of ttIds) {
                if (existing.has(ttId)) continue;
                await q.run('INSERT INTO term_relationships (object_id, term_taxonomy_id, term_order) VALUES (?, ?, 0)', [postId, ttId]);
            }
            await Post.updateTermCounts(taxonomy, [...affected], q);
        };

        // One transaction ⇒ one fsync for the whole attachment. Drivers all implement transaction();
        // the fallback keeps working on any that doesn't (behaviour identical, just not atomic).
        if (typeof dbAsync.transaction === 'function') {
            await dbAsync.transaction(writes);
        } else {
            await writes(dbAsync);
        }
    }

    /**
     * The term_taxonomy rows one post is attached to, across EVERY taxonomy it participates in.
     *
     * A delete must call this BEFORE dropping the relationships (they are the only record of which
     * counters the delete invalidates); a status change can call it either side of the write, since
     * the relationships survive it.
     */
    static async _termTaxonomiesForPost(postId: any, q: any = dbAsync): Promise<Array<{ term_taxonomy_id: any; taxonomy: string }>> {
        return await q.all(`
            SELECT tr.term_taxonomy_id, tt.taxonomy
            FROM term_relationships tr
            JOIN term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
            WHERE tr.object_id = ?
        `, [postId]);
    }

    /**
     * Recompute the counters for an ALREADY-READ set of term_taxonomy rows — one scoped
     * updateTermCounts() per taxonomy, because the recount is keyed by (taxonomy, ids).
     * `q` lets the caller run it inside its own transaction.
     */
    static async _recountTermTaxonomies(rows: Array<{ term_taxonomy_id: any; taxonomy: string }>, q: any = dbAsync) {
        if (!rows || !rows.length) return;
        const byTaxonomy: Record<string, any[]> = {};
        for (const row of rows) {
            (byTaxonomy[row.taxonomy] = byTaxonomy[row.taxonomy] || []).push(row.term_taxonomy_id);
        }
        for (const [taxonomy, ttIds] of Object.entries(byTaxonomy)) {
            await Post.updateTermCounts(taxonomy, ttIds, q);
        }
    }

    /** Read + recount in one step, for writes whose relationships survive them (status changes). */
    static async _recountTermsForPost(postId: any, q: any = dbAsync) {
        await Post._recountTermTaxonomies(await Post._termTaxonomiesForPost(postId, q), q);
    }

    /**
     * Recompute term counts.
     *
     * `termTaxonomyIds` scopes the update to the rows a save actually touched — recounting an entire
     * taxonomy (the old unconditional behaviour) rescans every relationship of every term on a site
     * that may have thousands. Omit it to recount the whole taxonomy, which is what a bulk import or
     * a repair pass wants. `q` lets a caller run this inside its own transaction.
     */
    static async updateTermCounts(taxonomy: string, termTaxonomyIds?: any[], q: any = dbAsync) {
        const scoped = Array.isArray(termTaxonomyIds) && termTaxonomyIds.length;
        if (scoped) {
            await Post._lockTermTaxonomies(taxonomy, termTaxonomyIds!, q);
            const ph = termTaxonomyIds!.map(() => '?').join(',');
            await q.run(`
      UPDATE term_taxonomy
      SET count = (
        SELECT COUNT(*) FROM term_relationships tr
        JOIN posts p ON tr.object_id = p.id
        WHERE tr.term_taxonomy_id = term_taxonomy.term_taxonomy_id
        AND p.post_status = 'publish'
      )
      WHERE taxonomy = ? AND term_taxonomy_id IN (${ph})
    `, [taxonomy, ...termTaxonomyIds!]);
            return;
        }

        await Post._lockTermTaxonomies(taxonomy, null, q);
        await q.run(`
      UPDATE term_taxonomy
      SET count = (
        SELECT COUNT(*) FROM term_relationships tr
        JOIN posts p ON tr.object_id = p.id
        WHERE tr.term_taxonomy_id = term_taxonomy.term_taxonomy_id
        AND p.post_status = 'publish'
      )
      WHERE taxonomy = ?
    `, [taxonomy]);
    }

    /**
     * Take the row locks the derived recount needs, on the engines that have them.
     *
     * WHY (adversarial re-verify of #16). `SET count = (SELECT COUNT(*) …)` is correct only if the
     * subquery sees every committed transition. On PostgreSQL under READ COMMITTED — the default, and
     * the driver does not raise it — the SET subquery is evaluated against the snapshot the statement
     * took when it STARTED. Two concurrent publishes of two posts in the same category: the second
     * blocks on the row lock, and when it wakes EvalPlanQual re-checks the target row against the new
     * version but the subquery keeps its original snapshot, which does not contain the rival's
     * committed `post_status` change. The counter settles on 1 instead of 2 — permanently, because
     * nothing ever repairs it. Locking the row FIRST means the UPDATE statement (and therefore its
     * subquery) starts AFTER the rival committed, so the count it derives is the current one.
     *
     * SQLite needs nothing: every write is serialized (the async driver funnels transactions through
     * one promise chain and the engine itself takes a global write lock), which is also why the test
     * suite could never see this. It has no FOR UPDATE either, so asking for one there is a syntax
     * error, not a no-op — hence the engine check.
     *
     * ORDER BY term_taxonomy_id is not decoration: two transactions locking the same set in different
     * orders deadlock, and a stable order across every caller is what prevents it.
     *
     * Only meaningful inside a transaction (a bare autocommit SELECT releases the lock immediately),
     * which is how every writer of this column calls it; a caller without one is no worse off than
     * before.
     */
    static async _lockTermTaxonomies(taxonomy: string, termTaxonomyIds: any[] | null, q: any) {
        // A failure here (a deadlock the engine broke, a lost connection) is NOT swallowed: it must
        // roll the caller's transaction back so the write is retried, instead of being masked into a
        // recount that silently derives from a stale snapshot.
        const { isPostgres, isMySQL } = getDbType();
        if (!isPostgres && !isMySQL) return;
        if (termTaxonomyIds && termTaxonomyIds.length) {
            const ph = termTaxonomyIds.map(() => '?').join(',');
            await q.all(
                `SELECT term_taxonomy_id FROM term_taxonomy
                 WHERE taxonomy = ? AND term_taxonomy_id IN (${ph})
                 ORDER BY term_taxonomy_id FOR UPDATE`,
                [taxonomy, ...termTaxonomyIds]
            );
        } else {
            await q.all(
                `SELECT term_taxonomy_id FROM term_taxonomy WHERE taxonomy = ?
                 ORDER BY term_taxonomy_id FOR UPDATE`,
                [taxonomy]
            );
        }
    }
}

module.exports = Post;
