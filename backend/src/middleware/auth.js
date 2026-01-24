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
// Helper to avoid duplication
async function verifyAndAttachUser(token, req, res, next) {
    try {
        const decoded = jwt.verify(token, config.jwt.secret);
        const user = await User.findById(decoded.userId);

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
 * Authenticate request with JWT token (Strict: Headers Only, with Cookie fallback)
 */
async function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    let token;

    // Priority 1: Authorization header (for API clients)
    // Check for 'null' or 'undefined' string which can happen if frontend sends localStorage.getItem('token') without check
    if (authHeader && authHeader.startsWith('Bearer ') && authHeader !== 'Bearer null' && authHeader !== 'Bearer undefined') {
        token = authHeader.substring(7);
    }

    // Priority 2: HttpOnly cookie (for browser clients)
    if (!token && req.cookies && req.cookies.wordjs_token) {
        token = req.cookies.wordjs_token;
    }

    if (!token) {
        return res.status(401).json({
            code: 'rest_not_logged_in',
            message: 'You are not currently logged in.',
            data: { status: 401 }
        });
    }

    await verifyAndAttachUser(token, req, res, next);
}

/**
 * Authenticate request (Loose: Headers OR Query Param)
 * Use ONLY for endpoints that require direct browser navigation (downloads)
 */
async function authenticateAllowQuery(req, res, next) {
    const authHeader = req.headers.authorization;
    let token;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else if (req.query && req.query.token) {
        token = req.query.token;
    } else if (req.cookies && req.cookies.wordjs_token) {
        token = req.cookies.wordjs_token;
    }

    if (!token) {
        return res.status(401).json({
            code: 'rest_not_logged_in',
            message: 'You are not currently logged in.',
            data: { status: 401 }
        });
    }

    await verifyAndAttachUser(token, req, res, next);
}

/**
 * Optional authentication (doesn't fail if no token)
 */
async function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    let token;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else if (req.cookies && req.cookies.wordjs_token) {
        token = req.cookies.wordjs_token;
    }

    if (!token) {
        req.user = null;
        req.userId = null;
        return next();
    }

    try {
        const decoded = jwt.verify(token, config.jwt.secret);
        const user = await User.findById(decoded.userId);
        req.user = user;
        req.userId = user ? user.id : null;
    } catch (e) {
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

/**
 * CSRF Protection for state-changing requests
 * Validates Origin/Referer headers against allowed origins
 */
function csrfProtection(req, res, next) {
    // Only check state-changing methods
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        return next();
    }

    // Skip CSRF check for setup endpoints (before origin is configured)
    if (req.path.startsWith('/api/v1/setup')) {
        return next();
    }

    const origin = req.get('Origin');
    const referer = req.get('Referer');
    const host = req.get('Host');

    // If no Origin header, check Referer (some browsers)
    let requestOrigin = origin;
    if (!requestOrigin && referer) {
        try {
            requestOrigin = new URL(referer).origin;
        } catch {
            requestOrigin = null;
        }
    }

    // Allow requests from same host
    if (requestOrigin) {
        try {
            const originHost = new URL(requestOrigin).host;
            if (originHost === host) {
                return next();
            }
        } catch {
            // Invalid origin URL
        }
    }

    // Allow if no Origin/Referer (server-to-server, API clients)
    // These must have valid JWT anyway
    if (!origin && !referer) {
        return next();
    }

    // Allow configured CORS origins
    const allowedOrigins = [
        config.site?.url,
        config.site?.frontendUrl,
        `http://${host}`,
        `https://${host}`
    ].filter(Boolean);

    if (requestOrigin && allowedOrigins.some(o => o && requestOrigin.startsWith(o.replace(/\/$/, '')))) {
        return next();
    }

    console.warn(`[CSRF] Blocked request from ${requestOrigin || 'unknown'} to ${req.path}`);
    return res.status(403).json({
        code: 'rest_csrf_invalid',
        message: 'Cross-site request blocked.',
        data: { status: 403 }
    });
}

module.exports = {
    authenticate,
    authenticateAllowQuery,
    optionalAuth,
    generateToken,
    verifyToken,
    csrfProtection
};
