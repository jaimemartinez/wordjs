/**
 * WordJS - Taxonomy Routes
 * /api/v1/taxonomies/*
 *
 * The write half of the taxonomy registry (the read half is the in-memory registry seeded by
 * initTaxonomies()). Mirrors routes/post-types.ts: public reads, admin-only writes, and writes
 * go through saveCustomTaxonomy()/deleteCustomTaxonomy() so they survive a restart.
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const {
    getTaxonomies, getTaxonomy, saveCustomTaxonomy,
    deleteCustomTaxonomy, taxonomyExists
} = require('../core/post-types');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
// THE SCALAR QUERY RULE — see core/query-params.
const { requireScalarQuery } = require('../core/query-params');

/**
 * The two query parameters the list route reads. Same defect and same fix as routes/post-types.ts:
 * `rest !== 'false'` is a comparison against a string, so `?rest=false&rest=false` arrives as an
 * Array, compares unequal, and answers with the REST-VISIBLE taxonomies — the opposite set from the
 * one asked for. `postType` is declared here too because it is read in the same handler; it already
 * narrows itself with a typeof check, and declaring it makes the two parameters answer a polluted
 * URL the same way instead of one 400 and one silent pass.
 */
const TAXONOMY_LIST_QUERY_FIELDS: readonly string[] = Object.freeze(['rest', 'postType']);

// Taxonomy names are WordPress-style keys: lowercase slug, required to START alphanumeric
// (which also keeps object-plumbing names like '__proto__' out of the persisted map), capped
// at 32 chars like WP's taxonomy key limit.
const TAXONOMY_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * @swagger
 * tags:
 *   name: Taxonomies
 *   description: Custom taxonomy management
 */

/**
 * @swagger
 * /taxonomies:
 *   get:
 *     summary: List all taxonomies
 *     tags: [Taxonomies]
 *     parameters:
 *       - in: query
 *         name: rest
 *         schema:
 *           type: boolean
 *         description: Filter by rest visibility
 *       - in: query
 *         name: postType
 *         schema:
 *           type: string
 *         description: Only taxonomies attached to this post type
 *     responses:
 *       200:
 *         description: List of taxonomies
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
    requireScalarQuery(req.query, TAXONOMY_LIST_QUERY_FIELDS);

    const showInRest = req.query.rest !== 'false';
    const filter: Record<string, any> = { showInRest };
    // Optional ?postType=book narrows to the taxonomies attached to one post type
    // (WP: get_object_taxonomies).
    if (typeof req.query.postType === 'string' && req.query.postType) {
        filter.postType = req.query.postType;
    }
    const taxonomies = getTaxonomies(filter);

    res.json(taxonomies.map((t: any) => ({
        name: t.name,
        label: t.label,
        labels: t.labels,
        description: t.description,
        public: t.public,
        hierarchical: t.hierarchical,
        postTypes: t.postTypes,
        rewrite: t.rewrite
    })));
}));

/**
 * @swagger
 * /taxonomies/{name}:
 *   get:
 *     summary: Get a specific taxonomy
 *     tags: [Taxonomies]
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Taxonomy details
 */
router.get('/:name', asyncHandler(async (req: Request, res: Response) => {
    const taxonomy = getTaxonomy(req.params.name);

    if (!taxonomy) {
        return res.status(404).json({ error: 'Taxonomy not found' });
    }

    res.json(taxonomy);
}));

/**
 * @swagger
 * /taxonomies:
 *   post:
 *     summary: Register a custom taxonomy
 *     tags: [Taxonomies]
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
 *               hierarchical:
 *                 type: boolean
 *               postTypes:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       201:
 *         description: Taxonomy created
 */
router.post('/', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const { name, label, labels, postTypes, ...options } = req.body || {};

    if (!name) {
        return res.status(400).json({ error: 'Name is required' });
    }
    if (typeof name !== 'string' || !TAXONOMY_NAME_RE.test(name)) {
        return res.status(400).json({
            error: 'Taxonomy name must be a lowercase slug (a-z, 0-9, "-", "_"), start with a letter or digit, max 32 chars'
        });
    }
    if (labels !== undefined && (labels === null || typeof labels !== 'object' || Array.isArray(labels))) {
        return res.status(400).json({ error: 'labels must be an object' });
    }
    const postTypesOk = postTypes === undefined
        || typeof postTypes === 'string'
        || (Array.isArray(postTypes) && postTypes.every((p: any) => typeof p === 'string'));
    if (!postTypesOk) {
        return res.status(400).json({ error: 'postTypes must be a string or an array of strings' });
    }

    if (taxonomyExists(name)) {
        return res.status(409).json({ error: 'Taxonomy already exists' });
    }

    const taxonomy = await saveCustomTaxonomy(name, {
        label: label || name,
        labels,
        postTypes: postTypes || [],
        ...options
    });

    res.status(201).json(taxonomy);
}));

/**
 * @swagger
 * /taxonomies/{name}:
 *   delete:
 *     summary: Delete a custom taxonomy
 *     tags: [Taxonomies]
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
 *         description: Taxonomy deleted
 */
router.delete('/:name', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const result = await deleteCustomTaxonomy(req.params.name);

    if (!result) {
        return res.status(400).json({ error: 'Cannot delete this taxonomy' });
    }

    res.json({ success: true });
}));

module.exports = router;
