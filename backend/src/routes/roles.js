/**
 * WordJS - Roles Routes
 * /api/v1/roles/*
 */

const express = require('express');
const router = express.Router();
const { getRoles, setRole, getRole, removeRole, getAllAvailableCapabilities } = require('../core/roles');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /roles
 * List all roles
 */
router.get('/', authenticate, isAdmin, asyncHandler(async (req, res) => {
    res.json(getRoles());
}));

/**
 * GET /roles/capabilities
 * List all available capabilities
 */
router.get('/capabilities', authenticate, isAdmin, asyncHandler(async (req, res) => {
    res.json(getAllAvailableCapabilities());
}));

/**
 * GET /roles/:slug
 * Get single role
 */
router.get('/:slug', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const role = getRole(req.params.slug);
    if (!role) {
        return res.status(404).json({
            code: 'rest_role_invalid_id',
            message: 'Invalid role slug.',
            data: { status: 404 }
        });
    }
    res.json(role);
}));

/**
 * POST /roles
 * Create or update a role
 */
router.post('/', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const { slug, name, capabilities } = req.body;

    if (!slug || !name) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Role slug and name are required.',
            data: { status: 400 }
        });
    }

    setRole(slug, { name, capabilities });
    res.status(201).json(getRole(slug));
}));

/**
 * DELETE /roles/:slug
 * Delete a role
 */
router.delete('/:slug', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const slug = req.params.slug;

    // Prevent deleting core roles
    const coreRoles = ['administrator', 'editor', 'author', 'contributor', 'subscriber'];
    if (coreRoles.includes(slug)) {
        return res.status(400).json({
            code: 'rest_role_protected',
            message: 'Core roles cannot be deleted.',
            data: { status: 400 }
        });
    }

    const removed = removeRole(slug);
    if (!removed) {
        return res.status(404).json({
            code: 'rest_role_invalid_id',
            message: 'Role not found.',
            data: { status: 404 }
        });
    }

    res.json({ deleted: true, slug });
}));

module.exports = router;
