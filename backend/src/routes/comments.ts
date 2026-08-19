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
const { stripTags, escUrl } = require('../core/formatting');

// Shared, length-capped email validator (the one shape rule) — guards against ReDoS on unbounded input.
const { isValidAddress } = require('../core/mailbox');

/**
 * Validate a guest-supplied author URL: only http/https are permitted, and the value must be a
 * well-formed absolute URL. escUrl returns '' for anything else (javascript:, data:, mailto:, etc.).
 */
function safeAuthorUrl(raw: any) {
    if (!raw) return '';
    const cleaned = escUrl(String(raw).trim());
    if (!cleaned) return '';
    try {
        const proto = new URL(cleaned).protocol;
        return (proto === 'http:' || proto === 'https:') ? cleaned : '';
    } catch {
        return '';
    }
}

/**
 * @swagger
 * tags:
 *   name: Comments
 *   description: Comment management
 */

/**
 * @swagger
 * /comments:
 *   get:
 *     summary: List comments
 *     tags: [Comments]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: post
 *         description: Filter by post ID
 *         schema:
 *           type: integer
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: ['1', '0', 'spam', 'trash', 'any']
 *     responses:
 *       200:
 *         description: List of comments
 */
router.get('/', optionalAuth, asyncHandler(async (req: any, res: any) => {
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

    // Only comment moderators can see non-approved comments AND the private commenter PII (email/IP
    // are gated in toJSON(canModerate) below).
    const canModerate = !!(req.user && req.user.can('moderate_comments'));
    let commentStatus = status;
    if (!canModerate) {
        commentStatus = '1';
    }

    // TWO request-value defects live in these three lines, and both are members of classes this repo has
    // already fixed elsewhere and not here:
    //  · PROTOTYPE — a `{}` literal answers orderByMap['constructor'] with a FUNCTION, so `|| 'x'` never
    //    fires and a Function reaches the model layer (contained today only by Comment.findAll's own
    //    allowlist, in another module, which nothing ties to this map). Object.create(null) has no
    //    inherited keys to find. Same fix routes/posts.ts already carries.
    //  · TYPE — `?order[]=asc` makes `order` an Array and `order.toLowerCase()` threw a 500 to an
    //    ANONYMOUS caller. String() first, exactly as routes/categories.ts and routes/tags.ts do.
    const orderByMap: Record<string, string> = Object.assign(Object.create(null), {
        date: 'comment_date',
        id: 'comment_id'
    });

    const comments = await Comment.findAll({
        postId: post ? parseInt(post, 10) : undefined,
        status: commentStatus === 'any' ? undefined : commentStatus,
        parent: parent !== undefined ? parseInt(parent, 10) : undefined,
        search,
        limit,
        offset,
        orderBy: orderByMap[String(orderby)] || 'comment_date',
        // SECURITY: Whitelist order direction
        order: ['asc', 'desc'].includes(String(order).toLowerCase()) ? String(order).toUpperCase() : 'DESC'
    });

    const total = await Comment.count({
        postId: post ? parseInt(post, 10) : undefined,
        status: commentStatus === 'any' ? undefined : commentStatus,
        parent: parent !== undefined ? parseInt(parent, 10) : undefined,
        search
    });
    const totalPages = Math.ceil(total / limit);

    res.set('X-WP-Total', total);
    res.set('X-WP-TotalPages', totalPages);

    res.json(comments.map((comment: any) => comment.toJSON(canModerate)));
}));

/**
 * @swagger
 * /comments/{id}:
 *   get:
 *     summary: Get a comment
 *     tags: [Comments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Comment details
 *       404:
 *         description: Comment not found
 */
router.get('/:id', optionalAuth, asyncHandler(async (req: any, res: any) => {
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

    res.json(comment.toJSON(!!(req.user && req.user.can('moderate_comments'))));
}));

/**
 * @swagger
 * /comments:
 *   post:
 *     summary: Create a comment
 *     tags: [Comments]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [post, content]
 *             properties:
 *               post:
 *                 type: integer
 *               content:
 *                 type: string
 *               author_name:
 *                 type: string
 *               author_email:
 *                 type: string
 *               parent:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Comment created
 *       400:
 *         description: Validation error
 */
