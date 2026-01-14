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

/**
 * POST /auth/register
 * Register a new user
 */
router.post('/register', asyncHandler(async (req, res) => {
    // Check if registration is allowed
    const registrationAllowed = getOption('users_can_register', 0);
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

    // Optional: Add complexity check (Number or Special Char)
    // const complexityRegex = /(?=.*\d)|(?=.*[!@#$%^&*])/;
    // if (!complexityRegex.test(password)) { ... }
    // Keeping it simple but lengthier for now as requested.

    try {
        const defaultRole = getOption('default_role', 'subscriber');
        const user = await User.create({
            username,
            email,
            password,
            displayName: displayName || username,
            role: defaultRole
        });

        const token = generateToken(user);

        res.status(201).json({
            user: user.toJSON(),
            token
        });
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
 * POST /auth/login
 * Login user
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

        res.json({
            user: user.toJSON(),
            token
        });
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
    res.json({
        token,
        user: req.user.toJSON()
    });
});

module.exports = router;
