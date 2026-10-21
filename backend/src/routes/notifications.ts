/**
 * WordJS - Notification Routes
 */

import type { Request, Response } from 'express';
const express = require('express');
const log = require('../core/module-logger').moduleLogger('routes/notifications');
const router = express.Router();
const notificationService = require('../core/notifications');
const { authenticate, authenticateAllowQuery } = require('../middleware/auth');
// These routes are reachable by ANY signed-in user, subscribers included, so a bare `e.message`
// here published the database driver's text to the least-privileged account in the CMS.
const { publicErrorText } = require('../middleware/errorHandler');
/**
 * @swagger
 * tags:
 *   name: Notifications
 *   description: Per-user notification inbox plus a Server-Sent Events channel that pushes new notifications as they are created. Every operation is scoped to the calling user; a notification addressed to user 0 is a broadcast that any signed-in user may read and dismiss.
 * components:
 *   schemas:
 *     Notification:
 *       type: object
 *       properties:
 *         uuid:
 *           type: string
 *         user_id:
 *           type: integer
 *           description: 0 means a broadcast to every user.
 *         type:
 *           type: string
 *         title:
 *           type: string
 *         message:
 *           type: string
 *         data:
 *           type: string
 *           nullable: true
 *           description: JSON-encoded payload.
 *         icon:
 *           type: string
 *           nullable: true
 *         color:
 *           type: string
 *           nullable: true
 *         action_url:
 *           type: string
 *           nullable: true
 *         is_read:
 *           type: integer
 *         created_at:
 *           type: string
 */

/**
 * SSE Endpoint for real-time notifications
 */
/**
 * @swagger
 * /notifications/stream:
 *   get:
 *     summary: Subscribe to the live notification stream (Server-Sent Events)
 *     description: Long-lived text/event-stream response. Because EventSource cannot set headers, this route also accepts the session token as a token query parameter in addition to the Authorization header and the session cookie. The server writes a retry directive, then a keepalive comment every 5 seconds, then one SSE frame per notification. Concurrency is capped at 8 streams per user and 1000 per process; past the cap the request is refused with 429 rest_too_many_streams and a Retry-After header, before any stream is opened. (The admin shares one stream between all of a browser's tabs.)
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: token
 *         required: false
 *         description: A query ticket for this path (POST /auth/query-ticket), for EventSource clients that send neither the session cookie nor an Authorization header. A session token is not accepted here.
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: The event stream. Each frame is a JSON notification; comment lines starting with a colon are keepalives.
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       429:
 *         description: Too many open streams for this user or process (rest_too_many_streams); retry after the Retry-After seconds
 */
/** Seconds a refused stream is told to wait (429 Retry-After). */
const STREAM_RETRY_AFTER_SECONDS = 30;

