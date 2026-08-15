/**
 * WordJS - Post Revisions
 * Equivalent to wp-includes/revision.php
 */

const { db, dbAsync } = require('../config/database');
const { diffText, diffStats } = require('./text-diff');

/**
 * Save a revision of a post
 * Equivalent to wp_save_post_revision()
 */
async function saveRevision(postId: number) {
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'revision', '')
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

  const revisionId = result.lastID;

  // Copy meta to revision
  const meta = await dbAsync.all('SELECT meta_key, meta_value FROM post_meta WHERE post_id = ?', [postId]);
  for (const row of meta) {
    await dbAsync.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)', [revisionId, row.meta_key, row.meta_value]);
  }

  // Cleanup old revisions (keep last 10)
  await limitRevisions(postId, 10);

  return revisionId;
}

/**
 * Get revisions for a post
 * Equivalent to wp_get_post_revisions()
 */
async function getRevisions(postId: number, options: { limit?: number; offset?: number } = {}) {
  const { limit = 10, offset = 0 } = options;

  const rows = await dbAsync.all(`
    SELECT * FROM posts
    WHERE post_parent = ? AND post_type = 'revision'
    ORDER BY post_modified DESC
    LIMIT ? OFFSET ?
  `, [postId, limit, offset]);

  return rows.map((row: any) => ({
    id: row.id,
    postId: row.post_parent,
    authorId: row.author_id,
    title: row.post_title,
    content: row.post_content,
    excerpt: row.post_excerpt,
    modified: row.post_modified
  }));
}

/**
 * Get a specific revision
 */
async function getRevision(revisionId: number) {
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
    modified: row.post_modified,
    meta: await getAllMeta(revisionId)
  };
}

/**
 * Helper to get meta for revisions
 */
async function getAllMeta(postId: number) {
  const rows = await dbAsync.all('SELECT meta_key, meta_value FROM post_meta WHERE post_id = ?', [postId]);
  const meta: Record<string, any> = {};
  rows.forEach((row: any) => {
    try {
      meta[row.meta_key] = JSON.parse(row.meta_value);
    } catch {
      meta[row.meta_key] = row.meta_value;
    }
  });
  return meta;
}

/**
 * Restore a revision
 * Equivalent to wp_restore_post_revision()
 */
