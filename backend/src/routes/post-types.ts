/**
 * WordJS - Post Types Routes
 * /api/v1/types/*
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const {
    getPostTypes, getPostType, saveCustomPostType,
    deleteCustomPostType, postTypeExists,
    getContentTypeSchema, getContentTypeSchemas, saveContentTypeSchema,
} = require('../core/post-types');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
// THE SCALAR QUERY RULE — see core/query-params.
const { requireScalarQuery } = require('../core/query-params');

const CONTENT_TYPE_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * The one query parameter the two list routes read. `rest !== 'false'` is a comparison against a
 * string, and `?rest=false&rest=false` is the Array ['false','false'], which is `!== 'false'` — so a
 * repeat did not merely fail to filter, it INVERTED the answer: getPostTypes({showInRest:true})
 * returns the REST-visible types, the disjoint complement of the internal ones the caller asked for,
 * with a 200. Refused up front, in both handlers, so the two cannot drift apart.
 */
const TYPE_LIST_QUERY_FIELDS: readonly string[] = Object.freeze(['rest']);

function validLegacyList(value: unknown): boolean {
    return value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
}

/**
 * @swagger
 * tags:
 *   name: PostTypes
 *   description: Custom Post Type management
 */

/**
 * @swagger
 * /types:
 *   get:
 *     summary: List all post types
 *     tags: [PostTypes]
 *     parameters:
 *       - in: query
 *         name: rest
 *         schema:
 *           type: boolean
 *         description: Filter by rest visibility
 *     responses:
 *       200:
 *         description: List of post types
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
    requireScalarQuery(req.query, TYPE_LIST_QUERY_FIELDS);

    const showInRest = req.query.rest !== 'false';
    const types = getPostTypes({ showInRest });

    res.json(types.map((t: any) => ({
        name: t.name,
        label: t.label,
        labels: t.labels,
        description: t.description,
        public: t.public,
        hierarchical: t.hierarchical,
        hasArchive: t.hasArchive,
        supports: t.supports,
        taxonomies: t.taxonomies,
        menuIcon: t.menuIcon
    })));
}));

/**
 * @swagger
 * /types/schemas:
 *   get:
 *     summary: List portable F1 content schemas
 *     tags: [PostTypes]
 *     responses:
 *       200:
 *         description: Declarative content schemas
 */
router.get('/schemas', asyncHandler(async (req: Request, res: Response) => {
    requireScalarQuery(req.query, TYPE_LIST_QUERY_FIELDS);

    const showInRest = req.query.rest !== 'false';
    res.json(getContentTypeSchemas({ showInRest }));
}));

/**
 * @swagger
 * /types/{name}/schema:
 *   get:
 *     summary: Get the portable F1 schema for a content type
 *     tags: [PostTypes]
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Declarative content schema
 *       404:
 *         description: Content schema not found
 */
router.get('/:name/schema', asyncHandler(async (req: Request, res: Response) => {
    const schema = getContentTypeSchema(req.params.name);
    if (!schema) return res.status(404).json({ error: 'Content schema not found' });
    res.json(schema);
}));

/**
 * @swagger
 * /types/{name}:
 *   get:
 *     summary: Get a specific post type
 *     tags: [PostTypes]
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Post type details
 */
router.get('/:name', asyncHandler(async (req: Request, res: Response) => {
    const type = getPostType(req.params.name);

    if (!type) {
        return res.status(404).json({ error: 'Post type not found' });
    }

    res.json(type);
}));

/**
 * @swagger
 * /types:
 *   post:
 *     summary: Register a custom post type
 *     tags: [PostTypes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *               label:
 *                 type: string
 *               public:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Post type created
 */
router.post('/', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Body must be an object' });
    }
    const { name, label, labels, supports, taxonomies, ...options } = body;

    if (typeof name !== 'string' || !CONTENT_TYPE_NAME_RE.test(name)) {
        return res.status(400).json({
            error: 'Name must be a lowercase slug starting with a letter (a-z, 0-9, "-", "_"), max 32 chars'
        });
    }

    if (postTypeExists(name)) {
        return res.status(409).json({ error: 'Post type already exists' });
    }

    try {
        let type: unknown;
        if (body.schemaVersion !== undefined) {
            type = await saveContentTypeSchema(body);
        } else {
            if (labels !== undefined && (!labels || typeof labels !== 'object' || Array.isArray(labels))) {
                return res.status(400).json({ error: 'labels must be an object' });
            }
            if (!validLegacyList(supports)) return res.status(400).json({ error: 'supports must be an array of strings' });
            if (!validLegacyList(taxonomies)) return res.status(400).json({ error: 'taxonomies must be an array of strings' });
            type = await saveCustomPostType(name, {
                label: typeof label === 'string' && label ? label : name,
                labels,
                supports: supports || ['title', 'editor'],
                taxonomies: taxonomies || [],
                ...options
            });
        }

        res.status(201).json(type);
    } catch (error: any) {
        res.status(400).json({ error: error && error.message ? error.message : 'Invalid content schema' });
    }
}));

/**
 * @swagger
 * /types/{name}:
 *   delete:
 *     summary: Delete a custom post type
 *     tags: [PostTypes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Post type deleted
 */
router.delete('/:name', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const result = await deleteCustomPostType(req.params.name);

    if (!result) {
        return res.status(400).json({ error: 'Cannot delete this post type' });
    }

    res.json({ success: true });
}));

module.exports = router;
