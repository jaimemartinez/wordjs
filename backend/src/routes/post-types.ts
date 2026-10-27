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
const { authenticate, optionalAuth } = require('../middleware/auth');
const {
    capsFor, capsForType, isInternalPostType, readPolicyForType,
} = require('../core/post-capabilities');
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

/**
 * WHO MAY SEE A TYPE'S DEFINITION through the read routes below. A type whose published entries anyone
 * may read (not internal, declared publicly readable — readPolicyForType) is public, schema included:
 * the public site and headless clients render its entries. Any other type — an internal one, or one
 * declared non-public (a store of form submissions, members' records) — describes data the public never
 * sees, and its definition (fields, statuses, capability names) is shown only to who may edit its
 * entries: the type's edit or edit_others capability. To everyone else it does not exist (the list
 * leaves it out, the single routes answer 404).
 */
function canSeeTypeDefinition(user: any, name: string): boolean {
    if (!isInternalPostType(name) && readPolicyForType(name).publiclyReadable) return true;
    if (!user || typeof user.can !== 'function') return false;
    const caps = capsForType(name) || capsFor('post');
    return user.can(caps.edit) || user.can(caps.editOthers);
}

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
 *     description: Types whose entries are not public are listed only to callers who may edit their entries.
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
router.get('/', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
    requireScalarQuery(req.query, TYPE_LIST_QUERY_FIELDS);

    const showInRest = req.query.rest !== 'false';
    const types = getPostTypes({ showInRest }).filter((t: any) => canSeeTypeDefinition(req.user, t.name));

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
router.get('/schemas', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
    requireScalarQuery(req.query, TYPE_LIST_QUERY_FIELDS);

    const showInRest = req.query.rest !== 'false';
    res.json(getContentTypeSchemas({ showInRest }).filter((schema: any) => canSeeTypeDefinition(req.user, schema.name)));
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
 *         description: Content schema not found, or one whose entries are not public and this caller may not edit
 */
router.get('/:name/schema', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
    const schema = getContentTypeSchema(req.params.name);
    if (!schema || !canSeeTypeDefinition(req.user, schema.name)) return res.status(404).json({ error: 'Content schema not found' });
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
 *       404:
 *         description: Post type not found, or one whose entries are not public and this caller may not edit
 */
router.get('/:name', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
    const type = getPostType(req.params.name);

    if (!type || !canSeeTypeDefinition(req.user, type.name)) {
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
