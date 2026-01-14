/**
 * WordJS - Post Model
 * Equivalent to wp-includes/class-wp-post.php and wp-includes/post.php
 */

const { db } = require('../config/database');
const { doAction, applyFilters } = require('../core/hooks');
const { doShortcode, stripShortcodes } = require('../core/shortcodes');
const { sanitizeTitle, sanitizeContent, generateExcerpt, currentTimeGMT, currentTime } = require('../core/formatting');
const config = require('../config/app');

class Post {
    constructor(data) {
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
    }

    /**
     * Get post meta
     * Equivalent to get_post_meta()
     */
    getMeta(key, single = true) {
        return Post.getMeta(this.id, key, single);
    }

    /**
     * Get post terms
     */
    getTerms(taxonomy) {
        const stmt = db.prepare(`
      SELECT t.*, tt.taxonomy, tt.description, tt.parent, tt.count
      FROM terms t
      JOIN term_taxonomy tt ON t.term_id = tt.term_id
      JOIN term_relationships tr ON tt.term_taxonomy_id = tr.term_taxonomy_id
      WHERE tr.object_id = ? AND tt.taxonomy = ?
    `);
        return stmt.all(this.id, taxonomy);
    }

    /**
     * Get categories
     */
    getCategories() {
        return this.getTerms('category');
    }

