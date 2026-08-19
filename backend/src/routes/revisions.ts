/**
 * WordJS - Revisions Routes
 * /api/v1/revisions/*
 */

import type { Response } from 'express';

const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const {
    getRevisions, getRevision, restoreRevision,
    deleteRevision, countRevisions, compareRevisions
} = require('../core/revisions');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
// Same capability-family resolver routes/posts.ts uses for its PUT/DELETE gate — imported (not
// re-implemented) so the restore/delete authorization here cannot drift from the post-edit gate.
// RESTORE goes one step further and calls the shared gate ITSELF (`canEditPostRecord`) rather than
// re-deriving it from the family, because "restore" IS an edit of the parent post.
const { capsFor, capsForType, canEditPostRecord, isRestExposedPostType } = require('../core/post-capabilities');

/**
 * Resolve the parent post id for a revision and check whether the current user may act on it.
 * `action` is 'read' (default, for get/compare), 'edit' (restore), or 'delete'. Returns the parent post
 * on success, or an error descriptor `{ code, status }` the caller should send.
 *
 * The mutating checks mirror routes/posts.ts /:id EXACTLY, per action:
 *   • RESTORE rewrites the parent's live title/content/excerpt — an EDIT — so it mirrors PUT /posts/:id:
 *     edit_<type>s (own) / edit_others_<type>s, plus edit_published_<type>s when the post is published.
 *   • DELETE removes revision history — a DELETE — so it mirrors DELETE /posts/:id: delete_<type>s (own) /
 *     delete_others_<type>s, plus delete_published_<type>s when the post is published.
 * In both cases the parent post's TYPE picks the capability family (a post-only author must not touch a
 * PAGE). Without this, a contributor with plain edit_posts (but not edit_published_posts) could revert or
 * unpublish their OWN editor-published post via restore, and a role with edit but not delete caps could
 * purge history via delete — the same edit-vs-publish/type privilege separation posts.ts already enforces.
 */
async function authorizeForPost(req: any, postId: any, { action = 'read' } = {}) {
    if (postId == null) {
        return { error: { code: 'rest_post_invalid_id', status: 404 } };
    }
    const post = await Post.findById(postId);
    if (!post) {
        return { error: { code: 'rest_post_invalid_id', status: 404 } };
    }
    // `revision` and `nav_menu_item` are rows in `posts` marked INTERNAL (showInRest: false) and carry
    // no capability_type, so the family resolver drops them into the plain `post` family. Revision
    // history belongs to a REST-exposed post; nobody restores a menu item's history through here.
    if (!isRestExposedPostType(post.type || post.postType || 'post')) {
        return { error: { code: 'rest_forbidden', status: 403 } };
    }
    // Fall back to capsFor('post') for a post whose registered type was since removed (capsForType null).
    const caps = capsForType(post.type || post.postType || 'post') || capsFor('post');
    const isOwner = post.authorId === req.user.id;
    if (action === 'edit') {
        // Restore rewrites the parent's live body: it is THE post edit, so it asks the one function
        // that defines it instead of re-deriving type + ownership + published from the family here.
        // Two spellings of one policy is how presence.ts ended up authorizing on the global capability.
        if (!canEditPostRecord(req.user, post)) {
            return { error: { code: 'rest_forbidden', status: 403 } };
        }
    } else if (action === 'delete') {
        // Delete purges history — the DELETE family, which `canEditPostRecord` deliberately does not
        // cover (a role may edit without being allowed to destroy). Mirrors DELETE /posts/:id.
        let allowed = isOwner ? req.user.can(caps.del) : req.user.can(caps.deleteOthers);
        if (post.postStatus === 'publish' && !req.user.can(caps.deletePublished)) allowed = false;
        if (!allowed) {
            return { error: { code: 'rest_forbidden', status: 403 } };
        }
    } else if (!isOwner && !req.user.can(caps.editOthers)) {
        // Read/compare: the owner may always view their own revisions; a non-owner needs the
        // type-appropriate edit_others_<type>s (was hardcoded edit_others_posts — now type-aware).
        return { error: { code: 'rest_forbidden', status: 403 } };
    }
    return { post };
}

