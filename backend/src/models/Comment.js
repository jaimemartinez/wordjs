/**
 * WordJS - Comment Model
 * Equivalent to wp-includes/class-wp-comment.php and wp-includes/comment.php
 */

const { db, dbAsync } = require('../config/database');
const { sanitizeContent, currentTimeGMT, currentTime } = require('../core/formatting');
const { doAction } = require('../core/hooks');

class Comment {
    constructor(data) {
        this.commentId = data.comment_id;
        this.commentPostId = data.comment_post_id;
        this.commentAuthor = data.comment_author;
        this.commentAuthorEmail = data.comment_author_email;
        this.commentAuthorUrl = data.comment_author_url;
        this.commentAuthorIp = data.comment_author_ip;
        this.commentDate = data.comment_date;
        this.commentDateGmt = data.comment_date_gmt;
        this.commentContent = data.comment_content;
        this.commentKarma = data.comment_karma;
        this.commentApproved = data.comment_approved;
        this.commentAgent = data.comment_agent;
        this.commentType = data.comment_type;
        this.commentParent = data.comment_parent;
        this.userId = data.user_id;
    }

    /**
     * Get comment status as string
     */
    getStatus() {
        switch (this.commentApproved) {
            case '1': return 'approved';
            case '0': return 'pending';
            case 'spam': return 'spam';
            case 'trash': return 'trash';
            default: return 'pending';
        }
    }

    /**
     * Get comment author user (if logged in)
     */
    async getAuthorUser() {
        if (!this.userId) return null;
        const User = require('./User');
        return await User.findById(this.userId);
    }

    /**
     * Get parent comment
     */
    async getParent() {
        if (!this.commentParent) return null;
        return await Comment.findById(this.commentParent);
    }

    /**
     * Get replies
     */
    async getReplies() {
        return await Comment.findAll({ parent: this.commentId });
    }

    /**
     * Convert to JSON
     */
    toJSON() {
        return {
            id: this.commentId,
            postId: this.commentPostId,
            author: this.commentAuthor,
            authorEmail: this.commentAuthorEmail,
            authorUrl: this.commentAuthorUrl,
            authorIp: this.commentAuthorIp,
            date: this.commentDate,
            dateGmt: this.commentDateGmt,
            content: this.commentContent,
            status: this.getStatus(),
            type: this.commentType,
            parent: this.commentParent,
            userId: this.userId,
            authorAvatarUrl: this.getAvatarUrl()
        };
    }

