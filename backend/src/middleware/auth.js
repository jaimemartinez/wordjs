/**
 * WordJS - Authentication Middleware
 * JWT-based authentication
 */

const jwt = require('jsonwebtoken');
const config = require('../config/app');
const User = require('../models/User');

/**
 * Authenticate request with JWT token (Strict: Headers Only)
 */
function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    let token;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    }

    if (!token) {
        return res.status(401).json({
            code: 'rest_not_logged_in',
            message: 'You are not currently logged in.',
            data: { status: 401 }
        });
    }

    verifyAndAttachUser(token, req, res, next);
}

/**
 * Authenticate request (Loose: Headers OR Query Param)
 * Use ONLY for endpoints that require direct browser navigation (downloads)
 */
function authenticateAllowQuery(req, res, next) {
    const authHeader = req.headers.authorization;
    let token;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else if (req.query && req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({
            code: 'rest_not_logged_in',
            message: 'You are not currently logged in.',
            data: { status: 401 }
        });
    }

    verifyAndAttachUser(token, req, res, next);
}

// Helper to avoid duplication
function verifyAndAttachUser(token, req, res, next) {
    try {
        const decoded = jwt.verify(token, config.jwt.secret);
        const user = User.findById(decoded.userId);

        if (!user) {
            return res.status(401).json({
                code: 'rest_user_invalid',
                message: 'User not found.',
                data: { status: 401 }
            });
        }

        req.user = user;
        req.userId = user.id;
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                code: 'rest_token_expired',
                message: 'Token has expired.',
                data: { status: 401 }
            });
        }

        return res.status(401).json({
            code: 'rest_token_invalid',
            message: 'Invalid token.',
            data: { status: 401 }
        });
    }
}

/**
 * Optional authentication (doesn't fail if no token)
 */
function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        req.user = null;
        req.userId = null;
        return next();
    }

    const token = authHeader.substring(7);

    try {
        const decoded = jwt.verify(token, config.jwt.secret);
        const user = User.findById(decoded.userId);
        req.user = user;
        req.userId = user ? user.id : null;
    } catch {
        req.user = null;
        req.userId = null;
    }

    next();
}

/**
 * Generate JWT token for user
 */
function generateToken(user) {
    return jwt.sign(
        {
            userId: user.id,
            username: user.userLogin
        },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn }
    );
}

/**
 * Verify token and return decoded payload
 */
function verifyToken(token) {
    return jwt.verify(token, config.jwt.secret);
}

module.exports = {
    authenticate,
    authenticateAllowQuery,
    optionalAuth,
    generateToken,
    verifyToken
};
