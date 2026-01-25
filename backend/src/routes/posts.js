/**
 * WordJS - Posts Routes
 * /api/v1/posts/*
 */

const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { can, ownerOrCan } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const sanitizeHtml = require('sanitize-html');

// Sanitization Config
const sanitize = (html) => {
    return sanitizeHtml(html, {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'iframe']),
        allowedAttributes: {
            ...sanitizeHtml.defaults.allowedAttributes,
            'img': ['src', 'alt', 'width', 'height', 'class'],
            'iframe': ['src', 'width', 'height', 'allowfullscreen', 'frameborder', 'allow'],
            '*': ['class', 'style', 'id']
        },
        allowedIframeHostnames: ['www.youtube.com', 'player.vimeo.com']
    });
};

/**
 * @swagger
 * components:
 *   schemas:
 *     Post:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         title:
 *           type: object
 *           properties:
 *             rendered:
 *               type: string
 *         content:
 *           type: object
 *           properties:
 *             rendered:
 *               type: string
 *         date:
 *           type: string
 *           format: date-time
 *         status:
 *           type: string
 *           enum: [publish, draft, pending, private, trash]
 *
 * /posts:
 *   get:
 *     summary: Retrieve a list of posts
 *     tags: [Posts]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: per_page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: A list of posts
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Post'
 */
router.get('/', optionalAuth, asyncHandler(async (req, res) => {
    const {
        page = 1,
        per_page = 10,
        status = 'publish',
        type = 'post',
        author,
        search,
        orderby = 'date',
        order = 'desc',
        categories,
        tags
    } = req.query;

    const limit = Math.min(parseInt(per_page, 10) || 10, 100);
    const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

    // Map orderby to database column
    const orderByMap = {
        date: 'post_date',
        modified: 'post_modified',
        title: 'post_title',
        id: 'id',
        menu_order: 'menu_order'
    };

    // Determine which statuses to show
    let includeStatuses = null;
    if (req.user) {
        // Logged in users can see their own drafts
        if (status === 'any') {
            includeStatuses = ['publish', 'draft', 'pending', 'private'];
        }
    }

    const posts = await Post.findAll({
        type,
        status: includeStatuses ? null : status,
        includeStatuses,
        author: author ? parseInt(author, 10) : undefined,
        search,
        limit,
        offset,
        orderBy: orderByMap[orderby] || 'post_date',
        // SECURITY: Whitelist order direction to prevent injection
        order: ['asc', 'desc'].includes(order.toLowerCase()) ? order.toUpperCase() : 'DESC'
    });

    const total = await Post.count({ type, status: status === 'any' ? null : status });
    const totalPages = Math.ceil(total / limit);

    res.set('X-WP-Total', total);
    res.set('X-WP-TotalPages', totalPages);

    res.json(await Promise.all(posts.map(post => post.toJSON())));
}));

/**
 * GET /posts/slug/:slug
 * Get single post by slug
 */
router.get('/slug/:slug', optionalAuth, asyncHandler(async (req, res) => {
    const post = await Post.findBySlug(req.params.slug);

    if (!post) {
        return res.status(404).json({
            code: 'rest_post_invalid_slug',
            message: 'Invalid post slug.',
            data: { status: 404 }
        });
    }

    // Check if user can view non-published posts
    if (post.postStatus !== 'publish') {
        if (!req.user || (post.authorId !== req.user.id && !req.user.can('edit_others_posts'))) {
            return res.status(404).json({
                code: 'rest_post_invalid_id', // standardized error code
                message: 'Invalid post ID.',
                data: { status: 404 }
            });
        }
    }

    res.json(await post.toJSON());
}));

/**
 * GET /posts/:id
 * Get single post
 */
router.get('/:id', optionalAuth, asyncHandler(async (req, res) => {
    const post = await Post.findById(parseInt(req.params.id, 10));

    if (!post) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid post ID.',
            data: { status: 404 }
        });
    }

    // Check if user can view non-published posts
    if (post.postStatus !== 'publish') {
        if (!req.user || (post.authorId !== req.user.id && !req.user.can('edit_others_posts'))) {
            return res.status(404).json({
                code: 'rest_post_invalid_id',
                message: 'Invalid post ID.',
                data: { status: 404 }
            });
        }
    }

    res.json(await post.toJSON());
}));

/**
 * @swagger
 * /posts:
 *   post:
 *     summary: Create a new post
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title:
 *                 type: string
 *               content:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [publish, draft, pending]
 *     responses:
 *       201:
 *         description: Post created
 *       400:
 *         description: Missing title
 *       403:
 *         description: Forbidden
 */
