/**
 * WordJS - Categories Routes
 * /api/v1/categories/*
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const Term = require('../models/Term');
const { recordAudit } = require('../core/audit');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { can } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
// THE SCALAR QUERY RULE — see core/query-params.
const { requireScalarQuery, requireRouteId } = require('../core/query-params');
const { perPageParam, pageOffset } = require('../core/pagination');

const TAXONOMY = 'category';

// THE ROUTE-ID CONTRACT — see core/query-params. `:id` is a term id, so `/categories/abc` used to
// reach Term.findById as NaN (Term.findById has no falsy short-circuit) and be bound into
// `WHERE t.term_id = ?`: a 404 on SQLite, a 500 on Postgres/MySQL, to an ANONYMOUS caller.
// Declared for the router, not per route, so the three routes below and any added later share it.
router.param('id', requireRouteId({ code: 'rest_term_invalid', message: 'Invalid category ID.' }));

/**
 * THE PARENT OF A CATEGORY must be 0 (top level) or an existing category, and never the category itself
 * or one of its descendants. Neither route checked: `parent: 999` stored a dangling id, and moving a
 * category under its own child made a loop that every hierarchy walk (the admin tree, breadcrumbs,
 * `getHierarchy`) followed. Returns the parsed id, or a refusal message.
 */
async function resolveParent(raw: unknown, termId: number | null): Promise<{ parent: number } | { problem: string }> {
    if (raw === undefined || raw === null || raw === '' || raw === 0 || raw === '0') return { parent: 0 };
    const parent = typeof raw === 'number' ? raw : /^\d+$/.test(String(raw)) ? parseInt(String(raw), 10) : NaN;
    if (!Number.isSafeInteger(parent) || parent < 0) return { problem: 'parent must be a category ID (0 for none).' };
    if (termId !== null && parent === termId) return { problem: 'A category cannot be its own parent.' };
    // Walk up from the proposed parent: it must exist, and the chain must not pass through this category.
    let cursor = parent;
    for (let depth = 0; cursor && depth < 100; depth++) {
        const node = await Term.findById(cursor, TAXONOMY);
        if (!node) return { problem: depth === 0 ? `Category ${parent} does not exist.` : 'The parent chain is broken.' };
        if (termId !== null && Number(node.termId) === termId) {
            return { problem: 'A category cannot be moved under one of its own subcategories.' };
        }
        cursor = Number(node.parent) || 0;
    }
    return { parent };
}

function parentRefusal(res: Response, message: string) {
    return res.status(400).json({ code: 'rest_term_invalid_parent', message, data: { status: 400 } });
}

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

    const limit = perPageParam(per_page, 100);
    const offset = pageOffset(page, limit);

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
 *         description: >-
 *           rest_missing_param (no name), rest_term_exists (the name or slug is taken) or
 *           rest_term_invalid_parent (parent is not an existing category).
 */
router.post('/', authenticate, can('manage_categories'), asyncHandler(async (req: Request, res: Response) => {
    const { name, slug, description, parent } = req.body;

    // Term.create strips markup from the name; a name that is ONLY markup is a missing name (400), not
    // a model error (500).
    if (!Term.sanitizeName(name)) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Category name is required.',
            data: { status: 400 }
        });
    }

    const resolved = await resolveParent(parent, null);
    if ('problem' in resolved) return parentRefusal(res, resolved.problem);

    try {
        const term = await Term.create({
            name,
            taxonomy: TAXONOMY,
            slug,
            description,
            parent: resolved.parent
        });

        await recordAudit(req.user.id, 'term.create', 'term', term.termId, { taxonomy: TAXONOMY });
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
 *       400:
 *         description: >-
 *           rest_term_exists (the name or slug is taken) or rest_term_invalid_parent (parent is not an
 *           existing category, is the category itself, or is one of its subcategories).
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

    let nextParent: number | undefined;
    if (parent !== undefined) {
        const resolved = await resolveParent(parent, termId);
        if ('problem' in resolved) return parentRefusal(res, resolved.problem);
        nextParent = resolved.parent;
    }

    let updated;
    try {
        updated = await Term.update(termId, TAXONOMY, {
            name,
            slug,
            description,
            parent: nextParent
        });
    } catch (error: any) {
        if (String(error && error.message).includes('already exists')) {
            return res.status(400).json({ code: 'rest_term_exists', message: error.message, data: { status: 400 } });
        }
        throw error;
    }

    await recordAudit(req.user.id, 'term.update', 'term', termId, { taxonomy: TAXONOMY });
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
    await recordAudit(req.user.id, 'term.delete', 'term', termId, { taxonomy: TAXONOMY, name: term.name, slug: term.slug });
    res.json({ deleted: true, previous: term.toJSON() });
}));

module.exports = router;
