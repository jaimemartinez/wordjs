/**
 * WordJS - Post Model
 * Equivalent to wp-includes/class-wp-post.php and wp-includes/post.php
 */

const { db, dbAsync } = require('../config/database');
const { doAction, applyFilters } = require('../core/hooks');
const { doShortcode, doShortcodeAsync, stripShortcodes } = require('../core/shortcodes');
const { sanitizeTitle, sanitizeContent, generateExcerpt, currentTimeGMT, currentTime, formatDate } = require('../core/formatting');
const config = require('../config/app');
const cache = require('../core/cache');
const { saveRevision } = require('../core/revisions');
const { randomUUID } = require('crypto');
// parseLanguageTag validates + canonicalizes a BCP-47 tag, returning null for anything that is not a
// language tag (a post's language must never silently become 'en' — null means "no language set").
const { parseLanguageTag } = require('../core/language-tag');

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
            author: this.authorId,
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

        // Generate slug from title if not provided
        let postName = slug || sanitizeTitle(title);

        // Ensure unique slug
        postName = await Post.generateUniqueSlug(postName, type);

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
        let effectiveStatus = status;
        let scheduledWhenMs: number | null = null;
        if (date !== undefined && date !== null && date !== '') {
            const d = new Date(date);
            if (!Number.isNaN(d.getTime())) {
                postDate = formatDate(d);
                postDateGmt = d.toISOString().slice(0, 19).replace('T', ' ');
                effectiveStatus = scheduledPublish.resolveScheduledStatus(status, d.getTime());
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
            commentStatus,
            pingStatus,
            password,
            postName,
            now,
            nowGmt,
            parent,
            guid,
            menuOrder,
            type,
            mimeType,
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
            await cache.del(`post:slug:${type}:${postName}`);
            await cache.del(`post:slug:any:${postName}`);
        }

        // Fire action hook
        Post._invalidateCounts();
        await doAction('wp_insert_post', postId, data);

        return await Post.findById(postId);
    }

    /**
     * Generate unique slug
     */
    static async generateUniqueSlug(slug: string, postType: string, excludeId: any = null) {
        let uniqueSlug = slug;
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
            uniqueSlug = `${slug}-${counter}`;
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
            mimeType
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

        // Author
        if (author) {
            conditions.push(`${col}author_id = ?`);
            params.push(author);
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
    static _invalidateCounts() { Post._countGen++; }

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
        const post = await Post.findById(id);
        if (!post) throw new Error('Post not found');

        const updates: string[] = [];
        const values: any[] = [];

        // Scheduled publishing (WordPress parity). Resolve the target date + status BEFORE building the
        // UPDATE so the row is written with the correct 'future'/'publish' state, then arm/cancel the
        // flip event AFTER the write. `scheduledWhenMs` is the moment to (re)arm for; `cancelSchedule`
        // marks a post leaving 'future' so its pending event is cleared (no orphan events).
        const scheduledPublish = require('../core/scheduled-publish');
        let whenMs: number | null = null;
        if (data.date !== undefined && data.date !== null && data.date !== '') {
            const d = new Date(data.date);
            if (!Number.isNaN(d.getTime())) {
                whenMs = d.getTime();
                updates.push('post_date = ?', 'post_date_gmt = ?');
                values.push(formatDate(d), d.toISOString().slice(0, 19).replace('T', ' '));
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

        if (updates.length > 0) {
            values.push(id);
            await dbAsync.run(`UPDATE posts SET ${updates.join(', ')} WHERE id = ?`, values);
        }

        // (Re)arm or cancel the flip event now that the row reflects the target state.
        if (scheduledWhenMs !== null) {
            await scheduledPublish.scheduleFuturePublish(id, scheduledWhenMs);
        } else if (cancelSchedule) {
            await scheduledPublish.cancelFuturePublish(id);
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

        // Fire action hook. Pass the PRIOR status (post was fetched pre-update) so listeners can detect a
        // real status transition (e.g. draft→publish, →trash) rather than re-firing on every re-save.
        Post._invalidateCounts();
        await doAction('post_updated', id, data, post.postStatus);

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
        return target;
    }

    /**
     * Remove ONE post from its translation set (clears its group to NULL). The rest of the set stays
     * linked. Returns false for an unknown id. Idempotent (a post with no group stays NULL).
     */
    static async unlinkTranslation(id: any): Promise<boolean> {
        const pid = Number(id);
        const row = await dbAsync.get('SELECT id FROM posts WHERE id = ?', [pid]);
        if (!row) return false;
        await dbAsync.run('UPDATE posts SET translation_group = NULL WHERE id = ?', [pid]);
        await Post._invalidatePostCacheById(pid);
        return true;
    }

    /**
     * Delete a post
     * Equivalent to wp_delete_post()
     */
    static async delete(id: any, forceDelete = false) {
        const post = await Post.findById(id);
        if (!post) return false;

        if (forceDelete) {
            // Delete meta
            await dbAsync.run('DELETE FROM post_meta WHERE post_id = ?', [id]);

            // Delete term relationships
            await dbAsync.run('DELETE FROM term_relationships WHERE object_id = ?', [id]);

            // Delete post
            const result = await dbAsync.run('DELETE FROM posts WHERE id = ?', [id]);

            // Invalidate Cache
            await cache.del(`post:id:${id}`);
            if (post.postName) {
                await cache.del(`post:slug:${post.postType}:${post.postName}`);
                await cache.del(`post:slug:any:${post.postName}`);
            }

            // Pass the prior status so a listener can avoid re-emitting "deleted" when the post was
            // already trashed (the trash transition already signaled it).
            Post._invalidateCounts();
            await doAction('deleted_post', id, post.postStatus);

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
            try {
                meta[row.meta_key] = JSON.parse(row.meta_value);
            } catch {
                meta[row.meta_key] = row.meta_value;
            }
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
            try {
                bucket[row.meta_key] = JSON.parse(row.meta_value);
            } catch {
                bucket[row.meta_key] = row.meta_value;
            }
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

        // Resolve every requested term in ONE query (was one per term).
        let rows: any[] = [];
        if (ids.length) {
            const ph = ids.map(() => '?').join(',');
            rows = await dbAsync.all(
                `SELECT term_taxonomy_id, term_id FROM term_taxonomy WHERE taxonomy = ? AND term_id IN (${ph})`,
                [taxonomy, ...ids]
            );
        }
        const ttIds: any[] = rows.map((r: any) => r.term_taxonomy_id);

        // Which relationships already exist (only matters when appending — a non-append call deletes
        // them first, so every insert below is new).
        let existing = new Set<any>();
        if (append && ttIds.length) {
            const ph = ttIds.map(() => '?').join(',');
            const have = await dbAsync.all(
                `SELECT term_taxonomy_id FROM term_relationships WHERE object_id = ? AND term_taxonomy_id IN (${ph})`,
                [postId, ...ttIds]
            );
            existing = new Set(have.map((r: any) => r.term_taxonomy_id));
        }

        // The rows whose count this call can change: the ones being attached, PLUS (on a replace)
        // whatever the post was in before — otherwise a term the post just LEFT keeps a stale count.
        const affected = new Set<any>(ttIds);
        if (!append) {
            const prev = await dbAsync.all(`
                SELECT tr.term_taxonomy_id FROM term_relationships tr
                JOIN term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
                WHERE tr.object_id = ? AND tt.taxonomy = ?
            `, [postId, taxonomy]);
            for (const r of prev) affected.add(r.term_taxonomy_id);
        }

        const writes = async (q: any) => {
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
}

module.exports = Post;
