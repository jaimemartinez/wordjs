/**
 * WordJS - Categories Routes
 * /api/v1/categories/*
 */

const express = require('express');
const router = express.Router();
const Term = require('../models/Term');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { can } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');

const TAXONOMY = 'category';

/**
 * GET /categories
 * List categories
 */
router.get('/', optionalAuth, asyncHandler(async (req, res) => {
    const {
        page = 1,
        per_page = 100,
        search,
        parent,
        hide_empty = false,
        orderby = 'name',
        order = 'asc'
    } = req.query;

    const limit = Math.min(parseInt(per_page, 10) || 100, 100);
    const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

    const terms = Term.findAll({
        taxonomy: TAXONOMY,
        parent: parent !== undefined ? parseInt(parent, 10) : undefined,
        hideEmpty: hide_empty === 'true',
        search,
        limit,
        offset,
        orderBy: orderby,
        order: order.toUpperCase()
    });

    const total = Term.count({ taxonomy: TAXONOMY, hideEmpty: hide_empty === 'true' });
    const totalPages = Math.ceil(total / limit);

    res.set('X-WP-Total', total);
    res.set('X-WP-TotalPages', totalPages);

    res.json(terms.map(term => term.toJSON()));
}));

/**
 * GET /categories/:id
 * Get single category
 */
router.get('/:id', optionalAuth, asyncHandler(async (req, res) => {
    const term = Term.findById(parseInt(req.params.id, 10), TAXONOMY);

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
 * POST /categories
 * Create category
 */
router.post('/', authenticate, can('manage_categories'), asyncHandler(async (req, res) => {
    const { name, slug, description, parent } = req.body;

    if (!name) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Category name is required.',
            data: { status: 400 }
        });
    }

    try {
        const term = Term.create({
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
 * PUT /categories/:id
 * Update category
 */
router.put('/:id', authenticate, can('manage_categories'), asyncHandler(async (req, res) => {
    const termId = parseInt(req.params.id, 10);
    const term = Term.findById(termId, TAXONOMY);

    if (!term) {
        return res.status(404).json({
            code: 'rest_term_invalid',
            message: 'Invalid category ID.',
            data: { status: 404 }
        });
    }

    const { name, slug, description, parent } = req.body;

    const updated = Term.update(termId, TAXONOMY, {
        name,
        slug,
        description,
        parent: parent !== undefined ? parseInt(parent, 10) : undefined
    });

    res.json(updated.toJSON());
}));

/**
 * DELETE /categories/:id
 * Delete category
 */
router.delete('/:id', authenticate, can('manage_categories'), asyncHandler(async (req, res) => {
    const termId = parseInt(req.params.id, 10);
    const term = Term.findById(termId, TAXONOMY);

    if (!term) {
        return res.status(404).json({
            code: 'rest_term_invalid',
            message: 'Invalid category ID.',
            data: { status: 404 }
        });
    }

    Term.delete(termId, TAXONOMY);
    res.json({ deleted: true, previous: term.toJSON() });
}));

module.exports = router;
