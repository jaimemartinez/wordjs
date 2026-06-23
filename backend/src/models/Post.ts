/**
 * WordJS - Post Model
 * Equivalent to wp-includes/class-wp-post.php and wp-includes/post.php
 */

const { db, dbAsync } = require('../config/database');
const { doAction, applyFilters } = require('../core/hooks');
const { doShortcode, doShortcodeAsync, stripShortcodes } = require('../core/shortcodes');
const { sanitizeTitle, sanitizeContent, generateExcerpt, currentTimeGMT, currentTime } = require('../core/formatting');
const config = require('../config/app');
const cache = require('../core/cache');
const { saveRevision } = require('../core/revisions');

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
    // Optional pre-loaded meta (set by hydrateRelations to avoid N+1 in toJSON).
    // When undefined, toJSON falls back to a per-post DB query (identical behavior).
    _metaCache?: { [key: string]: any };
    // Optional pre-loaded featured image (set by hydrateRelations to avoid the
    // per-post findById + _wp_attached_file lookups in getFeaturedImage()/toJSON()).
    // When undefined, those methods fall back to per-post queries (identical behavior).
    // Shape: { post: Post|null, attachedFile: string|null } — null `post` means
    // "resolved, no featured image".
    _featuredImageCache?: { post: any; attachedFile: any } | undefined;

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
        const meta = this._metaCache !== undefined ? this._metaCache : await Post.getAllMeta(this.id);

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
            mimeType = ''
        } = data;

        // Generate slug from title if not provided
        let postName = slug || sanitizeTitle(title);

        // Ensure unique slug
        postName = await Post.generateUniqueSlug(postName, type);

        // Sanitize content
        const sanitizedContent = sanitizeContent(content);

        const now = currentTime();
        const nowGmt = currentTimeGMT();

        // Generate GUID
        const guid = `${config.site.url}/?p=${Date.now()}`;

        // Postgres requires RETURNING id to get the inserted ID
        const result = await dbAsync.run(`
      INSERT INTO posts (
        author_id, post_date, post_date_gmt, post_content, post_title, post_excerpt,
        post_status, comment_status, ping_status, post_password, post_name,
        post_modified, post_modified_gmt, post_parent, guid, menu_order, post_type, post_mime_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [
            authorId || 0,
            now,
            nowGmt,
            sanitizedContent,
            title,
            excerpt,
            status,
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
            mimeType
        ]);

        const postId = result.lastID;

        // Update GUID with actual post ID
        await dbAsync.run('UPDATE posts SET guid = ? WHERE id = ?', [`${config.site.url}/?p=${postId}`, postId]);

        // Fire action hook
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
        if (cached) return new Post(cached);

        // 2. Database
        let sql = 'SELECT * FROM posts WHERE post_name = ?';
        const params = [slug];

        if (type && type !== 'any') {
            sql += ' AND post_type = ?';
            params.push(type);
        }

        const row = await dbAsync.get(sql, params);
        if (!row) return null;

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
            metaValue
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

        // Post status
        if (includeStatuses) {
            conditions.push(`${col}post_status IN (${includeStatuses.map(() => '?').join(',')})`);
            params.push(...includeStatuses);
        } else if (status) {
            if (Array.isArray(status)) {
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

        // Search
        if (search) {
            conditions.push(`(${col}post_title LIKE ? OR ${col}post_content LIKE ?)`);
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm);
        }

        return { joins, conditions, params };
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

        const { joins, conditions, params } = Post.buildWhere(options, 'p');

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
        sql += ` ORDER BY ${safeOrderBy} ${safeOrder}`;

        // Pagination
        // Use params for limit/offset
        sql += ' LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const rows = await dbAsync.all(sql, params);

        return rows.map((row: any) => new Post(row));
    }

    /**
     * Count posts
     * Equivalent to wp_count_posts()
     */
    static async count(options: any = {}) {
        // Reuse the exact same WHERE logic as findAll() so the two cannot drift.
        // Use bare columns (no alias) since this is a single-table COUNT(*).
        let sql = 'SELECT COUNT(*) as count FROM posts';

        const { conditions, params } = Post.buildWhere(options, '');

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }

        const row = await dbAsync.get(sql, params);
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

        if (data.status !== undefined) {
            updates.push('post_status = ?');
            values.push(data.status);
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

        // Always update modified date
        updates.push('post_modified = ?', 'post_modified_gmt = ?');
        values.push(currentTime(), currentTimeGMT());

        if (updates.length > 0) {
            values.push(id);
            await dbAsync.run(`UPDATE posts SET ${updates.join(', ')} WHERE id = ?`, values);
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

        // Fire action hook
        await doAction('post_updated', id, data);

        return await Post.findById(id);
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

            await doAction('deleted_post', id);

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

        const existing = await dbAsync.get('SELECT meta_id FROM post_meta WHERE post_id = ? AND meta_key = ?', [postId, key]);

        if (existing) {
            await dbAsync.run('UPDATE post_meta SET meta_value = ? WHERE post_id = ? AND meta_key = ?', [serialized, postId, key]);
        } else {
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
    static async setTerms(postId: any, termIds: any, taxonomy: string, append = false) {
        if (!append) {
            // Remove existing terms of this taxonomy
            await dbAsync.run(`
        DELETE FROM term_relationships 
        WHERE object_id = ? 
        AND term_taxonomy_id IN (
          SELECT term_taxonomy_id FROM term_taxonomy WHERE taxonomy = ?
        )
      `, [postId, taxonomy]);
        }

        // Add new terms
        for (const termId of termIds) {
            const tt = await dbAsync.get('SELECT term_taxonomy_id FROM term_taxonomy WHERE term_id = ? AND taxonomy = ?', [termId, taxonomy]);
            if (tt) {
                // INSERT OR IGNORE is SQLite specific. 
                // Postgres equivalent is INSERT ... ON CONFLICT DO NOTHING
                // To support both, we might check existence first or use generic syntax if adapter supports it?
                // Or Adapter handles parsing "INSERT OR IGNORE" to PG equivalent?
                // Our Postgres Driver heuristic was simple.

                // Let's rely on Driver normalization OR conditional logic.
                // Or simply: check existence.

                // Better approach: Check if exists to avoid ON CONFLICT complexity without driver support
                const exists = await dbAsync.get('SELECT 1 FROM term_relationships WHERE object_id = ? AND term_taxonomy_id = ?', [postId, tt.term_taxonomy_id]);
                if (!exists) {
                    await dbAsync.run('INSERT INTO term_relationships (object_id, term_taxonomy_id, term_order) VALUES (?, ?, 0)', [postId, tt.term_taxonomy_id]);
                }
            }
        }

        // Update term counts
        await Post.updateTermCounts(taxonomy);
    }

    /**
     * Update term counts
     */
    static async updateTermCounts(taxonomy: string) {
        // Complex subquery update
        // SQLite: UPDATE term_taxonomy SET count = (SELECT ...) WHERE taxonomy = ?
        // Postgres: UPDATE term_taxonomy SET count = (SELECT ...) WHERE taxonomy = $1
        // This standard SQL should work in both if logic is sound.

        await dbAsync.run(`
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
