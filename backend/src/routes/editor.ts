/**
 * WordJS - Editor extension routes
 * /api/v1/editor/*
 *
 * The fields plugins contribute to the post editor's settings (core/editor-fields): declared through the
 * `post_editor_fields` filter, validated by core, rendered and saved by the editor as ordinary post meta.
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { can } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { editorFieldsFor } = require('../core/editor-fields');

/**
 * @swagger
 * /editor/fields:
 *   get:
 *     summary: Post editor fields contributed by plugins
 *     description: The validated field declarations active plugins answer through the post_editor_fields filter, for one post type. Each field edits one unprefixed post meta key (select, radio or text); the editor seeds it from the entry's meta and saves it through the normal meta bag.
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           default: post
 *     responses:
 *       200:
 *         description: The fields for that post type
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Missing edit_posts
 */
router.get('/fields', authenticate, can('edit_posts'), asyncHandler(async (req: Request<Record<string, string>, unknown, unknown, { type?: string }>, res: Response) => {
    const raw = typeof req.query.type === 'string' ? req.query.type : 'post';
    const postType = /^[a-z][a-z0-9_-]{0,31}$/.test(raw) ? raw : 'post';
    res.json({ fields: await editorFieldsFor(postType) });
}));

module.exports = router;
