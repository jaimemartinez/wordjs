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
 * @swagger
 * tags:
 *   name: Roles
 *   description: User Capability and Role management
 */

/**
 * @swagger
 * /roles:
 *   get:
 *     summary: List all roles
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Map of roles and capabilities
 */
router.get('/', authenticate, isAdmin, asyncHandler(async (req, res) => {
    res.json(getRoles());
}));

/**
 * @swagger
 * /roles/capabilities:
 *   get:
 *     summary: List all available system capabilities
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of capabilities
 */
router.get('/capabilities', authenticate, isAdmin, asyncHandler(async (req, res) => {
    res.json(getAllAvailableCapabilities());
}));

/**
 * @swagger
 * /roles/{slug}:
 *   get:
 *     summary: Get a single role
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Role details
 *       404:
 *         description: Role not found
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
 * @swagger
 * /roles:
 *   post:
 *     summary: Create or update a role
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [slug, name]
 *             properties:
 *               slug:
 *                 type: string
 *               name:
 *                 type: string
 *               capabilities:
 *                 type: object
 *     responses:
 *       201:
 *         description: Role saved
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
 * @swagger
 * /roles/{slug}:
 *   delete:
 *     summary: Delete a role
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Role deleted
 *       400:
 *         description: Cannot delete core roles
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
