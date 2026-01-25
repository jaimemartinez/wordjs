/**
 * WordJS - Users Routes
 * /api/v1/users/*
 */

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { can, isAdmin, ownerOrCan } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * @swagger
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         username:
 *           type: string
 *         email:
 *           type: string
 *         displayName:
 *           type: string
 *         role:
 *           type: string
 *
 * /users:
 *   get:
 *     summary: Retrieve a list of users
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: per_page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: A list of users
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/User'
 */
router.get('/', authenticate, can('list_users'), asyncHandler(async (req, res) => {
    const {
        page = 1,
        per_page = 10,
        search,
        role,
        orderby = 'id',
        order = 'asc'
    } = req.query;

    const limit = Math.min(parseInt(per_page, 10) || 10, 100);
    const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

    // SECURITY: Whitelist allowed orderBy columns to prevent SQL injection
    const allowedOrderBy = ['id', 'user_login', 'display_name', 'user_email', 'user_registered'];
    const safeOrderBy = allowedOrderBy.includes(orderby) ? orderby : 'id';
    const safeOrder = ['asc', 'desc'].includes(order.toLowerCase()) ? order.toUpperCase() : 'ASC';

    const users = await User.findAll({
        search,
        role,
        limit,
        offset,
        orderBy: safeOrderBy,
        order: safeOrder
    });

    const total = await User.count({ search });
    const totalPages = Math.ceil(total / limit);

    res.set('X-WP-Total', total);
    res.set('X-WP-TotalPages', totalPages);

    res.json(users.map(user => user.toJSON()));
}));

/**
 * GET /users/me
 * Get current user
 */
router.get('/me', authenticate, (req, res) => {
    res.json(req.user.toJSON());
});

/**
 * GET /users/:id
 * Get single user
 */
router.get('/:id', authenticate, asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const user = await User.findById(userId);

    if (!user) {
        return res.status(404).json({
            code: 'rest_user_invalid_id',
            message: 'Invalid user ID.',
            data: { status: 404 }
        });
    }

    // Users can view themselves, admins can view anyone
    if (req.user.id !== userId && !req.user.can('list_users')) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You cannot view this user.',
            data: { status: 403 }
        });
    }

    res.json(user.toJSON());
}));

/**
 * POST /users
 * Create user (admin only)
 */
router.post('/', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const { username, email, password, displayName, role = 'subscriber' } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Username, email, and password are required.',
            data: { status: 400 }
        });
    }

    try {
        const user = await User.create({
            username,
            email,
            password,
            displayName,
            role
        });

        res.status(201).json(user.toJSON());
    } catch (error) {
        if (error.message.includes('already exists')) {
            return res.status(400).json({
                code: 'rest_user_exists',
                message: error.message,
                data: { status: 400 }
            });
        }
        throw error;
    }
}));

/**
 * PUT /users/:id
 * Update user
 */
router.put('/:id', authenticate, asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const user = await User.findById(userId);

    if (!user) {
        return res.status(404).json({
            code: 'rest_user_invalid_id',
            message: 'Invalid user ID.',
            data: { status: 404 }
        });
    }

    // Users can edit themselves, admins can edit anyone
    const isOwn = req.user.id === userId;
    if (!isOwn && !req.user.can('edit_users')) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You cannot edit this user.',
            data: { status: 403 }
        });
    }

    const { email, displayName, password, url, role } = req.body;

    // Only admins can change roles
    const updateData = { email, displayName, password, url };
    if (role && req.user.can('promote_users')) {
        updateData.role = role;
    }

    const updated = await User.update(userId, updateData);
    res.json(updated.toJSON());
}));

/**
 * DELETE /users/:id
 * Delete user (admin only)
 */
router.delete('/:id', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const user = await User.findById(userId);

    if (!user) {
        return res.status(404).json({
            code: 'rest_user_invalid_id',
            message: 'Invalid user ID.',
            data: { status: 404 }
        });
    }

    // Prevent deleting yourself
    if (req.user.id === userId) {
        return res.status(400).json({
            code: 'rest_user_cannot_delete',
            message: 'You cannot delete yourself.',
            data: { status: 400 }
        });
    }

    await User.delete(userId);
    res.json({ deleted: true, previous: user.toJSON() });
}));

/**
 * PUT /users/me
 * Update current user
 */
router.put('/me', authenticate, asyncHandler(async (req, res) => {
    const { email, displayName, password, url } = req.body;

    const updated = await User.update(req.user.id, {
        email,
        displayName,
        password,
        url
    });

    res.json(updated.toJSON());
}));

module.exports = router;
