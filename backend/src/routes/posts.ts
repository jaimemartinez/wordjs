/**
 * WordJS - Posts Routes
 * /api/v1/posts/*
 */

import type { Response } from 'express';

const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { can, ownerOrCan } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { saveRevision } = require('../core/revisions');
const sanitizeHtml = require('sanitize-html');

// The Puck/meta sanitizer (sanitize, sanitizePuckTree, sanitizeMetaValue, PUCK_*_FIELDS) lives in a
// shared core module so non-route write paths (e.g. the WXR importer) sanitize meta through the EXACT
// same code instead of bypassing it. Behavior here is unchanged — these are the same functions that
// previously lived inline in this file.
const { sanitize, sanitizeMetaValue } = require('../core/sanitize-meta');

// Resolve the capability family for a post type (post → edit_posts, page → edit_pages, custom →
// edit_<type>s) so an author holding only POST caps cannot create/edit/publish/delete PAGES.
// Pure capability-name builder for a capability_type family. NEVER null — used as the guaranteed
// fallback for an EXISTING post whose registered type may since have been removed.
function capsFor(c: string) {
    return {
        edit: `edit_${c}s`, publish: `publish_${c}s`, del: `delete_${c}s`,
        editPublished: `edit_published_${c}s`, deletePublished: `delete_published_${c}s`,
        editOthers: `edit_others_${c}s`, deleteOthers: `delete_others_${c}s`,
    };
}
// Returns null for an UNREGISTERED type so the CREATE path can reject it (400). Callers editing an
// existing post fall back to capsFor('post') instead of relying on this nullable result.
function capsForType(type: string) {
    const { getPostType } = require('../core/post-types');
    const pt = getPostType(String(type || 'post'));
    if (!pt) return null;
    return capsFor(pt.capability_type || 'post');
}

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
router.get('/', optionalAuth, asyncHandler(async (req: any, res: Response) => {
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
    const orderByMap: Record<string, string> = {
        date: 'post_date',
        modified: 'post_modified',
        title: 'post_title',
        id: 'id',
        menu_order: 'menu_order'
    };

    // Determine which statuses to show
    let includeStatuses: string[] | null = null;
    // SECURITY (BOLA): the per-post GET enforces an author/edit_others_posts gate on non-published
    // posts; the LIST path must do the same or it leaks every user's drafts/pending/private content.
    // A privileged caller (edit_others_posts / read_private_posts) may see others' unpublished posts;
    // an unprivileged logged-in user may only see THEIR OWN non-published posts, so we force the author
    // filter to their id whenever non-publish statuses are requested.
    let authorFilter = author ? parseInt(author, 10) : undefined;
    let effectiveStatus = status;
    if (req.user) {
        const isPrivileged = req.user.can('edit_others_posts') || req.user.can('read_private_posts');
        // Logged in users can see their own drafts
        if (status === 'any') {
            includeStatuses = ['publish', 'draft', 'pending', 'private'];
            if (!isPrivileged) {
                // Scope the unpublished content to the requesting user only.
                authorFilter = req.user.id;
            }
        } else if (status !== 'publish' && !isPrivileged) {
            // Asking for a specific non-publish status (draft/pending/private) without privilege:
            // only the caller's own posts of that status may be returned.
            authorFilter = req.user.id;
        }
    } else if (status !== 'publish') {
        // Anonymous callers may only ever list published content, regardless of requested status.
        effectiveStatus = 'publish';
    }

    // Use findAllWithRelations to batch-load post meta (avoids N+1 in the list path).
    const posts = await Post.findAllWithRelations({
        type,
        status: includeStatuses ? null : effectiveStatus,
        includeStatuses,
        author: authorFilter,
        search,
        limit,
        offset,
        orderBy: orderByMap[orderby] || 'post_date',
        // SECURITY: Whitelist order direction to prevent injection
        order: ['asc', 'desc'].includes(order.toLowerCase()) ? order.toUpperCase() : 'DESC'
    });

    const total = await Post.count({
        type,
        status: includeStatuses ? null : effectiveStatus,
        includeStatuses,
        author: authorFilter,
        search
    });
    const totalPages = Math.ceil(total / limit);

    res.set('X-WP-Total', total);
    res.set('X-WP-TotalPages', totalPages as any);

    res.json(await Promise.all(posts.map((post: any) => post.toJSON())));
}));

/**
 * GET /posts/slug/:slug
 * Get single post by slug
 */
