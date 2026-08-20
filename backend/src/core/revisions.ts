/**
 * WordJS - Post Revisions
 * Equivalent to wp-includes/revision.php
 */

const crypto = require('crypto');
const database = require('../config/database');
const { dbAsync } = database;
const { diffText, diffStats } = require('./text-diff');
const { canonicalMetaKey } = require('./protected-meta');
const { runContentMutation, recordContentEvent, isContentMutationActive } = require('./content-outbox');
const {
  LEGACY_REVISIONABLE_META_KEYS,
  REVISION_SNAPSHOT_META_KEY,
} = require('./revision-constants');
const {
  buildRevisionSnapshot,
  serializeRevisionEnvelope,
  describeRevisionSnapshot,
  decodeRevisionSnapshot,
  isRevisionableMetaForType,
} = require('./revision-snapshots');

/**
 * THE VERSIONED META KEYS — the exact set a snapshot copies and a restore puts back.
 *
 * WHAT THE OLD CODE DID WRONG. saveRevision() copied EVERY meta row of the post, and restoreRevision()
 * "restored" that by running `DELETE FROM post_meta WHERE post_id = ?` before re-inserting. So a
 * restore did not roll the post back to the snapshot — it DELETED every key created since it:
 * `_wjs_review_comments` (the whole editorial review thread), plugin meta, and `_wp_trash_meta_status`,
 * whose absence makes Post.untrash() fall through to the literal 'draft' and bring a PUBLISHED post
 * back as a draft. Nothing in the UI says a restore touches meta at all.
 *
 * WHY AN EXPLICIT LIST. "Everything" is not a version boundary — it makes the restore's blast radius
 * depend on what any other feature happens to have stored. These are the keys the EDITOR authors and
 * that therefore belong to a revision: the page tree, the theme-template pick, the featured image, and
 * the SEO fields (frontend/src/lib/editorRootFields.ts SEO_META_KEYS). Snapshot and restore read the
 * SAME constant, so the two halves cannot describe different sets — which is how they came to disagree.
 */
// Public compatibility export. F4 never uses this as the authority for a new snapshot; it is the
// immutable decoder contract for rows created before manifests existed.
const REVISIONABLE_POST_META: string[] = [...LEGACY_REVISIONABLE_META_KEYS];
const REVISIONABLE_SET: Set<string> = new Set(REVISIONABLE_POST_META);

/** Is `key` a meta key a revision captures (and therefore one whose write deserves a snapshot)? */
function isRevisionableMeta(key: unknown, contentType?: unknown): boolean {
    return typeof key === 'string' && (contentType
      ? isRevisionableMetaForType(key, contentType)
      : REVISIONABLE_SET.has(canonicalMetaKey(key)));
}

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
async function saveRevision(postId: number, preserveFields: any[] = []) {
  // A revision is a post row plus zero-or-more meta rows and pruning. Standalone callers get one
  // pinned transaction; F3 content mutations already own it and transparently join here.
  if (!database.hasActiveTransaction()) {
    return await dbAsync.transaction(() => saveRevision(postId, preserveFields));
  }
  // Get current post data
  const post = await dbAsync.get('SELECT * FROM posts WHERE id = ?', [postId]);
  if (!post) return null;

  // Don't save revisions of revisions
  if (post.post_type === 'revision') return null;

  // Freeze the field/storage/codec decision BEFORE the revision row exists. An unsupported codec or
  // unsafe plugin declaration therefore aborts without leaving even a partial snapshot.
  const liveMeta = await dbAsync.all('SELECT meta_key, meta_value FROM post_meta WHERE post_id = ?', [postId]);
  const snapshot = buildRevisionSnapshot(post, liveMeta, preserveFields);

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

  // Raw metadata remains in ordinary revision meta rows: API consumers and legacy tools keep their
  // byte-faithful view, while the protected envelope says exactly which rows the codec owns.
  for (const row of snapshot.metaRows) {
    await dbAsync.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)', [revisionId, row.key, row.value]);
  }
  await dbAsync.run(
    'INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
    [revisionId, REVISION_SNAPSHOT_META_KEY, serializeRevisionEnvelope(snapshot.envelope)]
  );

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

  // post_status = 'inherit' is the ONLY status saveRevision() emits, so it is the only thing a genuine
  // revision can carry. Requiring it here (and in countRevisions/limitRevisions/getRevision) means a
  // row that reached post_type='revision' by some other door — the generic POST /posts used to accept
  // the internal `revision` type with an arbitrary `parent` — cannot pass itself off as history.
  const rows = await dbAsync.all(`
    SELECT * FROM posts
    WHERE post_parent = ? AND post_type = 'revision' AND post_status = 'inherit'
    ORDER BY post_modified DESC
    LIMIT ? OFFSET ?
  `, [postId, limit, offset]);

  const ids = rows.map((row: any) => row.id);
  const manifestByRevision: Record<number, any[]> = {};
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const manifests = await dbAsync.all(
      `SELECT post_id, meta_key, meta_value FROM post_meta WHERE post_id IN (${placeholders}) AND meta_key = ?`,
      [...ids, REVISION_SNAPSHOT_META_KEY]
    );
    for (const manifest of manifests) {
      (manifestByRevision[manifest.post_id] ||= []).push(manifest);
    }
  }
  return rows.map((row: any) => ({
    id: row.id,
    postId: row.post_parent,
    authorId: row.author_id,
    title: row.post_title,
    content: row.post_content,
    excerpt: row.post_excerpt,
    modified: row.post_modified,
    restore: describeRevisionSnapshot(manifestByRevision[row.id] || []),
  }));
}

