/**
 * WordJS - Comments Routes
 * /api/v1/comments/*
 */

const express = require('express');
const router = express.Router();
const Comment = require('../models/Comment');
const Post = require('../models/Post');
const { getOption } = require('../core/options');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { can } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /comments
 * List comments
 */
router.get('/', optionalAuth, asyncHandler(async (req, res) => {
    const {
        page = 1,
        per_page = 10,
        post,
        status = '1', // approved
        parent,
        search,
        orderby = 'date',
        order = 'desc'
    } = req.query;

    const limit = Math.min(parseInt(per_page, 10) || 10, 100);
    const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

    // Only admins can see non-approved comments
    let commentStatus = status;
    if (!req.user || !req.user.can('moderate_comments')) {
        commentStatus = '1';
    }

    const orderByMap = {
        date: 'comment_date',
        id: 'comment_id'
    };

    const comments = await Comment.findAll({
        postId: post ? parseInt(post, 10) : undefined,
        status: commentStatus === 'any' ? undefined : commentStatus,
        parent: parent !== undefined ? parseInt(parent, 10) : undefined,
        search,
        limit,
        offset,
        orderBy: orderByMap[orderby] || 'comment_date',
        // SECURITY: Whitelist order direction
        order: ['asc', 'desc'].includes(order.toLowerCase()) ? order.toUpperCase() : 'DESC'
    });

    const total = await Comment.count({
        postId: post ? parseInt(post, 10) : undefined,
        status: commentStatus === 'any' ? undefined : commentStatus
    });
    const totalPages = Math.ceil(total / limit);

    res.set('X-WP-Total', total);
    res.set('X-WP-TotalPages', totalPages);

    res.json(comments.map(comment => comment.toJSON()));
}));

/**
 * GET /comments/:id
 * Get single comment
 */
router.get('/:id', optionalAuth, asyncHandler(async (req, res) => {
    const comment = await Comment.findById(parseInt(req.params.id, 10));

    if (!comment) {
        return res.status(404).json({
            code: 'rest_comment_invalid_id',
            message: 'Invalid comment ID.',
            data: { status: 404 }
        });
    }

    // Check if user can view non-approved comments
    if (comment.commentApproved !== '1') {
        if (!req.user || !req.user.can('moderate_comments')) {
            return res.status(404).json({
                code: 'rest_comment_invalid_id',
                message: 'Invalid comment ID.',
                data: { status: 404 }
            });
        }
    }

    res.json(comment.toJSON());
}));

/**
 * POST /comments
 * Create comment
 */
router.post('/', optionalAuth, asyncHandler(async (req, res) => {
    const {
        post: postId,
        author_name,
        author_email,
        author_url,
        content,
        parent
    } = req.body;

    if (!postId || !content) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Post ID and content are required.',
            data: { status: 400 }
        });
    }

    // Check if registration is required to comment
    const requireRegistration = await getOption('comment_registration', '0') === '1';
    if (requireRegistration && !req.user) {
        return res.status(401).json({
            code: 'rest_comment_login_required',
            message: 'Sorry, you must be logged in to post a comment.',
            data: { status: 401 }
        });
    }

    // Check post exists
    const post = await Post.findById(parseInt(postId, 10));
    if (!post) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid post ID.',
            data: { status: 404 }
        });
    }

    // Check if comments are open
    if (post.commentStatus !== 'open') {
        return res.status(403).json({
            code: 'rest_comment_closed',
            message: 'Comments are closed for this post.',
            data: { status: 403 }
        });
    }

    // Get author info
    let author = author_name;
    let email = author_email;
    let url = author_url || '';
    let userId = 0;

    if (req.user) {
        author = req.user.displayName;
        email = req.user.userEmail;
        url = req.user.userUrl;
        userId = req.user.id;
    } else {
        // Require name and email for guests
        if (!author || !email) {
            return res.status(400).json({
                code: 'rest_missing_param',
                message: 'Author name and email are required.',
                data: { status: 400 }
            });
        }
    }

    // Determine initial status
    let status = '0'; // pending
    if (req.user && req.user.can('moderate_comments')) {
        status = '1'; // approved
    }

    const comment = await Comment.create({
        postId: parseInt(postId, 10),
        author,
        authorEmail: email,
        authorUrl: url,
        authorIp: req.ip,
        content,
        status,
        parent: parent ? parseInt(parent, 10) : 0,
        userId,
        agent: req.get('User-Agent') || ''
    });

    res.status(201).json(comment.toJSON());
}));

/**
 * PUT /comments/:id
 * Update comment
 */
router.put('/:id', authenticate, can('edit_comments'), asyncHandler(async (req, res) => {
    const commentId = parseInt(req.params.id, 10);
    const comment = await Comment.findById(commentId);

    if (!comment) {
        return res.status(404).json({
            code: 'rest_comment_invalid_id',
            message: 'Invalid comment ID.',
            data: { status: 404 }
        });
    }

    const { author, author_email, author_url, content, status } = req.body;

    const updated = await Comment.update(commentId, {
        author,
        authorEmail: author_email,
        authorUrl: author_url,
        content,
        status
    });

    res.json(updated.toJSON());
}));

/**
 * DELETE /comments/:id
 * Delete comment
 */
router.delete('/:id', authenticate, can('moderate_comments'), asyncHandler(async (req, res) => {
    const commentId = parseInt(req.params.id, 10);
    const comment = await Comment.findById(commentId);

    if (!comment) {
        return res.status(404).json({
            code: 'rest_comment_invalid_id',
            message: 'Invalid comment ID.',
            data: { status: 404 }
        });
    }

    const force = req.query.force === 'true';
    await Comment.delete(commentId, force);

    if (force) {
        res.json({ deleted: true, previous: comment.toJSON() });
    } else {
        res.json((await Comment.findById(commentId)).toJSON());
    }
}));

/**
 * POST /comments/:id/approve
 * Approve comment
 */
router.post('/:id/approve', authenticate, can('moderate_comments'), asyncHandler(async (req, res) => {
    const commentId = parseInt(req.params.id, 10);
    const updated = await Comment.approve(commentId);

    if (!updated) {
        return res.status(404).json({
            code: 'rest_comment_invalid_id',
            message: 'Invalid comment ID.',
            data: { status: 404 }
        });
    }

    res.json(updated.toJSON());
}));

/**
 * POST /comments/:id/spam
 * Mark comment as spam
 */
router.post('/:id/spam', authenticate, can('moderate_comments'), asyncHandler(async (req, res) => {
    const commentId = parseInt(req.params.id, 10);
    const updated = await Comment.spam(commentId);

    if (!updated) {
        return res.status(404).json({
            code: 'rest_comment_invalid_id',
            message: 'Invalid comment ID.',
            data: { status: 404 }
        });
    }

    res.json(updated.toJSON());
}));

module.exports = router;
