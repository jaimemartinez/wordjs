/**
 * WordJS - Post Revisions
 * Equivalent to wp-includes/revision.php
 */

const { db, dbAsync } = require('../config/database');

/**
 * Save a revision of a post
 * Equivalent to wp_save_post_revision()
 */
async function saveRevision(postId) {
  // Get current post data
  const post = await dbAsync.get('SELECT * FROM posts WHERE id = ?', [postId]);
  if (!post) return null;

  // Don't save revisions of revisions
  if (post.post_type === 'revision') return null;

  // Create revision
  const result = await dbAsync.run(`
    INSERT INTO posts (
      author_id, post_date, post_date_gmt, post_content, post_title,
      post_excerpt, post_status, post_name, post_modified, post_modified_gmt,
      post_parent, post_type, post_mime_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'revision', '') RETURNING id
  `, [
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
  ]);

  return result.lastID;
}

/**
 * Get revisions for a post
 * Equivalent to wp_get_post_revisions()
 */
async function getRevisions(postId, options = {}) {
  const { limit = 10, offset = 0 } = options;

  const rows = await dbAsync.all(`
    SELECT * FROM posts
    WHERE post_parent = ? AND post_type = 'revision'
    ORDER BY post_modified DESC
    LIMIT ? OFFSET ?
  `, [postId, limit, offset]);

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
async function getRevision(revisionId) {
  const row = await dbAsync.get(`
    SELECT * FROM posts WHERE id = ? AND post_type = 'revision'
  `, [revisionId]);

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
async function restoreRevision(revisionId) {
  const revision = await getRevision(revisionId);
  if (!revision) return false;

  // Save current state as a new revision first
  await saveRevision(revision.postId);

  // Restore the revision content
  await dbAsync.run(`
    UPDATE posts SET
      post_title = ?,
      post_content = ?,
      post_excerpt = ?,
      post_modified = CURRENT_TIMESTAMP,
      post_modified_gmt = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [revision.title, revision.content, revision.excerpt, revision.postId]);

  return true;
}

/**
 * Delete a revision
 */
async function deleteRevision(revisionId) {
  const result = await dbAsync.run(`
    DELETE FROM posts WHERE id = ? AND post_type = 'revision'
  `, [revisionId]);

  return result.changes > 0;
}

/**
 * Delete all revisions for a post
 */
async function deleteAllRevisions(postId) {
  const result = await dbAsync.run(`
    DELETE FROM posts WHERE post_parent = ? AND post_type = 'revision'
  `, [postId]);

  return result.changes;
}

/**
 * Count revisions for a post
 */
async function countRevisions(postId) {
  const row = await dbAsync.get(`
    SELECT COUNT(*) as count FROM posts
    WHERE post_parent = ? AND post_type = 'revision'
  `, [postId]);

  return row.count;
}

/**
 * Compare two revisions
 */
async function compareRevisions(revisionId1, revisionId2) {
  const rev1 = await getRevision(revisionId1);
  const rev2 = await getRevision(revisionId2);

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
async function limitRevisions(postId, maxRevisions = 10) {
  const count = await countRevisions(postId);

  if (count <= maxRevisions) return 0;

  const toDelete = count - maxRevisions;

  // Delete oldest revisions
  const result = await dbAsync.run(`
    DELETE FROM posts WHERE id IN (
      SELECT id FROM posts
      WHERE post_parent = ? AND post_type = 'revision'
      ORDER BY post_modified ASC
      LIMIT ?
    )
  `, [postId, toDelete]);

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
