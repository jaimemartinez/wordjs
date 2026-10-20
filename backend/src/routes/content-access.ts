/**
 * WordJS - Content access routes
 * /api/v1/content-access/*
 *
 * The editor side of core/content-access: which access levels the post editor may offer. The levels
 * come from whichever provider plugin answers the `content_access_levels` filter (the bundled
 * `memberships` plugin, for one); with none active the list is empty and the editor hides the field.
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { can } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { offeredLevels, ACCESS_META_KEY } = require('../core/content-access');

/**
 * @swagger
 * /content-access/levels:
 *   get:
 *     summary: Access levels the post editor can require
 *     description: The levels an active provider plugin offers through the content_access_levels filter. An entry stores its level in the `_wjs_access` post meta; empty means public. A viewer who does not hold the level (and does not manage the entry) receives the entry's teaser — content, excerpt and the page-builder tree cut at the access break — on every read surface.
 *     tags: [Posts]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The offered levels and the meta key that stores an entry's level
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Missing edit_posts
 */
router.get('/levels', authenticate, can('edit_posts'), asyncHandler(async (_req: Request, res: Response) => {
    res.json({ metaKey: ACCESS_META_KEY, levels: await offeredLevels() });
}));

module.exports = router;
