const express = require('express');
const router = express.Router();
const { hooks } = require('../core/hooks');
const { isAdmin } = require('../middleware/permissions');
const { authenticate } = require('../middleware/auth');

/**
 * @swagger
 * /hooks:
 *   get:
 *     summary: Get all registered hooks
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of all actions and filters
 */
router.get('/', authenticate, isAdmin, (req, res) => {
    try {
        const allHooks = hooks.getHooks();
        res.json(allHooks);
    } catch (error) {
        console.error('Failed to retrieve hooks:', error);
        res.status(500).json({ error: 'Failed to retrieve hooks registry' });
    }
});

/**
 * @swagger
 * /hooks/stream:
 *   get:
 *     summary: Stream live hook events (SSE)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Event stream
 */
router.get('/stream', authenticate, isAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Nginx setting just in case

    // Initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    // Enable monitoring globally
    hooks.enableMonitoring();

    const onHookCall = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    hooks.monitor.on('hook:call', onHookCall);

    // Keep alive interval
    const keepAlive = setInterval(() => {
        res.write(': keep-alive\n\n');
    }, 15000);

    // Cleanup
    req.on('close', () => {
        clearInterval(keepAlive);
        hooks.monitor.off('hook:call', onHookCall);
        hooks.disableMonitoring();
        res.end();
    });
});

module.exports = router;
