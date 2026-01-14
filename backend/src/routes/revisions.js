/**
 * WordJS - Revisions Routes
 * /api/v1/revisions/*
 */

const express = require('express');
const router = express.Router();
const {
    getRevisions, getRevision, restoreRevision,
    deleteRevision, countRevisions, compareRevisions
} = require('../core/revisions');
const { authenticate } = require('../middleware/auth');
const { canEditPost } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /revisions/post/:postId
 * Get all revisions for a post
 */
router.get('/post/:postId', authenticate, asyncHandler(async (req, res) => {
    const postId = parseInt(req.params.postId, 10);
    const limit = parseInt(req.query.limit) || 10;
    const offset = parseInt(req.query.offset) || 0;

    const revisions = getRevisions(postId, { limit, offset });
    const total = countRevisions(postId);

    res.json({
        revisions,
        total,
        postId
    });
}));

/**
 * GET /revisions/:id
 * Get a specific revision
 */
router.get('/:id', authenticate, asyncHandler(async (req, res) => {
    const revision = getRevision(parseInt(req.params.id, 10));

    if (!revision) {
        return res.status(404).json({ error: 'Revision not found' });
    }

    res.json(revision);
}));

/**
 * POST /revisions/:id/restore
 * Restore a revision
 */
router.post('/:id/restore', authenticate, asyncHandler(async (req, res) => {
    const revisionId = parseInt(req.params.id, 10);
    const result = restoreRevision(revisionId);

    if (!result) {
        return res.status(404).json({ error: 'Revision not found' });
    }

    res.json({ success: true, message: 'Revision restored' });
}));

/**
 * DELETE /revisions/:id
 * Delete a revision
 */
router.delete('/:id', authenticate, asyncHandler(async (req, res) => {
    const revisionId = parseInt(req.params.id, 10);
    const result = deleteRevision(revisionId);

    res.json({ success: result });
}));

/**
 * GET /revisions/compare/:id1/:id2
 * Compare two revisions
 */
router.get('/compare/:id1/:id2', authenticate, asyncHandler(async (req, res) => {
    const comparison = compareRevisions(
        parseInt(req.params.id1, 10),
        parseInt(req.params.id2, 10)
    );

    if (!comparison) {
        return res.status(404).json({ error: 'One or both revisions not found' });
    }

    res.json(comparison);
}));

module.exports = router;