    /**
     * Get avatar URL
     */
    getAvatarUrl(size = 48) {
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(this.commentAuthorEmail.toLowerCase().trim()).digest('hex');
        return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=mm`;
    }

    // Static methods

    /**
     * Create a new comment
     * Equivalent to wp_insert_comment()
     */
    static async create(data) {
        const {
            postId,
            author,
            authorEmail,
            authorUrl = '',
            authorIp = '',
            content,
            status = '0', // pending
            type = 'comment',
            parent = 0,
            userId = 0,
            agent = ''
        } = data;

        if (!postId || !author || !authorEmail || !content) {
            throw new Error('Post ID, author, email, and content are required');
        }

        // Sanitize content
        const sanitizedContent = sanitizeContent(content);

        const now = currentTime();
        const nowGmt = currentTimeGMT();

        const result = await dbAsync.run(`
      INSERT INTO comments (
        comment_post_id, comment_author, comment_author_email, comment_author_url,
        comment_author_ip, comment_date, comment_date_gmt, comment_content,
        comment_karma, comment_approved, comment_agent, comment_type, comment_parent, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?) RETURNING comment_id
    `, [
            postId,
            author,
            authorEmail,
            authorUrl,
            authorIp,
            now,
            nowGmt,
            sanitizedContent,
            status,
            agent,
            type,
            parent,
            userId
        ]);

        const commentId = result.lastID;

        // Update post comment count
        await Comment.updatePostCommentCount(postId);

        // Fire action hook
        await doAction('wp_insert_comment', commentId, data);

        return await Comment.findById(commentId);
    }

    /**
     * Find comment by ID
     * Equivalent to get_comment()
     */
    static async findById(id) {
        const row = await dbAsync.get('SELECT * FROM comments WHERE comment_id = ?', [id]);
        return row ? new Comment(row) : null;
    }

    /**
     * Get all comments
     * Equivalent to get_comments()
     */
    static async findAll(options = {}) {
        const {
            postId,
            status,
            parent,
            userId,
            type = 'comment',
            search,
            limit = 20,
            offset = 0,
            orderBy = 'comment_date',
            order = 'DESC'
        } = options;

        let sql = 'SELECT * FROM comments';
        const conditions = [];
        const params = [];

        if (postId) {
            conditions.push('comment_post_id = ?');
            params.push(postId);
        }

        if (status !== undefined) {
            conditions.push('comment_approved = ?');
            params.push(status);
        }

        if (parent !== undefined) {
            conditions.push('comment_parent = ?');
            params.push(parent);
        }

        if (userId) {
            conditions.push('user_id = ?');
            params.push(userId);
        }

        if (type) {
            conditions.push('comment_type = ?');
            params.push(type);
        }

        if (search) {
            conditions.push('(comment_author LIKE ? OR comment_content LIKE ? OR comment_author_email LIKE ?)');
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm, searchTerm);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }

        const allowedOrderBy = ['comment_id', 'comment_date', 'comment_author', 'comment_post_id'];
        const safeOrderBy = allowedOrderBy.includes(orderBy) ? orderBy : 'comment_date';
        const safeOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        sql += ` ORDER BY ${safeOrderBy} ${safeOrder}`;

        sql += ' LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const rows = await dbAsync.all(sql, params);
        return rows.map(row => new Comment(row));
    }

    /**
     * Count comments
     */
    static async count(options = {}) {
        const { postId, status, type = 'comment' } = options;

        let sql = 'SELECT COUNT(*) as count FROM comments';
        const conditions = [];
        const params = [];

        if (postId) {
            conditions.push('comment_post_id = ?');
            params.push(postId);
        }

        if (status !== undefined) {
            conditions.push('comment_approved = ?');
            params.push(status);
        }

        if (type) {
            conditions.push('comment_type = ?');
            params.push(type);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }

        const row = await dbAsync.get(sql, params);
        return row.count;
    }

    /**
     * Get comment counts by status
     * Equivalent to wp_count_comments()
     */
    static async getCounts(postId = null) {
        let baseWhere = postId ? 'WHERE comment_post_id = ?' : '';
        const params = postId ? [postId] : [];

        const counts = {
            total: 0,
            approved: 0,
            pending: 0,
            spam: 0,
            trash: 0
        };

        const rows = await dbAsync.all(`
      SELECT comment_approved, COUNT(*) as count 
      FROM comments 
      ${baseWhere}
      GROUP BY comment_approved
    `, params);

        for (const row of rows) {
            switch (row.comment_approved) {
                case '1':
                    counts.approved = row.count;
                    break;
                case '0':
                    counts.pending = row.count;
                    break;
                case 'spam':
                    counts.spam = row.count;
                    break;
                case 'trash':
                    counts.trash = row.count;
                    break;
            }
            if (row.comment_approved !== 'trash' && row.comment_approved !== 'spam') {
                counts.total += row.count;
            }
        }

        return counts;
    }

    /**
     * Update a comment
     * Equivalent to wp_update_comment()
     */
    static async update(id, data) {
        const comment = await Comment.findById(id);
        if (!comment) throw new Error('Comment not found');

        const updates = [];
        const values = [];

        if (data.author !== undefined) {
            updates.push('comment_author = ?');
            values.push(data.author);
        }

        if (data.authorEmail !== undefined) {
            updates.push('comment_author_email = ?');
            values.push(data.authorEmail);
        }

        if (data.authorUrl !== undefined) {
            updates.push('comment_author_url = ?');
            values.push(data.authorUrl);
        }

        if (data.content !== undefined) {
            updates.push('comment_content = ?');
            values.push(sanitizeContent(data.content));
        }

        if (data.status !== undefined) {
            updates.push('comment_approved = ?');
            values.push(data.status);
        }

        if (updates.length > 0) {
            values.push(id);
            await dbAsync.run(`UPDATE comments SET ${updates.join(', ')} WHERE comment_id = ?`, values);
        }

        // Update post comment count if status changed
        if (data.status !== undefined) {
            await Comment.updatePostCommentCount(comment.commentPostId);
        }

        return await Comment.findById(id);
    }

    /**
     * Delete a comment
     * Equivalent to wp_delete_comment()
     */
    static async delete(id, forceDelete = false) {
        const comment = await Comment.findById(id);
        if (!comment) return false;

        if (forceDelete) {
            // Delete comment meta
            await dbAsync.run('DELETE FROM comment_meta WHERE comment_id = ?', [id]);

            // Delete comment
            await dbAsync.run('DELETE FROM comments WHERE comment_id = ?', [id]);

            // Update post comment count
            await Comment.updatePostCommentCount(comment.commentPostId);

            await doAction('deleted_comment', id);

            return true;
        } else {
            // Move to trash
            return await Comment.update(id, { status: 'trash' });
        }
    }

    /**
     * Approve a comment
     */
    static async approve(id) {
        return await Comment.update(id, { status: '1' });
    }

    /**
     * Unapprove a comment (set to pending)
     */
    static async unapprove(id) {
        return await Comment.update(id, { status: '0' });
    }

    /**
     * Mark as spam
     */
    static async spam(id) {
        return await Comment.update(id, { status: 'spam' });
    }

    /**
     * Update post comment count
     */
    static async updatePostCommentCount(postId) {
        const row = await dbAsync.get(`
      SELECT COUNT(*) as count FROM comments 
      WHERE comment_post_id = ? AND comment_approved = '1'
    `, [postId]);

        await dbAsync.run('UPDATE posts SET comment_count = ? WHERE id = ?', [row.count, postId]);
    }

    /**
     * Get comment thread (comment with all replies)
     */
    static async getThread(commentId) {
        const comment = await Comment.findById(commentId);
        if (!comment) return null;

        const replies = await Comment.findAll({ parent: commentId });

        // Recursive fetch
        const repliesWithChildren = await Promise.all(replies.map(async reply => {
            // Note: inefficient recursion for deep threads, but simple for now
            // To do: simpler recursion logic or just level 2?
            // This replicates original logic but async
            const children = await Comment.findAll({ parent: reply.commentId });
            return {
                ...reply.toJSON(),
                replies: children.map(c => c.toJSON()) // Only one level deep in original code?
                // Original: replies: Comment.findAll({ parent: commentId }).map(reply => ({
                //    ...reply.toJSON(),
                //    replies: Comment.findAll({ parent: reply.commentId }).map(r => r.toJSON())
                // }))
                // Yes, only 2 levels.
            };
        }));

        return {
            ...comment.toJSON(),
            replies: repliesWithChildren
        };
    }
}

module.exports = Comment;