router.post('/', optionalAuth, asyncHandler(async (req: any, res: any) => {
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
        // SECURITY: a logged-in user's stored profile URL is also rendered as a clickable comment-author
        // link (admin moderation UI + public post page), so hold it to the SAME http(s)-only rule the
        // guest branch applies — otherwise a self-service `javascript:`/`data:` profile URL (see the
        // profile-update guard in models/User.ts) would reach that href sink verbatim (second-order XSS).
        url = safeAuthorUrl(req.user.userUrl);
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

        // SECURITY: guest author fields are persisted and later rendered. Treat the display name as
        // plain text (strip any markup), validate the email shape, and restrict author_url to
        // http(s) so a value like `javascript:...` can never become a clickable comment-author link.
        author = stripTags(String(author)).trim();
        if (!author) {
            return res.status(400).json({
                code: 'rest_missing_param',
                message: 'Author name is required.',
                data: { status: 400 }
            });
        }
        email = String(email).trim();
        if (!isValidAddress(email)) {
            return res.status(400).json({
                code: 'rest_invalid_param',
                message: 'A valid author email is required.',
                data: { status: 400 }
            });
        }
        url = safeAuthorUrl(url);
    }

    // SECURITY (VAL-01): a reply must point at a real parent comment on the SAME post. Without this an
    // attacker can thread a reply under an unrelated post's comment (thread spoofing / cross-post linking)
    // or reference a non-existent id. Top-level comments (no parent) are still allowed.
    const parentId = parent ? parseInt(parent, 10) : 0;
    if (parentId) {
        const parentComment = await Comment.findById(parentId);
        if (!parentComment || parentComment.commentPostId !== parseInt(postId, 10)) {
            return res.status(400).json({
                code: 'rest_comment_invalid_parent',
                message: 'Invalid parent comment.',
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
        parent: parentId,
        userId,
        agent: req.get('User-Agent') || ''
    });

    res.status(201).json(comment.toJSON(!!(req.user && req.user.can('moderate_comments'))));
}));

/**
 * @swagger
 * /comments/{id}:
 *   put:
 *     summary: Update a comment
 *     tags: [Comments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               content:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: ['1', '0', 'spam', 'trash']
 *     responses:
 *       200:
 *         description: Comment updated
 */
router.put('/:id', authenticate, can('edit_comments'), asyncHandler(async (req: any, res: any) => {
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

    // SECURITY: changing a comment's MODERATION status (approve '1' / unapprove '0' / spam / trash) is a
    // privileged action gated by moderate_comments — the SAME capability POST /:id/approve and /:id/spam
    // require. edit_comments alone lets a caller fix a comment's content/author fields, but must NOT be a
    // back door to moderation: a custom role granting edit_comments without moderate_comments could
    // otherwise approve/spam any comment via this field. Reject a status change from a non-moderator.
    if (status !== undefined && !req.user.can('moderate_comments')) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You do not have permission to moderate comments.',
            data: { status: 403 }
        });
    }

    // SECURITY: enforce the SAME http(s)-only constraint the guest-create path applies via
    // safeAuthorUrl, so an edit_comments user can't set a `javascript:`/`data:` comment_author_url that
    // bypasses guest validation. Only transform when the field was actually provided — leaving it
    // undefined preserves Comment.update's "field omitted → stored value unchanged" behavior.
    const safeUrl = author_url === undefined ? undefined : safeAuthorUrl(author_url);

    const updated = await Comment.update(commentId, {
        author,
        authorEmail: author_email,
        authorUrl: safeUrl,
        content,
        status
    });

    res.json(updated.toJSON(true)); // moderation route (edit/approve/spam) — moderator sees full PII
}));

/**
 * @swagger
 * /comments/{id}:
 *   delete:
 *     summary: Delete a comment (Trash or Force)
 *     tags: [Comments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: force
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: Comment deleted
 */
router.delete('/:id', authenticate, can('moderate_comments'), asyncHandler(async (req: any, res: any) => {
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
        res.json({ deleted: true, previous: comment.toJSON(true) });
    } else {
        const fresh = await Comment.findById(commentId);
        if (!fresh) {
            return res.status(404).json({
                code: 'rest_comment_invalid_id',
                message: 'Invalid comment ID.',
                data: { status: 404 }
            });
        }
        res.json(fresh.toJSON(true)); // moderation route — moderator sees full PII
    }
}));

/**
 * POST /comments/:id/approve
 * Approve comment
 */
router.post('/:id/approve', authenticate, can('moderate_comments'), asyncHandler(async (req: any, res: any) => {
    const commentId = parseInt(req.params.id, 10);
    const updated = await Comment.approve(commentId);

    if (!updated) {
        return res.status(404).json({
            code: 'rest_comment_invalid_id',
            message: 'Invalid comment ID.',
            data: { status: 404 }
        });
    }

    res.json(updated.toJSON(true)); // moderation route (edit/approve/spam) — moderator sees full PII
}));

/**
 * POST /comments/:id/spam
 * Mark comment as spam
 */
router.post('/:id/spam', authenticate, can('moderate_comments'), asyncHandler(async (req: any, res: any) => {
    const commentId = parseInt(req.params.id, 10);
    const updated = await Comment.spam(commentId);

    if (!updated) {
        return res.status(404).json({
            code: 'rest_comment_invalid_id',
            message: 'Invalid comment ID.',
            data: { status: 404 }
        });
    }

    res.json(updated.toJSON(true)); // moderation route (edit/approve/spam) — moderator sees full PII
}));

module.exports = router;
