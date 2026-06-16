/**
 * WordJS - Error Handler Middleware
 */

/**
 * Not found handler
 */
function notFound(req, res, next) {
    res.status(404).json({
        code: 'rest_no_route',
        message: `No route was found matching the URL and request method: ${req.method} ${req.path}`,
        data: { status: 404 }
    });
}

/**
 * Global error handler
 */
function errorHandler(err, req, res, next) {
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
    res.status(status).json({
        code: err.code || 'rest_error',
        message: err.message || 'An error occurred',
        data: { status }
    });
}

/**
 * Async handler wrapper
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

module.exports = {
    notFound,
    errorHandler,
    asyncHandler
};