/**
 * @swagger
 * tags:
 *   name: Revisions
 *   description: Post revision history and comparison
 */

/**
 * @swagger
 * /revisions/post/{postId}:
 *   get:
 *     summary: Get all revisions for a post
 *     tags: [Revisions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: postId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of revisions
 */
router.get('/post/:postId', authenticate, asyncHandler(async (req: any, res: Response) => {
    const postId = parseInt(req.params.postId, 10);
    const limit = parseInt(req.query.limit) || 10;
    const offset = parseInt(req.query.offset) || 0;

    const auth = await authorizeForPost(req, postId);
    if (auth.error) {
        return res.status(auth.error.status).json({
            code: auth.error.code,
            data: { status: auth.error.status }
        });
    }

    const revisions = await getRevisions(postId, { limit, offset });
    const total = await countRevisions(postId);

    res.json({
        revisions,
        total,
        postId
    });
}));

/**
 * @swagger
 * /revisions/{id}:
 *   get:
 *     summary: Get a specific revision
 *     tags: [Revisions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Revision details
 *       404:
 *         description: Revision not found
 */
router.get('/:id', authenticate, asyncHandler(async (req: any, res: Response) => {
    const revision = await getRevision(parseInt(req.params.id, 10));

    if (!revision) {
        return res.status(404).json({ error: 'Revision not found' });
    }

    const auth = await authorizeForPost(req, revision.postId);
    if (auth.error) {
        return res.status(auth.error.status).json({
            code: auth.error.code,
            data: { status: auth.error.status }
        });
    }

    res.json(revision);
}));

/**
 * @swagger
 * /revisions/{id}/restore:
 *   post:
 *     summary: Restore a revision
 *     tags: [Revisions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Revision restored
 */
router.post('/:id/restore', authenticate, asyncHandler(async (req: any, res: Response) => {
    const revisionId = parseInt(req.params.id, 10);

    const revision = await getRevision(revisionId);
    if (!revision) {
        return res.status(404).json({ error: 'Revision not found' });
    }

    const auth = await authorizeForPost(req, revision.postId, { action: 'edit' });
    if (auth.error) {
        return res.status(auth.error.status).json({
            code: auth.error.code,
            data: { status: auth.error.status }
        });
    }

    const result = await restoreRevision(revisionId);

    if (!result) {
        return res.status(404).json({ error: 'Revision not found' });
    }

    res.json({ success: true, message: 'Revision restored' });
}));

/**
 * @swagger
 * /revisions/{id}:
 *   delete:
 *     summary: Delete a revision
 *     tags: [Revisions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Revision deleted
 */
router.delete('/:id', authenticate, asyncHandler(async (req: any, res: Response) => {
    const revisionId = parseInt(req.params.id, 10);

    const revision = await getRevision(revisionId);
    if (!revision) {
        return res.status(404).json({ error: 'Revision not found' });
    }

    const auth = await authorizeForPost(req, revision.postId, { action: 'delete' });
    if (auth.error) {
        return res.status(auth.error.status).json({
            code: auth.error.code,
            data: { status: auth.error.status }
        });
    }

    const result = await deleteRevision(revisionId);

    res.json({ success: result });
}));

/**
 * @swagger
 * /revisions/compare/{id1}/{id2}:
 *   get:
 *     summary: Compare two revisions
 *     tags: [Revisions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id1
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: id2
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Comparison diff
 */
router.get('/compare/:id1/:id2', authenticate, asyncHandler(async (req: any, res: Response) => {
    const comparison = await compareRevisions(
        parseInt(req.params.id1, 10),
        parseInt(req.params.id2, 10)
    );

    if (!comparison) {
        return res.status(404).json({ error: 'One or both revisions not found' });
    }

    // Both revisions must be readable by the current user.
    for (const rev of [comparison.revision1, comparison.revision2]) {
        const auth = await authorizeForPost(req, rev.postId);
        if (auth.error) {
            return res.status(auth.error.status).json({
                code: auth.error.code,
                data: { status: auth.error.status }
            });
        }
    }

    res.json(comparison);
}));

module.exports = router;
