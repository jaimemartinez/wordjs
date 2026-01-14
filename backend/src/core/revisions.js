/**
 * WordJS - Post Revisions
 * Equivalent to wp-includes/revision.php
 */

const { db } = require('../config/database');

/**
 * Save a revision of a post
 * Equivalent to wp_save_post_revision()
 */
function saveRevision(postId) {
    // Get current post data
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
    if (!post) return null;

    // Don't save revisions of revisions
    if (post.post_type === 'revision') return null;

    // Create revision
    const result = db.prepare(`
    INSERT INTO posts (
      author_id, post_date, post_date_gmt, post_content, post_title,
      post_excerpt, post_status, post_name, post_modified, post_modified_gmt,
      post_parent, post_type, post_mime_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'revision', '')
  `).run(
        post.author_id,
        post.post_date,
        post.post_date_gmt,
        post.post_content,
        post.post_title,
        post.post_excerpt,
        'inherit',
        `${postId}-revision-v${Date.now()}`,
        post.post_modified,
        post.post_modified_gmt,
        postId
    );

    return result.lastInsertRowid;
}

/**
 * Get revisions for a post
 * Equivalent to wp_get_post_revisions()
 */
function getRevisions(postId, options = {}) {
    const { limit = 10, offset = 0 } = options;

    const rows = db.prepare(`
    SELECT * FROM posts
    WHERE post_parent = ? AND post_type = 'revision'
    ORDER BY post_modified DESC
    LIMIT ? OFFSET ?
  `).all(postId, limit, offset);

    return rows.map(row => ({
        id: row.id,
        postId: row.post_parent,
        authorId: row.author_id,
        title: row.post_title,
        content: row.post_content,
        excerpt: row.post_excerpt,
        date: row.post_date,
        modified: row.post_modified
    }));
}

/**
 * Get a specific revision
 */
function getRevision(revisionId) {
    const row = db.prepare(`
    SELECT * FROM posts WHERE id = ? AND post_type = 'revision'
  `).get(revisionId);

    if (!row) return null;

    return {
        id: row.id,
        postId: row.post_parent,
        authorId: row.author_id,
        title: row.post_title,
        content: row.post_content,
        excerpt: row.post_excerpt,
        date: row.post_date,
        modified: row.post_modified
    };
}

/**
 * Restore a revision
 * Equivalent to wp_restore_post_revision()
 */
function restoreRevision(revisionId) {
    const revision = getRevision(revisionId);
    if (!revision) return false;

    // Save current state as a new revision first
    saveRevision(revision.postId);

    // Restore the revision content
    db.prepare(`
    UPDATE posts SET
      post_title = ?,
      post_content = ?,
      post_excerpt = ?,
      post_modified = CURRENT_TIMESTAMP,
      post_modified_gmt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(revision.title, revision.content, revision.excerpt, revision.postId);

    return true;
}

/**
 * Delete a revision
 */
function deleteRevision(revisionId) {
    const result = db.prepare(`
    DELETE FROM posts WHERE id = ? AND post_type = 'revision'
  `).run(revisionId);

    return result.changes > 0;
}

/**
 * Delete all revisions for a post
 */
function deleteAllRevisions(postId) {
    const result = db.prepare(`
    DELETE FROM posts WHERE post_parent = ? AND post_type = 'revision'
  `).run(postId);

    return result.changes;
}

/**
 * Count revisions for a post
 */
function countRevisions(postId) {
    const row = db.prepare(`
    SELECT COUNT(*) as count FROM posts
    WHERE post_parent = ? AND post_type = 'revision'
  `).get(postId);

    return row.count;
}

/**
 * Compare two revisions
 */
function compareRevisions(revisionId1, revisionId2) {
    const rev1 = getRevision(revisionId1);
    const rev2 = getRevision(revisionId2);

    if (!rev1 || !rev2) return null;

    return {
        revision1: rev1,
        revision2: rev2,
        titleChanged: rev1.title !== rev2.title,
        contentChanged: rev1.content !== rev2.content,
        excerptChanged: rev1.excerpt !== rev2.excerpt
    };
}

/**
 * Limit revisions per post (cleanup old revisions)
 */
function limitRevisions(postId, maxRevisions = 10) {
    const count = countRevisions(postId);

    if (count <= maxRevisions) return 0;

    const toDelete = count - maxRevisions;

    // Delete oldest revisions
    const result = db.prepare(`
    DELETE FROM posts WHERE id IN (
      SELECT id FROM posts
      WHERE post_parent = ? AND post_type = 'revision'
      ORDER BY post_modified ASC
      LIMIT ?
    )
  `).run(postId, toDelete);

    return result.changes;
}

module.exports = {
    saveRevision,
    getRevisions,
    getRevision,
    restoreRevision,
    deleteRevision,
    deleteAllRevisions,
    countRevisions,
    compareRevisions,
    limitRevisions
};
