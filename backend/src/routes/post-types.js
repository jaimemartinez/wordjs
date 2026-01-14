/**
 * WordJS - Post Types Routes
 * /api/v1/types/*
 */

const express = require('express');
const router = express.Router();
const {
    getPostTypes, getPostType, saveCustomPostType,
    deleteCustomPostType, postTypeExists
} = require('../core/post-types');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /types
 * List all post types
 */
router.get('/', asyncHandler(async (req, res) => {
    const showInRest = req.query.rest !== 'false';
    const types = getPostTypes({ showInRest });

    res.json(types.map(t => ({
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
 * GET /types/:name
 * Get a specific post type
 */
router.get('/:name', asyncHandler(async (req, res) => {
    const type = getPostType(req.params.name);

    if (!type) {
        return res.status(404).json({ error: 'Post type not found' });
    }

    res.json(type);
}));

/**
 * POST /types
 * Create a custom post type
 */
router.post('/', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const { name, label, labels, supports, taxonomies, ...options } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Name is required' });
    }

    if (postTypeExists(name)) {
        return res.status(409).json({ error: 'Post type already exists' });
    }

    const type = saveCustomPostType(name, {
        label: label || name,
        labels,
        supports: supports || ['title', 'editor'],
        taxonomies: taxonomies || [],
        ...options
    });

    res.status(201).json(type);
}));

/**
 * DELETE /types/:name
 * Delete a custom post type
 */
router.delete('/:name', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const result = deleteCustomPostType(req.params.name);

    if (!result) {
        return res.status(400).json({ error: 'Cannot delete this post type' });
    }

    res.json({ success: true });
}));

module.exports = router;