router.get('/stream', authenticateAllowQuery, (req: Request, res: Response) => {
    const startTime = Date.now();
    log.info({ ip: req.ip }, `[SSE] 📥 New Stream Request from User ${req.user.id} (IP: ${req.ip})`);

    // Past the cap: an ordinary HTTP refusal, before any stream exists. (addClient below re-checks, for
    // the race between two requests that both saw room.)
    if (!notificationService.hasRoomFor(req.user.id)) {
        log.warn(`[SSE] ⛔ Stream refused for user ${req.user.id}: too many open streams`);
        res.setHeader('Retry-After', String(STREAM_RETRY_AFTER_SECONDS));
        return res.status(429).json({
            code: 'rest_too_many_streams',
            message: 'Too many live notification streams are open for this account. Close some tabs or try again shortly.',
            data: { status: 429 }
        });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering

    // Send initial keep-alive
    res.write('retry: 10000\n\n');

    // addClient returns false when the per-user / global SSE cap is hit; it has already closed the
    // response, so bail before arming the keepalive timer (otherwise a refused flood would still pin a
    // 5s interval per attempt — defeating the cap).
    if (!notificationService.addClient(res, req.user.id)) {
        return;
    }

    // `writableTimeout` is NOT a property of http.ServerResponse, and nothing in this repo ever assigns
    // it, so the liveness check below has always collapsed to `res.writable` alone. Typing `res` is what
    // surfaced that. The read is preserved verbatim through this narrowing rather than deleted, because
    // dropping a term is a behaviour change and this is a type-only migration — see the latent-bug note
    // handed back with this change.
    const sse: Response & { writableTimeout?: unknown } = res;

    // Keep connection alive (Ping every 5s to prevent proxy timeouts)
    const keepAlive = setInterval(() => {
        if (sse.writableTimeout || res.writable) {
            try {
                // console.debug(`[SSE] 💓 Ping User ${req.user.id}`); // Optional: Uncomment for extreme debug
                res.write(': keepalive\n\n');
            } catch (e) {
                log.error({ err: e }, `[SSE] ❌ Keepalive Failed for User ${req.user.id}`);
                clearInterval(keepAlive);
            }
        } else {
            log.warn(`[SSE] ⚠️ Socket not writable for User ${req.user.id}. Terminating loop.`);
            clearInterval(keepAlive);
        }
    }, 5000); // Reduced from 30s to 5s

    req.on('close', () => {
        const duration = (Date.now() - startTime) / 1000;
        log.info({ duration }, `[SSE] 🛑 Stream Closed for User ${req.user.id} after ${duration}s`);
        clearInterval(keepAlive);
        notificationService.removeClient(req.user.id, res);
    });
});

/**
 * Get notification list
 */
/**
 * @swagger
 * /notifications:
 *   get:
 *     summary: List the notifications of the calling user
 *     description: Returns up to 50 unread notifications, newest first, followed by the 5 most recent read ones.
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The notifications of the calling user
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Notification'
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       500:
 *         description: The notifications could not be loaded
 */
router.get('/', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = req.user.id;
        const notifications = await notificationService.getNotifications(userId);
        res.json(notifications);
    } catch (e) {
        log.error({ err: e }, '[notifications] list failed');
        res.status(500).json({ error: publicErrorText(e, 'Your notifications could not be loaded.') });
    }
});

/**
 * Mark as read
 */
/**
 * @swagger
 * /notifications/{uuid}/read:
 *   post:
 *     summary: Mark one notification as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Marked as read
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       404:
 *         description: No such notification for this user. The uuid is not a capability - it is matched against the caller own rows and against broadcasts.
 *       500:
 *         description: The notification could not be marked as read
 */
router.post('/:uuid/read', authenticate, async (req: Request, res: Response) => {
    try {
        const ok = await notificationService.markAsRead(req.params.uuid, req.user.id);
        if (!ok) return res.status(404).json({ error: 'Notification not found' });
        res.json({ success: true });
    } catch (e) {
        log.error({ err: e }, '[notifications] mark-read failed');
        res.status(500).json({ error: publicErrorText(e, 'The notification could not be marked as read.') });
    }
});

/**
 * Mark all as read
 */
/**
 * @swagger
 * /notifications/read-all:
 *   post:
 *     summary: Mark every notification of the calling user as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All notifications marked as read
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       500:
 *         description: The notifications could not be marked as read
 */
router.post('/read-all', authenticate, async (req: Request, res: Response) => {
    try {
        await notificationService.markAllAsRead(req.user.id);
        res.json({ success: true });
    } catch (e) {
        log.error({ err: e }, '[notifications] mark-all-read failed');
        res.status(500).json({ error: publicErrorText(e, 'Your notifications could not be marked as read.') });
    }
});

/**
 * Delete a notification
 */
/**
 * @swagger
 * /notifications/{uuid}:
 *   delete:
 *     summary: Delete one notification
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Notification deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       404:
 *         description: No such notification for this user
 *       500:
 *         description: The notification could not be deleted
 */
router.delete('/:uuid', authenticate, async (req: Request, res: Response) => {
    try {
        const ok = await notificationService.deleteNotification(req.params.uuid, req.user.id);
        if (!ok) return res.status(404).json({ error: 'Notification not found' });
        res.json({ success: true });
    } catch (e) {
        log.error({ err: e }, '[notifications] delete failed');
        res.status(500).json({ error: publicErrorText(e, 'The notification could not be deleted.') });
    }
});

module.exports = router;
