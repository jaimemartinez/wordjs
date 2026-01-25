/**
 * WordJS - Tags Routes
 * /api/v1/tags/*
 */

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
router.get('/', optionalAuth, asyncHandler(async (req, res) => {
    const {
        page = 1,
        per_page = 100,
        search,
        hide_empty = false,
        orderby = 'name',
        order = 'asc'
    } = req.query;

    const limit = Math.min(parseInt(per_page, 10) || 100, 100);
    const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

    const terms = await Term.findAll({
        taxonomy: TAXONOMY,
        hideEmpty: hide_empty === 'true',
        search,
        limit,
        offset,
        orderBy: orderby,
        order: order.toUpperCase()
    });

    const total = await Term.count({ taxonomy: TAXONOMY, hideEmpty: hide_empty === 'true' });
    const totalPages = Math.ceil(total / limit);

    res.set('X-WP-Total', total);
    res.set('X-WP-TotalPages', totalPages);

    res.json(terms.map(term => term.toJSON()));
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
router.get('/:id', optionalAuth, asyncHandler(async (req, res) => {
    const term = await Term.findById(parseInt(req.params.id, 10), TAXONOMY);

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
router.post('/', authenticate, can('manage_categories'), asyncHandler(async (req, res) => {
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
router.put('/:id', authenticate, can('manage_categories'), asyncHandler(async (req, res) => {
    const termId = parseInt(req.params.id, 10);
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
router.delete('/:id', authenticate, can('manage_categories'), asyncHandler(async (req, res) => {
    const termId = parseInt(req.params.id, 10);
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
