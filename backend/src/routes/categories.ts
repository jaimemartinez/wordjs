/**
 * WordJS - Categories Routes
 * /api/v1/categories/*
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const Term = require('../models/Term');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { can } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
// THE SCALAR QUERY RULE — see core/query-params.
const { requireScalarQuery, requireRouteId } = require('../core/query-params');

const TAXONOMY = 'category';

// THE ROUTE-ID CONTRACT — see core/query-params. `:id` is a term id, so `/categories/abc` used to
// reach Term.findById as NaN (Term.findById has no falsy short-circuit) and be bound into
// `WHERE t.term_id = ?`: a 404 on SQLite, a 500 on Postgres/MySQL, to an ANONYMOUS caller.
// Declared for the router, not per route, so the three routes below and any added later share it.
router.param('id', requireRouteId({ code: 'rest_term_invalid', message: 'Invalid category ID.' }));

/**
 * Every query parameter GET /categories reads, each a scalar in this API's contract. Twin of
 * TAG_LIST_QUERY_FIELDS in routes/tags.ts — `parent` is the one extra field this taxonomy takes, and
 * `hide_empty` is the flag a repeat used to switch off silently.
 */
const CATEGORY_LIST_QUERY_FIELDS: readonly string[] = Object.freeze([
    'page', 'per_page', 'search', 'parent', 'hide_empty', 'orderby', 'order',
]);

/**
 * @swagger
 * tags:
 *   name: Categories
 *   description: Category management
 */

/**
 * @swagger
 * /categories:
 *   get:
 *     summary: List categories
 *     tags: [Categories]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of categories
 */
router.get('/', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
    // Refuse a repeated scalar before anything reads it, so every comparison below is a string
    // comparison and both `hide_empty === 'true'` sites answer the same thing.
    requireScalarQuery(req.query, CATEGORY_LIST_QUERY_FIELDS);

    const {
        page = 1,
        per_page = 100,
        search,
        parent,
        hide_empty = false,
        orderby = 'name',
        order = 'asc'
    } = req.query;

    const limit = Math.min(parseInt(String(per_page), 10) || 100, 100);
    const offset = (Math.max(parseInt(String(page), 10) || 1, 1) - 1) * limit;

    const terms = await Term.findAll({
        taxonomy: TAXONOMY,
        parent: parent !== undefined ? parseInt(String(parent), 10) : undefined,
        hideEmpty: hide_empty === 'true',
        search,
        limit,
        offset,
        orderBy: orderby,
        order: ['asc', 'desc'].includes(String(order).toLowerCase()) ? String(order).toUpperCase() : 'ASC'
    });

    const total = await Term.count({
        taxonomy: TAXONOMY,
        hideEmpty: hide_empty === 'true',
        parent: parent !== undefined ? parseInt(String(parent), 10) : undefined,
        search
    });
    const totalPages = Math.ceil(total / limit);

    res.set('X-WP-Total', String(total));
    res.set('X-WP-TotalPages', String(totalPages));

    res.json(terms.map((term: any) => term.toJSON()));
}));

/**
 * @swagger
 * /categories/{id}:
 *   get:
 *     summary: Get a category
 *     tags: [Categories]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Category details
 *       404:
 *         description: Category not found
 */
router.get('/:id', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
    const term = await Term.findById(parseInt(String(req.params.id), 10), TAXONOMY);

    if (!term) {
        return res.status(404).json({
            code: 'rest_term_invalid',
            message: 'Invalid category ID.',
            data: { status: 404 }
        });
    }

    res.json(term.toJSON());
}));

/**
 * @swagger
 * /categories:
 *   post:
 *     summary: Create a category
 *     tags: [Categories]
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
 *               slug:
 *                 type: string
 *               description:
 *                 type: string
 *               parent:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Category created
 *       400:
 *         description: Validation error
 */
router.post('/', authenticate, can('manage_categories'), asyncHandler(async (req: Request, res: Response) => {
    const { name, slug, description, parent } = req.body;

    if (!name) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Category name is required.',
            data: { status: 400 }
        });
    }

    try {
        const term = await Term.create({
            name,
            taxonomy: TAXONOMY,
            slug,
            description,
            parent: parent ? parseInt(parent, 10) : 0
        });

        res.status(201).json(term.toJSON());
    } catch (error) {
        if (error.message.includes('already exists')) {
            return res.status(400).json({
                code: 'rest_term_exists',
                message: error.message,
                data: { status: 400 }
            });
        }
        throw error;
    }
}));

/**
 * @swagger
 * /categories/{id}:
 *   put:
 *     summary: Update a category
 *     tags: [Categories]
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
 *               name:
 *                 type: string
 *               slug:
 *                 type: string
 *               description:
 *                 type: string
 *               parent:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Category updated
 *       404:
 *         description: Category not found
 */
router.put('/:id', authenticate, can('manage_categories'), asyncHandler(async (req: Request, res: Response) => {
    const termId = parseInt(String(req.params.id), 10);
    const term = await Term.findById(termId, TAXONOMY);

    if (!term) {
        return res.status(404).json({
            code: 'rest_term_invalid',
            message: 'Invalid category ID.',
            data: { status: 404 }
        });
    }

    const { name, slug, description, parent } = req.body;

    const updated = await Term.update(termId, TAXONOMY, {
        name,
        slug,
        description,
        parent: parent !== undefined ? parseInt(parent, 10) : undefined
    });

    res.json(updated.toJSON());
}));

/**
 * @swagger
 * /categories/{id}:
 *   delete:
 *     summary: Delete a category
 *     tags: [Categories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Category deleted
 *       404:
 *         description: Category not found
 */
router.delete('/:id', authenticate, can('manage_categories'), asyncHandler(async (req: Request, res: Response) => {
    const termId = parseInt(String(req.params.id), 10);
    const term = await Term.findById(termId, TAXONOMY);

    if (!term) {
        return res.status(404).json({
            code: 'rest_term_invalid',
            message: 'Invalid category ID.',
            data: { status: 404 }
        });
    }

    await Term.delete(termId, TAXONOMY);
    res.json({ deleted: true, previous: term.toJSON() });
}));

module.exports = router;