router.post('/', authenticate, can('edit_posts'), asyncHandler(async (req, res) => {
    // ...
    const {
        title,
        content,
        excerpt,
        status = 'draft',
        type = 'post',
        slug,
        parent,
        menu_order,
        comment_status,
        categories,
        tags,
        meta
    } = req.body;

    if (!title) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Title is required.',
            data: { status: 400 }
        });
    }

    // Check if user can publish
    let postStatus = status;
    if (status === 'publish' && !req.user.can('publish_posts')) {
        postStatus = 'pending';
    }

    const post = await Post.create({
        authorId: req.user.id,
        title: sanitizeHtml(title),
        content: sanitize(content),
        excerpt: sanitizeHtml(excerpt),
        status: postStatus,
        type,
        slug,
        parent,
        menuOrder: menu_order,
        commentStatus: comment_status
    });

    // Set categories
    if (categories && Array.isArray(categories)) {
        await Post.setTerms(post.id, categories, 'category');
    }

    // Set tags
    if (tags && Array.isArray(tags)) {
        await Post.setTerms(post.id, tags, 'post_tag');
    }

    // Set meta
    if (meta && typeof meta === 'object') {
        for (const [key, value] of Object.entries(meta)) {
            await Post.updateMeta(post.id, key, value);
        }
    }

    res.status(201).json(await (await Post.findById(post.id)).toJSON());
}));

/**
 * @swagger
 * /posts/{id}:
 *   put:
 *     summary: Update an existing post
 *     tags: [Posts]
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
 *               title:
 *                 type: string
 *               content:
 *                 type: string
 *               status:
 *                 type: string
 *     responses:
 *       200:
 *         description: Post updated
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Post not found
 */
router.put('/:id', authenticate, asyncHandler(async (req, res) => {
    const postId = parseInt(req.params.id, 10);
    const post = await Post.findById(postId);

    if (!post) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid post ID.',
            data: { status: 404 }
        });
    }

    // Check permissions
    const canEdit = post.authorId === req.user.id
        ? req.user.can('edit_posts')
        : req.user.can('edit_others_posts');

    if (!canEdit) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You cannot edit this post.',
            data: { status: 403 }
        });
    }

    const {
        title,
        content,
        excerpt,
        status,
        slug,
        parent,
        menu_order,
        comment_status,
        categories,
        tags,
        meta
    } = req.body;

    // Check if user can publish
    let postStatus = status;
    if (status === 'publish' && !req.user.can('publish_posts')) {
        postStatus = post.postStatus === 'publish' ? 'publish' : 'pending';
    }

    const updated = await Post.update(postId, {
        title: title ? sanitizeHtml(title) : undefined,
        content: content ? sanitize(content) : undefined,
        excerpt: excerpt ? sanitizeHtml(excerpt) : undefined,
        status: postStatus,
        slug,
        parent,
        menuOrder: menu_order,
        commentStatus: comment_status
    });

    // Update categories
    if (categories && Array.isArray(categories)) {
        await Post.setTerms(postId, categories, 'category');
    }

    // Update tags
    if (tags && Array.isArray(tags)) {
        await Post.setTerms(postId, tags, 'post_tag');
    }

    // Update meta
    if (meta && typeof meta === 'object') {
        for (const [key, value] of Object.entries(meta)) {
            await Post.updateMeta(postId, key, value);
        }
    }

    res.json(await (await Post.findById(postId)).toJSON());
}));

/**
 * @swagger
 * /posts/{id}:
 *   delete:
 *     summary: Delete a post
 *     tags: [Posts]
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
 *         description: Whether to bypass trash and force deletion
 *     responses:
 *       200:
 *         description: Post deleted
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Post not found
 */
router.delete('/:id', authenticate, asyncHandler(async (req, res) => {
    const postId = parseInt(req.params.id, 10);
    const post = await Post.findById(postId);

    if (!post) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid post ID.',
            data: { status: 404 }
        });
    }

    // Check permissions
    const canDelete = post.authorId === req.user.id
        ? req.user.can('delete_posts')
        : req.user.can('delete_others_posts');

    if (!canDelete) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You cannot delete this post.',
            data: { status: 403 }
        });
    }

    const force = req.query.force === 'true';
    await Post.delete(postId, force);

    if (force) {
        res.json({ deleted: true, previous: await post.toJSON() });
    } else {
        res.json(await (await Post.findById(postId)).toJSON());
    }
}));


/**
 * POST /posts/:id/meta
 * Update post meta
 */
router.post('/:id/meta', authenticate, asyncHandler(async (req, res) => {
    const postId = parseInt(req.params.id, 10);
    const post = await Post.findById(postId);

    if (!post) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid post ID.',
            data: { status: 404 }
        });
    }

    const { key, value } = req.body;

    if (!key) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Meta key is required.',
            data: { status: 400 }
        });
    }

    await Post.updateMeta(postId, key, value);

    res.json({
        key,
        value,
        post_id: postId
    });
}));

/**
 * GET /posts/:id/meta
 * Get all post meta
 */
router.get('/:id/meta', optionalAuth, asyncHandler(async (req, res) => {
    const postId = parseInt(req.params.id, 10);
    const post = await Post.findById(postId);

    if (!post) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid post ID.',
            data: { status: 404 }
        });
    }

    res.json(await Post.getAllMeta(postId));
}));

module.exports = router;
