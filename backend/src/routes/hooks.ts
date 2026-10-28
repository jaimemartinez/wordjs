import type { Request, Response } from 'express';
const express = require('express');
const log = require('../core/module-logger').moduleLogger('routes/hooks');
const router = express.Router();
const { hooks } = require('../core/hooks');
const { isAdmin } = require('../middleware/permissions');
const { authenticate, sessionOnly } = require('../middleware/auth');
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
        log.error({ err: error }, 'Failed to retrieve hooks');
        res.status(500).json({ error: 'Failed to retrieve hooks registry' });
    }
});

// Open inspector streams, per process and per user. Each one turns hook monitoring on for the whole
// process and serializes every hook call it relays, so they are few by design: one per open tab.
const MAX_HOOK_STREAMS = 20;
const MAX_HOOK_STREAMS_PER_USER = 3;
let openHookStreams = 0;
const hookStreamsByUser = new Map<number, number>();

/**
 * @swagger
 * /hooks/stream:
 *   get:
 *     summary: Stream live hook events (SSE)
 *     description: An administrator's interactive session only (an API token is refused with rest_token_management_forbidden). At most 3 open streams per user and 20 per process; beyond that the answer is 429 rest_hook_stream_limit.
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Event stream
 *       403:
 *         description: Not an administrator, or an API token
 *       429:
 *         description: Too many open inspector streams (rest_hook_stream_limit)
 */
router.get('/stream', authenticate, isAdmin, sessionOnly, (req: Request, res: Response) => {
    const userId = Number(req.user && req.user.id) || 0;
    if (openHookStreams >= MAX_HOOK_STREAMS || (hookStreamsByUser.get(userId) || 0) >= MAX_HOOK_STREAMS_PER_USER) {
        return res.status(429).json({ code: 'rest_hook_stream_limit', message: 'Too many open hook inspector streams. Close another inspector tab and try again.', data: { status: 429 } });
    }
    openHookStreams++;
    hookStreamsByUser.set(userId, (hookStreamsByUser.get(userId) || 0) + 1);

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
    // Multisite: the monitor is process-wide, so it only relays the calls of the site this inspector
    // was opened on (and never says which site fired one).
    const watchedSite = require('../core/site-context').currentSiteIdOrNull();
    const onHookCall = (data: any) => offStack(res, null, () => {
        if (!data || data.siteId !== watchedSite) return;
        const { siteId: _site, ...event } = data;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    hooks.monitor.on('hook:call', onHookCall);

    // Keep alive interval — a timer callback is off-stack for the same reason, so it gets the same seam.
    const keepAlive = setInterval(() => offStack(res, null, () => {
        res.write(': keep-alive\n\n');
    }), 15000);

    // Cleanup — once, whichever side closes first.
    let closed = false;
    const cleanup = () => {
        if (closed) return;
        closed = true;
        openHookStreams--;
        const left = (hookStreamsByUser.get(userId) || 1) - 1;
        if (left > 0) hookStreamsByUser.set(userId, left); else hookStreamsByUser.delete(userId);
        clearInterval(keepAlive);
        hooks.monitor.off('hook:call', onHookCall);
        hooks.disableMonitoring();
        res.end();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
});

module.exports = router;
module.exports.openHookStreamCount = () => openHookStreams;