router.get('/slug/:slug', optionalAuth, asyncHandler(async (req: any, res: Response) => {
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
router.get('/:id', optionalAuth, asyncHandler(async (req: any, res: Response) => {
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
router.post('/', authenticate, asyncHandler(async (req: any, res: Response) => {
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

    // Type-aware capability gate: an unknown type is rejected, and the caller must hold the EDIT cap for
    // THIS type's family (a post-only author cannot create a page). The old route gate was can('edit_posts')
    // regardless of type, and the publish check below only tested publish_posts (audit HIGH).
    const caps = capsForType(type);
    if (!caps) {
        return res.status(400).json({ code: 'rest_invalid_post_type', message: `Invalid post type '${type}'.`, data: { status: 400 } });
    }
    if (!req.user.can(caps.edit)) {
        return res.status(403).json({ code: 'rest_cannot_create', message: `You are not allowed to create content of type '${type}'.`, data: { status: 403 } });
    }

    // Check if user can publish THIS type; if not, downgrade to pending (needs review).
    let postStatus = status;
    if (status === 'publish' && !req.user.can(caps.publish)) {
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
            // SECURITY: sanitize HTML/URL-bearing meta (e.g. _puck_data) so a malicious block can't
            // store XSS that the public site later renders.
            await Post.updateMeta(post.id, key, sanitizeMetaValue(key, value));
        }
    }

    // Save initial revision
    saveRevision(post.id).catch((err: any) => console.error('Failed to save initial revision:', err));

    res.status(201).json(await post.toJSON());
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
router.put('/:id', authenticate, asyncHandler(async (req: any, res: Response) => {
    const postId = parseInt(req.params.id, 10);
    const post = await Post.findById(postId);

    if (!post) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid post ID.',
            data: { status: 404 }
        });
    }

    // Type-aware permissions: post.type picks the capability family (a post-only author must not edit a
    // page). Editing an ALREADY-PUBLISHED post additionally requires edit_published_<type>s — a contributor
    // could otherwise rewrite or unpublish their own editor-published post via plain edit_posts (audit LOW).
    const pcaps = capsForType(post.type || post.postType || 'post') || capsFor('post');
    const isOwn = post.authorId === req.user.id;
    let canEdit = isOwn ? req.user.can(pcaps.edit) : req.user.can(pcaps.editOthers);
    if (post.postStatus === 'publish' && !req.user.can(pcaps.editPublished)) canEdit = false;

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
        meta,
        autosave
    } = req.body;

    // Check if user can publish THIS type
    let postStatus = status;
    if (status === 'publish' && !req.user.can(pcaps.publish)) {
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
            // SECURITY: sanitize HTML/URL-bearing meta (e.g. _puck_data) on write — see sanitizeMetaValue.
            await Post.updateMeta(postId, key, sanitizeMetaValue(key, value));
        }
    }

    // Save revision after ALL updates (including meta) are done. Editor autosaves skip this so a
    // background save every few seconds doesn't churn through the revision cap (default 10) and
    // wipe the user's meaningful history — explicit saves still snapshot as before.
    if (autosave !== true) {
        saveRevision(postId).catch((err: any) => console.error('Failed to save revision:', err));
    }

    const fresh = await Post.findById(postId);
    if (!fresh) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid post ID.',
            data: { status: 404 }
        });
    }
    res.json(await fresh.toJSON());
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
router.delete('/:id', authenticate, asyncHandler(async (req: any, res: Response) => {
    const postId = parseInt(req.params.id, 10);
    const post = await Post.findById(postId);

    if (!post) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid post ID.',
            data: { status: 404 }
        });
    }

    // Type-aware permissions: post.type picks the capability family, and deleting an already-published
    // post additionally requires delete_published_<type>s (mirrors the edit gate).
    const dcaps = capsForType(post.type || post.postType || 'post') || capsFor('post');
    let canDelete = post.authorId === req.user.id
        ? req.user.can(dcaps.del)
        : req.user.can(dcaps.deleteOthers);
    if (post.postStatus === 'publish' && !req.user.can(dcaps.deletePublished)) canDelete = false;

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
        const fresh = await Post.findById(postId);
        if (!fresh) {
            return res.status(404).json({
                code: 'rest_post_invalid_id',
                message: 'Invalid post ID.',
                data: { status: 404 }
            });
        }
        res.json(await fresh.toJSON());
    }
}));


/**
 * POST /posts/:id/meta
 * Update post meta
 */
router.post('/:id/meta', authenticate, asyncHandler(async (req: any, res: Response) => {
    const postId = parseInt(req.params.id, 10);
    const post = await Post.findById(postId);

    if (!post) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid post ID.',
            data: { status: 404 }
        });
    }

    // SECURITY: Ownership check (prevents IDOR). This route was gated by authenticate only,
    // letting any logged-in user write arbitrary meta on ANY post. Mirror the PUT /posts/:id type-aware gate.
    const mcaps = capsForType(post.type || post.postType || 'post') || capsFor('post');
    const canEdit = post.authorId === req.user.id
        ? req.user.can(mcaps.edit)
        : req.user.can(mcaps.editOthers);

    if (!canEdit) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You cannot edit this post.',
            data: { status: 403 }
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

    // SECURITY: sanitize HTML/URL-bearing meta (e.g. _puck_data) on write — see sanitizeMetaValue.
    const safeValue = sanitizeMetaValue(key, value);
    await Post.updateMeta(postId, key, safeValue);

    res.json({
        key,
        value: safeValue,
        post_id: postId
    });
}));

/**
 * GET /posts/:id/meta
 * Get all post meta
 */
router.get('/:id/meta', optionalAuth, asyncHandler(async (req: any, res: Response) => {
    const postId = parseInt(req.params.id, 10);
    const post = await Post.findById(postId);

    if (!post) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid post ID.',
            data: { status: 404 }
        });
    }

    // SECURITY (IDOR): mirror the single-post read gate. Without this, anyone could read the full meta
    // map (SEO drafts, internal notes, plugin-stashed data, _wp_trash_meta_status, etc.) of draft/
    // private/pending/trashed posts, or other users' content.
    if (post.postStatus !== 'publish') {
        if (!req.user || (post.authorId !== req.user.id && !req.user.can('edit_others_posts'))) {
            return res.status(404).json({
                code: 'rest_post_invalid_id',
                message: 'Invalid post ID.',
                data: { status: 404 }
            });
        }
    }

    res.json(await Post.getAllMeta(postId));
}));

module.exports = router;
