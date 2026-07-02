/**
 * WordJS - Error Handler Middleware
 */
import type { Request, Response, NextFunction } from 'express';

/**
 * Not found handler
 */
function notFound(req: Request, res: Response, next: NextFunction) {
    res.status(404).json({
        code: 'rest_no_route',
        message: `No route was found matching the URL and request method: ${req.method} ${req.path}`,
        data: { status: 404 }
    });
}

/**
 * Global error handler
 */
function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
    console.error('Error:', err);

    // Handle specific error types
    if (err.name === 'ValidationError') {
        return res.status(400).json({
            code: 'rest_invalid_param',
            message: err.message,
            data: { status: 400 }
        });
    }

    if (err.name === 'UnauthorizedError') {
        return res.status(401).json({
            code: 'rest_unauthorized',
            message: err.message || 'Unauthorized',
            data: { status: 401 }
        });
    }

    // Default error response
    const status = err.status || 500;
    const body: any = {
        code: err.code || 'rest_error',
        message: err.message || 'An error occurred',
        data: { status }
    };
    // Pass through a structured `details` payload (e.g. a plugin validation reject's
    // missingPermissions/dangerousCalls split) so callers get more than a flattened string.
    if (err.details !== undefined) body.details = err.details;
    res.status(status).json(body);
}

/**
 * Async handler wrapper
 */
function asyncHandler(fn: any) {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

module.exports = {
    notFound,
    errorHandler,
    asyncHandler
};
