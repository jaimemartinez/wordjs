/**
 * WordJS - Revisions Routes
 * /api/v1/revisions/*
 */

const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const {
    getRevisions, getRevision, restoreRevision,
    deleteRevision, countRevisions, compareRevisions
} = require('../core/revisions');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * Resolve the parent post id for a revision and check whether the current
 * user may act on it. `edit` distinguishes mutating actions (restore/delete)
 * from read/compare actions. Returns the parent post on success, or an error
 * descriptor `{ code, status }` the caller should send.
 */
async function authorizeForPost(req, postId, { edit = false } = {}) {
    if (postId == null) {
        return { error: { code: 'rest_post_invalid_id', status: 404 } };
    }
    const post = await Post.findById(postId);
    if (!post) {
        return { error: { code: 'rest_post_invalid_id', status: 404 } };
    }
    const isOwner = post.authorId === req.user.id;
    if (isOwner) {
        // Owner needs the edit capability to mutate; reading/comparing is allowed.
        if (edit && !req.user.can('edit_posts')) {
            return { error: { code: 'rest_forbidden', status: 403 } };
        }
    } else if (!req.user.can('edit_others_posts')) {
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
router.get('/post/:postId', authenticate, asyncHandler(async (req, res) => {
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
router.get('/:id', authenticate, asyncHandler(async (req, res) => {
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
router.post('/:id/restore', authenticate, asyncHandler(async (req, res) => {
    const revisionId = parseInt(req.params.id, 10);

    const revision = await getRevision(revisionId);
    if (!revision) {
        return res.status(404).json({ error: 'Revision not found' });
    }

    const auth = await authorizeForPost(req, revision.postId, { edit: true });
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
router.delete('/:id', authenticate, asyncHandler(async (req, res) => {
    const revisionId = parseInt(req.params.id, 10);

    const revision = await getRevision(revisionId);
    if (!revision) {
        return res.status(404).json({ error: 'Revision not found' });
    }

    const auth = await authorizeForPost(req, revision.postId, { edit: true });
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
router.get('/compare/:id1/:id2', authenticate, asyncHandler(async (req, res) => {
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
