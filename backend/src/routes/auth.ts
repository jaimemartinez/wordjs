/**
 * WordJS - Auth Routes
 * /api/v1/auth/*
 */

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { authenticate, generateToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { getOption } = require('../core/options');
const config = require('../config/app');

// Cookie configuration for secure HttpOnly tokens
// Detect if site uses HTTPS from config
const siteUsesHttps = config.siteUrl?.startsWith('https://') || config.ssl?.enabled;
const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: siteUsesHttps, // Send over HTTPS if site uses it
    sameSite: 'lax', // Protect against CSRF while allowing normal navigation
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/'
};

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: User authentication and token management
 */

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, email, password]
 *             properties:
 *               username:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *                 minLength: 8
 *               displayName:
 *                 type: string
 *     responses:
 *       201:
 *         description: User created successfully
 *       400:
 *         description: Validation error or user exists
 */
router.post('/register', asyncHandler(async (req, res) => {
    // ... (rest of the function)
    const registrationAllowed = await getOption('users_can_register', 0);
    if (!registrationAllowed || registrationAllowed == '0') {
        return res.status(403).json({
            code: 'rest_cannot_register',
            message: 'User registration is currently disabled.',
            data: { status: 403 }
        });
    }

    const { username, email, password, displayName } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Username, email, and password are required.',
            data: { status: 400 }
        });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: 'Invalid email format.',
            data: { status: 400 }
        });
    }

    // Validate password strength
    if (password.length < 8) {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: 'Password must be at least 8 characters.',
            data: { status: 400 }
        });
    }

    if (password.length > 72) {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: 'Password must not exceed 72 characters.',
            data: { status: 400 }
        });
    }

    try {
        const defaultRole = await getOption('default_role', 'subscriber');
        const user = await User.create({
            username,
            email,
            password,
            displayName: displayName || username,
            role: defaultRole
        });

        const token = generateToken(user);
        res.cookie('wordjs_token', token, COOKIE_OPTIONS);

        res.status(201).json({ user: user.toJSON() });
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
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Login user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', asyncHandler(async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Username and password are required.',
            data: { status: 400 }
        });
    }

    try {
        const user = await User.authenticate(username, password);
        const token = generateToken(user);
        res.cookie('wordjs_token', token, COOKIE_OPTIONS);

        res.json({ user: user.toJSON() });
    } catch (error) {
        return res.status(401).json({
            code: 'rest_invalid_credentials',
            message: 'Invalid username or password.',
            data: { status: 401 }
        });
    }
}));

/**
 * GET /auth/me
 * Get current user
 */
router.get('/me', authenticate, (req, res) => {
    res.json(req.user.toJSON());
});

/**
 * POST /auth/validate
 * Validate token
 */
router.post('/validate', authenticate, (req, res) => {
    res.json({
        valid: true,
        user: req.user.toJSON()
    });
});

/**
 * POST /auth/refresh
 * Refresh token
 */
router.post('/refresh', authenticate, (req, res) => {
    const token = generateToken(req.user);

    // Update HttpOnly cookie
    res.cookie('wordjs_token', token, COOKIE_OPTIONS);

    res.json({
        user: req.user.toJSON()
    });
});

/**
 * POST /auth/logout
 * Clear auth cookie
 */
router.post('/logout', (req, res) => {
    res.clearCookie('wordjs_token', { path: '/' });
    res.json({ success: true, message: 'Logged out successfully' });
});

module.exports = router;
