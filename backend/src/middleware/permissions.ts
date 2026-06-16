/**
 * WordJS - Permissions Middleware
 * Capability-based access control
 */

const config = require('../config/app');

/**
 * Check if user has required capability
 */
function can(capability) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                code: 'rest_not_logged_in',
                message: 'You must be logged in to perform this action.',
                data: { status: 401 }
            });
        }

        if (!req.user.can(capability)) {
            return res.status(403).json({
                code: 'rest_forbidden',
                message: `You do not have permission to ${capability.replace(/_/g, ' ')}.`,
                data: { status: 403 }
            });
        }

        next();
    };
}

/**
 * Check if user has any of the required capabilities
 */
function canAny(capabilities) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                code: 'rest_not_logged_in',
                message: 'You must be logged in to perform this action.',
                data: { status: 401 }
            });
        }

        const hasPermission = capabilities.some(cap => req.user.can(cap));

        if (!hasPermission) {
            return res.status(403).json({
                code: 'rest_forbidden',
                message: 'You do not have permission to perform this action.',
                data: { status: 403 }
            });
        }

        next();
    };
}

/**
 * Check if user has all required capabilities
 */
function canAll(capabilities) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                code: 'rest_not_logged_in',
                message: 'You must be logged in to perform this action.',
                data: { status: 401 }
            });
        }

        const hasAllPermissions = capabilities.every(cap => req.user.can(cap));

        if (!hasAllPermissions) {
            return res.status(403).json({
                code: 'rest_forbidden',
                message: 'You do not have permission to perform this action.',
                data: { status: 403 }
            });
        }

        next();
    };
}

/**
 * Check if user is administrator
 */
function isAdmin(req, res, next) {
    if (!req.user) {
        return res.status(401).json({
            code: 'rest_not_logged_in',
            message: 'You must be logged in.',
            data: { status: 401 }
        });
    }

    if (req.user.getRole() !== 'administrator') {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You must be an administrator to perform this action.',
            data: { status: 403 }
        });
    }

    next();
}

/**
 * Check if user owns the resource or has capability
 */
function ownerOrCan(capability, getOwnerId) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                code: 'rest_not_logged_in',
                message: 'You must be logged in.',
                data: { status: 401 }
            });
        }

        const ownerId = getOwnerId(req);

        if (req.user.id === ownerId || req.user.can(capability)) {
            return next();
        }

        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You do not have permission to access this resource.',
            data: { status: 403 }
        });
    };
}

module.exports = {
    can,
    canAny,
    canAll,
    isAdmin,
    ownerOrCan
};