/**
 * Get a specific revision
 */
async function getRevision(revisionId: number) {
  const row = await dbAsync.get(`
    SELECT * FROM posts WHERE id = ? AND post_type = 'revision' AND post_status = 'inherit'
  `, [revisionId]);

  if (!row) return null;

  const rawMeta = await getAllMetaRaw(revisionId);
  return {
    id: row.id,
    postId: row.post_parent,
    authorId: row.author_id,
    title: row.post_title,
    content: row.post_content,
    excerpt: row.post_excerpt,
    date: row.post_date,
    modified: row.post_modified,
    meta: await getAllMeta(revisionId, rawMeta),
    restore: describeRevisionSnapshot(rawMeta),
  };
}

/**
 * Helper to get meta for revisions
 */
async function getAllMetaRaw(postId: number) {
  return await dbAsync.all('SELECT meta_key, meta_value FROM post_meta WHERE post_id = ?', [postId]);
}

async function getAllMeta(postId: number, existingRows?: any[]) {
  const rows = existingRows || await getAllMetaRaw(postId);
  const meta: Record<string, any> = {};
  rows.forEach((row: any) => {
    // The manifest is an internal restore instruction, never author metadata and never part of the
    // historical public response shape.
    if (canonicalMetaKey(row.meta_key) === canonicalMetaKey(REVISION_SNAPSHOT_META_KEY)) return;
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
  if (!isContentMutationActive()) {
    try { return await runContentMutation(() => restoreRevision(revisionId)); }
    catch (error) {
      console.error('Failed to restore revision:', error);
      return false;
    }
  }
  const revisionRow = await dbAsync.get(`
    SELECT * FROM posts WHERE id = ? AND post_type = 'revision' AND post_status = 'inherit'
  `, [revisionId]);
  if (!revisionRow) return false;

  // Lazy requires: core/revisions is pulled in by the CLI and by route modules, and models/Post drags
  // in the cache + hook subsystems. Requiring them here keeps module load order unchanged.
  const Post = require('../models/Post');

  // The PRIOR status, read before the write, so the post_updated listeners can tell a real transition
  // from a re-save (this is exactly what Post.update passes them).
  const parentRow = await dbAsync.get('SELECT * FROM posts WHERE id = ?', [revisionRow.post_parent]);
  if (!parentRow) return false;
  const priorStatus = parentRow ? parentRow.post_status : undefined;

  // The snapshot's VERSIONED meta, RAW. getRevision().meta JSON.parse()s every value for API
  // consumers, and the old restore re-serialized that with JSON.stringify/String(...) — a lossy round
  // trip that rewrote a stored "1.50" as "1.5" and dropped the editor's original whitespace. Post
  // already has the byte-faithful reader the WXR exporter uses; reuse it rather than re-deriving.
  const rawByPost = await Post.getAllMetaRawForIds([revisionId]);
  const rawSnapshotMeta = rawByPost[revisionId] || [];
  // Decode and validate before taking the safety snapshot. A corrupt/future manifest must be a
  // read-only failure, not an operation that grows history and then refuses to restore.
  const restorePlan = decodeRevisionSnapshot(revisionRow, rawSnapshotMeta, parentRow.post_type);

  // Save current state inside the SAME F3 unit. If the safety snapshot or the restore fails, neither
  // becomes visible; a 200 can never mean "restored without a recovery point".
  await saveRevision(revisionRow.post_parent, restorePlan.frozenFields);

  // Run the restore as ONE atomic unit on the F3 pinned connection. Previously this issued
    // BEGIN/UPDATE/.../COMMIT as separate dbAsync.run() calls; on the pg driver each call grabs a
    // DIFFERENT pooled connection, so the BEGIN/COMMIT did not actually bound the statements (they
    // ran auto-committed on whatever backend the pool handed out). dbAsync.transaction() pins one
    // connection so the UPDATE + meta delete/insert truly commit or roll back together.
  await dbAsync.transaction(async (tx: any) => {
      const parentField = restorePlan.columns.find((entry: any) => entry.column === 'post_parent');
      if (parentField && Number(parentField.value) > 0) {
        const seen = new Set<number>();
        let cursor = Number(parentField.value);
        for (let depth = 0; cursor > 0; depth++) {
          if (cursor === Number(revisionRow.post_parent)) throw new Error('Revision restore would create a parent cycle');
          if (seen.has(cursor) || depth >= 1024) throw new Error('Revision restore encountered an invalid parent chain');
          seen.add(cursor);
          const ancestor = await tx.get('SELECT post_parent FROM posts WHERE id = ?', [cursor]);
          if (!ancestor) throw new Error('Revision restore parent no longer exists');
          cursor = Number(ancestor.post_parent || 0);
        }
      }

      // Identifiers come only from revision-snapshots.RESTORABLE_COLUMNS. Values remain parameters.
      const assignments = restorePlan.columns.map((entry: any) => `${entry.column} = ?`);
      assignments.push('post_modified = CURRENT_TIMESTAMP', 'post_modified_gmt = CURRENT_TIMESTAMP');
      await tx.run(
        `UPDATE posts SET ${assignments.join(', ')} WHERE id = ?`,
        [...restorePlan.columns.map((entry: any) => entry.value), revisionRow.post_parent]
      );

      // Status/date are workflow state, not just bytes. Reconcile the one-shot publication event in
      // the same transaction so a restored `future` row cannot be left permanently unpublished (or
      // an old event publish a restored draft later).
      const touchesSchedule = restorePlan.columns.some((entry: any) =>
        entry.column === 'post_status' || entry.column === 'post_date' || entry.column === 'post_date_gmt');
      if (touchesSchedule) {
        const scheduledPublish = require('./scheduled-publish');
        const restoredRow = await tx.get(
          'SELECT post_status, post_date, post_date_gmt FROM posts WHERE id = ?',
          [revisionRow.post_parent]
        );
        const whenMs = scheduledPublish.parseDbDateMs(restoredRow?.post_date_gmt, true)
          ?? scheduledPublish.parseDbDateMs(restoredRow?.post_date, false);
        if (restoredRow?.post_status === 'future' && whenMs !== null
          && scheduledPublish.resolveScheduledStatus('future', whenMs) === 'future') {
          await scheduledPublish.scheduleFuturePublish(revisionRow.post_parent, whenMs);
        } else {
          if (restoredRow?.post_status === 'future') {
            await tx.run("UPDATE posts SET post_status = 'publish' WHERE id = ?", [revisionRow.post_parent]);
          }
          await scheduledPublish.cancelFuturePublish(revisionRow.post_parent);
        }
      }

      // Restore Meta. The DELETE is SCOPED to REVISIONABLE_POST_META and runs UNCONDITIONALLY.
      //
      // The old statement was `DELETE FROM post_meta WHERE post_id = ?` — it removed every key the
      // post had, including ones no revision ever captured (`_wjs_review_comments`, plugin meta,
      // `_wp_trash_meta_status`). Restoring a version must only move the keys that version HAS an
      // opinion about; the delete is what makes the restore exact (a key present live but absent from
      // the snapshot is correctly cleared), and it must not reach beyond that set.
      //
      // WHY THERE IS NO `if (snapshotMeta.length > 0)` GUARD ANY MORE. That guard was written for the
      // WIDE delete, where "the snapshot has no meta" had to mean "touch nothing" or the restore would
      // wipe the post clean. Against the SCOPED delete it protects nothing and breaks the very
      // exactness the scoping buys: an EMPTY snapshot is a real, meaningful state — the version being
      // restored had no versioned meta — and skipping the delete for it made the commonest legacy case
      // a visible no-op. A classic/imported post has no `_puck_data`; the author opens Verso, saves
      // (which writes one), then restores the pre-Verso revision: post_content came back, `_puck_data`
      // stayed, and PostContent.tsx renders `_puck_data` in preference to the classic body — so the
      // API answered 200 and the public page did not change at all. Zero snapshot rows now means
      // exactly what it says: the post goes back to having no versioned meta.
      // SQL collations disagree about case/accents/PAD SPACE. Resolve the rows by the shared weakest-
      // collation canonicalizer, delete explicit ids, then restore the schema's frozen spelling.
      const liveRows = await tx.all('SELECT meta_id, meta_key FROM post_meta WHERE post_id = ?', [revisionRow.post_parent]);
      const targets = new Set(restorePlan.meta.map((entry: any) => canonicalMetaKey(entry.key)));
      const deleteIds = liveRows
        .filter((row: any) => targets.has(canonicalMetaKey(String(row.meta_key || ''))))
        .map((row: any) => row.meta_id);
      if (deleteIds.length > 0) {
        const placeholders = deleteIds.map(() => '?').join(',');
        await tx.run(`DELETE FROM post_meta WHERE meta_id IN (${placeholders})`, deleteIds);
      }

      // Insert raw payload bytes. A declared-but-absent field deliberately inserts nothing, which is
      // how exact restore clears that field without touching metadata absent from the snapshot.
      for (const field of restorePlan.meta) {
        for (const value of field.values) {
          await tx.run(
            'INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
            [revisionRow.post_parent, field.key, value]
          );
        }
      }
  });

  // A RESTORE IS A POST WRITE, and until now it was the only one that did not say so. This module
  // wrote raw SQL and stopped: no cache invalidation and no `post_updated`. The damage was not mere
  // staleness but INCOHERENCE — Post.toJSON() reads the row from cache and the meta from the DB, so
  // the very response to the restore mixed the pre-restore title/content with the post-restore
  // _puck_data (and authorizeForPost's Post.findById, one call earlier, had just seeded that cache
  // entry even if it was cold). The public page never revalidated either: core/frontend-purge hangs
  // off post_updated, as does the post.updated webhook. Worst case was real data loss — the author
  // reopened the editor, was served the OLD cached body, fixed a typo and saved the restore away.
  //
  // Both statements now happen after the commit, through the SAME helpers Post.update uses, so a
  // restore is indistinguishable from any other write to every downstream listener.
  await Post._invalidatePostCacheById(revisionRow.post_parent);
  Post._invalidateCounts();
  const restored = Object.fromEntries(restorePlan.columns.map((entry: any) => [entry.column, entry.value]));
  recordContentEvent('post.updated', Number(revisionRow.post_parent), {
    data: {
      title: restored.post_title,
      content: restored.post_content,
      excerpt: restored.post_excerpt,
      restoredFromRevisionId: revisionId,
      restoredFields: restorePlan.descriptor.fields.map((field: any) => field.name),
    },
    previousStatus: priorStatus,
    previousType: parentRow?.post_type,
    previousSlug: parentRow?.post_name,
  });

  return true;
}

/** Decode-only intent used by the REST layer for field-level authorization and compatibility UX. */
async function getRevisionRestoreIntent(revisionId: number) {
  const revisionRow = await dbAsync.get(`
    SELECT * FROM posts WHERE id = ? AND post_type = 'revision' AND post_status = 'inherit'
  `, [revisionId]);
  if (!revisionRow) return null;
  const parent = await dbAsync.get('SELECT * FROM posts WHERE id = ?', [revisionRow.post_parent]);
  if (!parent) return null;
  const rawMeta = await getAllMetaRaw(revisionId);
  try {
    const plan = decodeRevisionSnapshot(revisionRow, rawMeta, parent.post_type);
    const byColumn = Object.fromEntries(plan.columns.map((entry: any) => [entry.column, entry.value]));
    return {
      compatible: true,
      descriptor: plan.descriptor,
      targetStatus: byColumn.post_status,
      targetParentId: byColumn.post_parent,
      touchesPublicationDate: Object.prototype.hasOwnProperty.call(byColumn, 'post_date')
        || Object.prototype.hasOwnProperty.call(byColumn, 'post_date_gmt'),
    };
  } catch (error: any) {
    return {
      compatible: false,
      descriptor: { ...describeRevisionSnapshot(rawMeta), compatible: false, errorCode: error?.code || 'revision_manifest_invalid' },
    };
  }
}

/**
 * Delete a revision
 */
async function deleteRevision(revisionId: number) {
  if (!database.hasActiveTransaction()) return await dbAsync.transaction(() => deleteRevision(revisionId));
  const revision = await dbAsync.get(
    `SELECT id FROM posts WHERE id = ? AND post_type = 'revision' AND post_status = 'inherit'`,
    [revisionId]
  );
  if (!revision) return false;
  await dbAsync.run('DELETE FROM post_meta WHERE post_id = ?', [revisionId]);
  const result = await dbAsync.run(
    `DELETE FROM posts WHERE id = ? AND post_type = 'revision' AND post_status = 'inherit'`,
    [revisionId]
  );
  return result.changes > 0;
}

/**
 * Delete all revisions for a post
 */
async function deleteAllRevisions(postId: number) {
  if (!database.hasActiveTransaction()) return await dbAsync.transaction(() => deleteAllRevisions(postId));
  const rows = await dbAsync.all(
    `SELECT id FROM posts WHERE post_parent = ? AND post_type = 'revision' AND post_status = 'inherit'`,
    [postId]
  );
  const ids = rows.map((row: any) => row.id);
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  await dbAsync.run(`DELETE FROM post_meta WHERE post_id IN (${placeholders})`, ids);
  const result = await dbAsync.run(
    `DELETE FROM posts WHERE id IN (${placeholders}) AND post_type = 'revision' AND post_status = 'inherit'`,
    ids
  );
  return result.changes;
}

/**
 * Count revisions for a post
 */
async function countRevisions(postId: number) {
  const row = await dbAsync.get(`
    SELECT COUNT(*) as count FROM posts
    WHERE post_parent = ? AND post_type = 'revision' AND post_status = 'inherit'
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
  // Same predicate as countRevisions() above — the set being counted and the set being pruned must be
  // the SAME set, or the count says "5 over the cap" while the select hands back rows that were never
  // counted.
  const oldest = await dbAsync.all(`
    SELECT id FROM posts
    WHERE post_parent = ? AND post_type = 'revision' AND post_status = 'inherit'
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
  REVISIONABLE_POST_META,
  isRevisionableMeta,
  saveRevision,
  getRevisions,
  getRevision,
  getRevisionRestoreIntent,
  restoreRevision,
  deleteRevision,
  deleteAllRevisions,
  countRevisions,
  compareRevisions,
  limitRevisions
};
