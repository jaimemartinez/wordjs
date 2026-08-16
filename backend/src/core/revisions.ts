/**
 * WordJS - Post Revisions
 * Equivalent to wp-includes/revision.php
 */

const crypto = require('crypto');
const { db, dbAsync } = require('../config/database');
const { diffText, diffStats } = require('./text-diff');

/**
 * Per-process counter that breaks ties WITHIN one millisecond.
 *
 * A revision's post_name used to be `${postId}-revision-v${Date.now()}` and the schema carries
 * `CREATE UNIQUE INDEX idx_posts_name_type ON posts (post_name, post_type) WHERE post_name <> ''`
 * (config/database.ts). saveRevision() takes ~5 ms, so two revisions of the SAME post landing in the
 * same millisecond — a double save, a restore (which snapshots first), two concurrent writers — hit
 * SQLITE_CONSTRAINT_UNIQUE. The callers made that fatal in two different ways: routes/posts.ts calls
 * saveRevision fire-and-forget, so the snapshot was lost SILENTLY (no recovery point for that edit),
 * and restoreRevision() called it outside its try, so the throw escaped and the route answered 500
 * WITHOUT restoring anything. Fixed at the source: the name is unique by construction (timestamp +
 * in-process counter + 8 random hex chars, so two processes cannot collide either).
 */
let revisionNameSeq = 0;

function nextRevisionName(postId: number) {
  revisionNameSeq = (revisionNameSeq + 1) % 1_000_000;
  // ~45 chars: comfortably inside post_name and still greppable/sortable by the old prefix.
  return `${postId}-revision-v${Date.now()}-${revisionNameSeq}-${crypto.randomBytes(4).toString('hex')}`;
}

/** True for a unique-constraint violation on any supported driver (SQLite / Postgres / MySQL). */
function isUniqueViolation(err: any) {
  const code = String(err?.code || '');
  // Deliberately NOT the generic 'SQLITE_CONSTRAINT': a NOT NULL / CHECK failure is not something a
  // fresh name would fix, and it must surface instead of being retried.
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === '23505' || code === 'ER_DUP_ENTRY') return true;
  if (err?.errno === 1062) return true;
  const msg = String(err?.message || '');
  return /UNIQUE constraint|duplicate key|Duplicate entry/i.test(msg);
}

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

  // Create revision. Belt AND braces: the generated name is already collision-proof, but a unique
  // violation retries with a fresh name instead of losing the author's snapshot.
  const MAX_NAME_ATTEMPTS = 5;
  let result: any;
  for (let attempt = 1; ; attempt++) {
    try {
      result = await dbAsync.run(`
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
        nextRevisionName(postId),
        post.post_modified,
        post.post_modified_gmt,
        postId
      ]);
      break;
    } catch (err: any) {
      if (attempt >= MAX_NAME_ATTEMPTS || !isUniqueViolation(err)) throw err;
    }
  }

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
  //
  // NEVER let this abort the restore: a failed pre-snapshot used to escape (it sits outside the try
  // below) and turn the restore into a 500 that restored NOTHING — the author lost both the new
  // content and the old one they were trying to get back. Losing the safety snapshot is bad; losing
  // the restore too is worse. Log and continue.
  try {
    await saveRevision(revision.postId);
  } catch (error) {
    console.error('Failed to snapshot current state before restoring revision:', error);
  }

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
