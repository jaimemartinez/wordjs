/**
 * WordJS - Tags Routes
 * /api/v1/tags/*
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const Term = require('../models/Term');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { can } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');

const TAXONOMY = 'post_tag';

/**
 * @swagger
 * tags:
 *   name: Tags
 *   description: Tag management
 */

/**
 * @swagger
 * /tags:
 *   get:
 *     summary: List tags
 *     tags: [Tags]
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
 *         description: List of tags
 */
router.get('/', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
    const {
        page = 1,
        per_page = 100,
        search,
        hide_empty = false,
        orderby = 'name',
        order = 'asc'
    } = req.query;

    // A query value is `string | string[] | ParsedQs | ParsedQs[]`, never guaranteed to be a string.
    // parseInt() begins by applying ToString to its argument, so String(x) here reproduces the old
    // untyped path EXACTLY for every shape: '3' -> 3, ['3','4'] -> parseInt('3,4') -> 3, an object ->
    // parseInt('[object Object]') -> NaN -> the `||` default.
    const limit = Math.min(parseInt(String(per_page), 10) || 100, 100);
    const offset = (Math.max(parseInt(String(page), 10) || 1, 1) - 1) * limit;

    const terms = await Term.findAll({
        taxonomy: TAXONOMY,
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
        search
    });
    const totalPages = Math.ceil(total / limit);

    res.set('X-WP-Total', total);
    res.set('X-WP-TotalPages', totalPages as any);

    res.json(terms.map((term: any) => term.toJSON()));
}));

/**
 * @swagger
 * /tags/{id}:
 *   get:
 *     summary: Get a tag
 *     tags: [Tags]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Tag details
 *       404:
 *         description: Tag not found
 */
router.get('/:id', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
    // `req.params.id` is typed `string | string[]`, so it needs a narrowing before parseInt(). String()
    // is the one that changes nothing: parseInt() already applies ToString to its argument, so this is
    // the exact value the previous untyped call parsed, for a string AND for the array shape.
    const term = await Term.findById(parseInt(String(req.params.id), 10), TAXONOMY);

    if (!term) {
        return res.status(404).json({
            code: 'rest_term_invalid',
            message: 'Invalid tag ID.',
            data: { status: 404 }
        });
    }

    res.json(term.toJSON());
}));

/**
 * @swagger
 * /tags:
 *   post:
 *     summary: Create a tag
 *     tags: [Tags]
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
 *     responses:
 *       201:
 *         description: Tag created
 *       400:
 *         description: Validation error
 */
router.post('/', authenticate, can('manage_categories'), asyncHandler(async (req: Request, res: Response) => {
    const { name, slug, description } = req.body;

    if (!name) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Tag name is required.',
            data: { status: 400 }
        });
    }

    try {
        const term = await Term.create({
            name,
            taxonomy: TAXONOMY,
            slug,
            description
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
 * /tags/{id}:
 *   put:
 *     summary: Update a tag
 *     tags: [Tags]
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
 *     responses:
 *       200:
 *         description: Tag updated
 *       404:
 *         description: Tag not found
 */
router.put('/:id', authenticate, can('manage_categories'), asyncHandler(async (req: Request, res: Response) => {
    const termId = parseInt(String(req.params.id), 10);
    const term = await Term.findById(termId, TAXONOMY);

    if (!term) {
        return res.status(404).json({
            code: 'rest_term_invalid',
            message: 'Invalid tag ID.',
            data: { status: 404 }
        });
    }

    const { name, slug, description } = req.body;

    const updated = await Term.update(termId, TAXONOMY, {
        name,
        slug,
        description
    });

    res.json(updated.toJSON());
}));

/**
 * @swagger
 * /tags/{id}:
 *   delete:
 *     summary: Delete a tag
 *     tags: [Tags]
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
 *         description: Tag deleted
 *       404:
 *         description: Tag not found
 */
router.delete('/:id', authenticate, can('manage_categories'), asyncHandler(async (req: Request, res: Response) => {
    const termId = parseInt(String(req.params.id), 10);
    const term = await Term.findById(termId, TAXONOMY);

    if (!term) {
        return res.status(404).json({
            code: 'rest_term_invalid',
            message: 'Invalid tag ID.',
            data: { status: 404 }
        });
    }

    await Term.delete(termId, TAXONOMY);
    res.json({ deleted: true, previous: term.toJSON() });
}));

module.exports = router;