    /**
     * Get tags
     */
    getTags() {
        return this.getTerms('post_tag');
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
    getAuthor() {
        const User = require('./User');
        return User.findById(this.authorId);
    }

    /**
     * Get featured image
     */
    getFeaturedImage() {
        const thumbnailId = this.getMeta('_thumbnail_id');
        if (!thumbnailId) return null;
        return Post.findById(thumbnailId);
    }

    /**
     * Convert to JSON (for API responses)
     */
    toJSON(includeContent = true) {
        const json = {
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
            mimeType: this.postMimeType,
            meta: Post.getAllMeta(this.id)
        };

        if (includeContent) {
            json.content = doShortcode(this.postContent);
        }

        // Add featured image
        const featuredImage = this.getFeaturedImage();
        if (featuredImage) {
            json.featuredMedia = {
                id: featuredImage.id,
                url: featuredImage.guid,
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
    static async create(data) {
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

        const stmt = db.prepare(`
      INSERT INTO posts (
        author_id, post_date, post_date_gmt, post_content, post_title, post_excerpt,
        post_status, comment_status, ping_status, post_password, post_name,
        post_modified, post_modified_gmt, post_parent, guid, menu_order, post_type, post_mime_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

        const result = stmt.run(
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
        );

        const postId = result.lastInsertRowid;

        // Update GUID with actual post ID
        db.prepare('UPDATE posts SET guid = ? WHERE id = ?').run(`${config.site.url}/?p=${postId}`, postId);

        // Fire action hook
        await doAction('wp_insert_post', postId, data);

        return Post.findById(postId);
    }

    /**
     * Generate unique slug
     */
    static async generateUniqueSlug(slug, postType, excludeId = null) {
        let uniqueSlug = slug;
        let counter = 1;

        while (true) {
            let query = 'SELECT id FROM posts WHERE post_name = ? AND post_type = ?';
            const params = [uniqueSlug, postType];

            if (excludeId) {
                query += ' AND id != ?';
                params.push(excludeId);
            }

            const existing = db.prepare(query).get(...params);
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
    static findById(id) {
        const stmt = db.prepare('SELECT * FROM posts WHERE id = ?');
        const row = stmt.get(id);
        return row ? new Post(row) : null;
    }

    /**
     * Find post by slug
     * Equivalent to get_page_by_path()
     */
    static findBySlug(slug, type = 'post') {
        const stmt = db.prepare('SELECT * FROM posts WHERE post_name = ? AND post_type = ?');
        const row = stmt.get(slug, type);
        return row ? new Post(row) : null;
    }

    /**
     * Query posts
     * Equivalent to WP_Query
     */
    static findAll(options = {}) {
        const {
            type = 'post',
            status = 'publish',
            author,
            search,
            parent,
            limit = 10,
            offset = 0,
            orderBy = 'post_date',
            order = 'DESC',
            includeStatuses = null,
            metaKey,
            metaValue
        } = options;

        let sql = 'SELECT p.* FROM posts p';
        const conditions = [];
        const params = [];

        // Meta query join
        if (metaKey) {
            sql += ' JOIN post_meta pm ON p.id = pm.post_id';
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
                conditions.push(`p.post_type IN (${type.map(() => '?').join(',')})`);
                params.push(...type);
            } else {
                conditions.push('p.post_type = ?');
                params.push(type);
            }
        }

        // Post status
        if (includeStatuses) {
            conditions.push(`p.post_status IN (${includeStatuses.map(() => '?').join(',')})`);
            params.push(...includeStatuses);
        } else if (status) {
            if (Array.isArray(status)) {
                conditions.push(`p.post_status IN (${status.map(() => '?').join(',')})`);
                params.push(...status);
            } else {
                conditions.push('p.post_status = ?');
                params.push(status);
            }
        }

        // Author
        if (author) {
            conditions.push('p.author_id = ?');
            params.push(author);
        }

        // Parent
        if (parent !== undefined) {
            conditions.push('p.post_parent = ?');
            params.push(parent);
        }

        // Search
        if (search) {
            conditions.push('(p.post_title LIKE ? OR p.post_content LIKE ?)');
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }

        // Order
        const allowedOrderBy = ['id', 'post_date', 'post_title', 'post_modified', 'menu_order', 'comment_count'];
        const safeOrderBy = allowedOrderBy.includes(orderBy) ? `p.${orderBy}` : 'p.post_date';
        const safeOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        sql += ` ORDER BY ${safeOrderBy} ${safeOrder}`;

        // Pagination
        sql += ' LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const stmt = db.prepare(sql);
        const rows = stmt.all(...params);

        return rows.map(row => new Post(row));
    }

    /**
     * Count posts
     * Equivalent to wp_count_posts()
     */
    static count(options = {}) {
        const { type = 'post', status, author, search } = options;

        let sql = 'SELECT COUNT(*) as count FROM posts';
        const conditions = [];
        const params = [];

        if (type) {
            conditions.push('post_type = ?');
            params.push(type);
        }

        if (status) {
            conditions.push('post_status = ?');
            params.push(status);
        }

        if (author) {
            conditions.push('author_id = ?');
            params.push(author);
        }

        if (search) {
            conditions.push('(post_title LIKE ? OR post_content LIKE ?)');
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }

        const stmt = db.prepare(sql);
        const row = stmt.get(...params);
        return row.count;
    }

    /**
     * Update a post
     * Equivalent to wp_update_post()
     */
    static async update(id, data) {
        const post = Post.findById(id);
        if (!post) throw new Error('Post not found');

        const updates = [];
        const values = [];

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
            const uniqueSlug = await Post.generateUniqueSlug(sanitizeTitle(data.slug), post.postType, id);
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
            const stmt = db.prepare(`UPDATE posts SET ${updates.join(', ')} WHERE id = ?`);
            stmt.run(...values);
        }

        // Fire action hook
        await doAction('post_updated', id, data);

        return Post.findById(id);
    }

    /**
     * Delete a post
     * Equivalent to wp_delete_post()
     */
    static async delete(id, forceDelete = false) {
        const post = Post.findById(id);
        if (!post) return false;

        if (forceDelete) {
            // Delete meta
            db.prepare('DELETE FROM post_meta WHERE post_id = ?').run(id);

            // Delete term relationships
            db.prepare('DELETE FROM term_relationships WHERE object_id = ?').run(id);

            // Delete post
            const result = db.prepare('DELETE FROM posts WHERE id = ?').run(id);

            await doAction('deleted_post', id);

            return result.changes > 0;
        } else {
            // Move to trash
            return Post.update(id, { status: 'trash' });
        }
    }

    /**
     * Trash a post
     * Equivalent to wp_trash_post()
     */
    static async trash(id) {
        const post = Post.findById(id);
        if (!post) return false;

        // Store original status in meta
        Post.updateMeta(id, '_wp_trash_meta_status', post.postStatus);
        Post.updateMeta(id, '_wp_trash_meta_time', Date.now());

        return Post.update(id, { status: 'trash' });
    }

    /**
     * Restore a post from trash
     * Equivalent to wp_untrash_post()
     */
    static async untrash(id) {
        const post = Post.findById(id);
        if (!post || post.postStatus !== 'trash') return false;

        const originalStatus = Post.getMeta(id, '_wp_trash_meta_status') || 'draft';

        // Delete trash meta
        Post.deleteMeta(id, '_wp_trash_meta_status');
        Post.deleteMeta(id, '_wp_trash_meta_time');

        return Post.update(id, { status: originalStatus });
    }

    /**
     * Update post meta
     * Equivalent to update_post_meta()
     */
    static updateMeta(postId, key, value) {
        const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);

        const existing = db.prepare('SELECT meta_id FROM post_meta WHERE post_id = ? AND meta_key = ?').get(postId, key);

        if (existing) {
            db.prepare('UPDATE post_meta SET meta_value = ? WHERE post_id = ? AND meta_key = ?').run(serialized, postId, key);
        } else {
            db.prepare('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)').run(postId, key, serialized);
        }
    }

    /**
     * Get post meta
     * Equivalent to get_post_meta()
     */
    static getMeta(postId, key, single = true) {
        if (single) {
            const stmt = db.prepare('SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = ? LIMIT 1');
            const row = stmt.get(postId, key);
            if (!row) return null;
            try {
                return JSON.parse(row.meta_value);
            } catch {
                return row.meta_value;
            }
        } else {
            const stmt = db.prepare('SELECT meta_value FROM post_meta WHERE post_id = ? AND meta_key = ?');
            return stmt.all(postId, key).map(row => {
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
    static deleteMeta(postId, key) {
        const result = db.prepare('DELETE FROM post_meta WHERE post_id = ? AND meta_key = ?').run(postId, key);
        return result.changes > 0;
    }

    /**
     * Get all meta for a post
     */
    static getAllMeta(postId) {
        const stmt = db.prepare('SELECT meta_key, meta_value FROM post_meta WHERE post_id = ?');
        const rows = stmt.all(postId);

        const meta = {};
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
     * Set post terms
     * Equivalent to wp_set_post_terms()
     */
    static setTerms(postId, termIds, taxonomy, append = false) {
        if (!append) {
            // Remove existing terms of this taxonomy
            db.prepare(`
        DELETE FROM term_relationships 
        WHERE object_id = ? 
        AND term_taxonomy_id IN (
          SELECT term_taxonomy_id FROM term_taxonomy WHERE taxonomy = ?
        )
      `).run(postId, taxonomy);
        }

        // Add new terms
        for (const termId of termIds) {
            const tt = db.prepare('SELECT term_taxonomy_id FROM term_taxonomy WHERE term_id = ? AND taxonomy = ?').get(termId, taxonomy);
            if (tt) {
                db.prepare('INSERT OR IGNORE INTO term_relationships (object_id, term_taxonomy_id) VALUES (?, ?)').run(postId, tt.term_taxonomy_id);
            }
        }

        // Update term counts
        Post.updateTermCounts(taxonomy);
    }

    /**
     * Update term counts
     */
    static updateTermCounts(taxonomy) {
        db.prepare(`
      UPDATE term_taxonomy 
      SET count = (
        SELECT COUNT(*) FROM term_relationships tr
        JOIN posts p ON tr.object_id = p.id
        WHERE tr.term_taxonomy_id = term_taxonomy.term_taxonomy_id
        AND p.post_status = 'publish'
      )
      WHERE taxonomy = ?
    `).run(taxonomy);
    }
}

module.exports = Post;