async function restoreRevision(revisionId: number) {
  const revision = await getRevision(revisionId);
  if (!revision) return false;

  // Save current state as a new revision first (outside the restore transaction, matching the
  // original ordering — this is its own multi-statement unit and must persist regardless).
  await saveRevision(revision.postId);

  try {
    // Run the restore as ONE atomic unit on a single connection. Previously this issued
    // BEGIN/UPDATE/.../COMMIT as separate dbAsync.run() calls; on the pg driver each call grabs a
    // DIFFERENT pooled connection, so the BEGIN/COMMIT did not actually bound the statements (they
    // ran auto-committed on whatever backend the pool handed out). dbAsync.transaction() pins one
    // connection so the UPDATE + meta delete/insert truly commit or roll back together.
    await dbAsync.transaction(async (tx: any) => {
      // Restore the revision content
      await tx.run(`
        UPDATE posts SET
          post_title = ?,
          post_content = ?,
          post_excerpt = ?,
          post_modified = CURRENT_TIMESTAMP,
          post_modified_gmt = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [revision.title, revision.content, revision.excerpt, revision.postId]);

      // Restore Meta - ONLY if the revision has meta to restore
      const metaEntries = Object.entries(revision.meta || {});
      if (metaEntries.length > 0) {
        // Delete current parent meta first
        await tx.run('DELETE FROM post_meta WHERE post_id = ?', [revision.postId]);

        // Insert revision meta into parent post
        for (const [key, value] of metaEntries) {
          const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
          await tx.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)', [revision.postId, key, serialized]);
        }
      }
    });
    return true;
  } catch (error) {
    // transaction() already rolled back on throw; just report.
    console.error('Failed to restore revision:', error);
    return false;
  }
}

/**
 * Delete a revision
 */
async function deleteRevision(revisionId: number) {
  const result = await dbAsync.run(`
    DELETE FROM posts WHERE id = ? AND post_type = 'revision'
  `, [revisionId]);

  return result.changes > 0;
}

/**
 * Delete all revisions for a post
 */
async function deleteAllRevisions(postId: number) {
  const result = await dbAsync.run(`
    DELETE FROM posts WHERE post_parent = ? AND post_type = 'revision'
  `, [postId]);

  return result.changes;
}

/**
 * Count revisions for a post
 */
async function countRevisions(postId: number) {
  const row = await dbAsync.get(`
    SELECT COUNT(*) as count FROM posts
    WHERE post_parent = ? AND post_type = 'revision'
  `, [postId]);

  return row.count;
}

/**
 * Compare two revisions.
 *
 * Historically this returned only three "changed y/n" booleans, which told the revisions UI THAT a
 * field changed but never WHAT. It now also returns a structured, per-field diff: an ordered list of
 * {type: 'same'|'added'|'removed', value} segments (word-level LCS, dependency-free — see
 * core/text-diff) that the admin UI can render as inline added/removed text. The booleans are kept
 * verbatim for back-compat; `diff` is purely additive.
 *
 * Direction: revision1 is the OLD side, revision2 the NEW side — an 'added' segment is text present
 * in rev2 but not rev1, 'removed' is present in rev1 but not rev2. (This matches the ordering the
 * route passes: /compare/:id1/:id2.)
 */
async function compareRevisions(revisionId1: number, revisionId2: number) {
  const rev1 = await getRevision(revisionId1);
  const rev2 = await getRevision(revisionId2);

  if (!rev1 || !rev2) return null;

  // Content is HTML and may be one long line, so a word-level diff (whitespace-lossless) gives the
  // granular per-word added/removed segments a reader wants; title/excerpt diff the same way.
  const titleDiff = diffText(rev1.title || '', rev2.title || '', 'word');
  const contentDiff = diffText(rev1.content || '', rev2.content || '', 'word');
  const excerptDiff = diffText(rev1.excerpt || '', rev2.excerpt || '', 'word');

  return {
    revision1: rev1,
    revision2: rev2,
    titleChanged: rev1.title !== rev2.title,
    contentChanged: rev1.content !== rev2.content,
    excerptChanged: rev1.excerpt !== rev2.excerpt,
    // Structured word-level diff. Each field is a DiffSegment[]; `stats` gives added/removed counts
    // per field so a caller can badge the change size without re-walking the segments.
    diff: {
      title: titleDiff,
      content: contentDiff,
      excerpt: excerptDiff,
      stats: {
        title: diffStats(titleDiff),
        content: diffStats(contentDiff),
        excerpt: diffStats(excerptDiff)
      }
    }
  };
}

/**
 * Limit revisions per post (cleanup old revisions)
 */
async function limitRevisions(postId: number, maxRevisions = 10) {
  const count = await countRevisions(postId);

  if (count <= maxRevisions) return 0;

  const toDelete = count - maxRevisions;

  // Select the oldest revision ids to prune, THEN delete by explicit id list. The obvious one-shot
  // `DELETE FROM posts WHERE id IN (SELECT id FROM posts ... ORDER BY ... LIMIT ?)` works on SQLite and
  // Postgres but MySQL REJECTS it twice over: ER 1093 (can't modify + select the same table 'posts' in a
  // subquery) and ER 1235 (LIMIT is not supported inside an IN-subquery). So pruning — and any restore
  // that triggers it (saveRevision runs OUTSIDE restoreRevision's try) — used to throw on MySQL, leaving
  // revisions to grow unbounded and 500-ing a restore of a >10-revision post. The select-then-delete
  // form is portable across all drivers. (A top-level LIMIT ? in the SELECT is fine on every engine.)
  // The `, id ASC` tiebreak makes the pick deterministic across engines: revisions copy the parent's
  // post_modified, so many share a timestamp — without it, which rows get pruned would vary by engine.
  const oldest = await dbAsync.all(`
    SELECT id FROM posts
    WHERE post_parent = ? AND post_type = 'revision'
    ORDER BY post_modified ASC, id ASC
    LIMIT ?
  `, [postId, toDelete]);

  const ids = oldest.map((r: any) => r.id).filter((id: any) => id != null);
  if (ids.length === 0) return 0;

  const placeholders = ids.map(() => '?').join(',');
  // Prune the revisions' meta first (else it orphans in post_meta), then the revision rows themselves.
  await dbAsync.run(`DELETE FROM post_meta WHERE post_id IN (${placeholders})`, ids);
  const result = await dbAsync.run(`DELETE FROM posts WHERE id IN (${placeholders})`, ids);

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
