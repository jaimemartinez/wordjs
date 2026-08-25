import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const { hooks } = require('../core/hooks');
const { isAdmin } = require('../middleware/permissions');
const { authenticate } = require('../middleware/auth');
const { offStack } = require('../middleware/errorHandler');

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
router.get('/', authenticate, isAdmin, (req: Request, res: Response) => {
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
router.get('/stream', authenticate, isAdmin, (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Nginx setting just in case

    // Initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    // Enable monitoring globally
    hooks.enableMonitoring();

    // THIS LISTENER OUTLIVES THE REQUEST THAT REGISTERED IT, and it runs on the stack of whoever
    // fires the hook — never on this handler's. A throw in here therefore does not become this
    // stream's 500: `monitor.emit` is synchronous, so it propagates out of `hooks.doAction` and lands
    // on an UNRELATED caller (another request's handler), or, for one of the many fire-and-forget
    // `doAction(...)` calls in this codebase, on nobody at all — an unhandledRejection, which
    // index.ts answers with process.exit(1).
    //
    // And the body does throw: `Hooks._emitMonitor` flattens OBJECTS but passes primitives through
    // untouched, so a hook fired with a BigInt argument (what mysql2 hands back for a BIGINT column)
    // reaches JSON.stringify and raises `Do not know how to serialize a BigInt`. One admin holding
    // the hook inspector open was enough to turn that into a failure somewhere else entirely.
    // Containing it costs this subscriber one frame, which is the right price.
    const onHookCall = (data: any) => offStack(res, null, () => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    });

    hooks.monitor.on('hook:call', onHookCall);

    // Keep alive interval — a timer callback is off-stack for the same reason, so it gets the same seam.
    const keepAlive = setInterval(() => offStack(res, null, () => {
        res.write(': keep-alive\n\n');
    }), 15000);

    // Cleanup
    req.on('close', () => {
        clearInterval(keepAlive);
        hooks.monitor.off('hook:call', onHookCall);
        hooks.disableMonitoring();
        res.end();
    });
});

module.exports = router;
