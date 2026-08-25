/**
 * WordJS - Notification Routes
 */

import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const notificationService = require('../core/notifications');
const { authenticate, authenticateAllowQuery } = require('../middleware/auth');
// These routes are reachable by ANY signed-in user, subscribers included, so a bare `e.message`
// here published the database driver's text to the least-privileged account in the CMS.
const { publicErrorText } = require('../middleware/errorHandler');

/**
 * SSE Endpoint for real-time notifications
 */
router.get('/stream', authenticateAllowQuery, (req: Request, res: Response) => {
    const startTime = Date.now();
    console.log(`[SSE] 📥 New Stream Request from User ${req.user.id} (IP: ${req.ip})`);

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
                console.error(`[SSE] ❌ Keepalive Failed for User ${req.user.id}: ${e.message}`);
                clearInterval(keepAlive);
            }
        } else {
            console.warn(`[SSE] ⚠️ Socket not writable for User ${req.user.id}. Terminating loop.`);
            clearInterval(keepAlive);
        }
    }, 5000); // Reduced from 30s to 5s

    req.on('close', () => {
        const duration = (Date.now() - startTime) / 1000;
        console.log(`[SSE] 🛑 Stream Closed for User ${req.user.id} after ${duration}s`);
        clearInterval(keepAlive);
        notificationService.removeClient(req.user.id, res);
    });
});

/**
 * Get notification list
 */
router.get('/', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = req.user.id;
        const notifications = await notificationService.getNotifications(userId);
        res.json(notifications);
    } catch (e) {
        console.error('[notifications] list failed:', e);
        res.status(500).json({ error: publicErrorText(e, 'Your notifications could not be loaded.') });
    }
});

/**
 * Mark as read
 */
router.post('/:uuid/read', authenticate, async (req: Request, res: Response) => {
    try {
        const ok = await notificationService.markAsRead(req.params.uuid, req.user.id);
        if (!ok) return res.status(404).json({ error: 'Notification not found' });
        res.json({ success: true });
    } catch (e) {
        console.error('[notifications] mark-read failed:', e);
        res.status(500).json({ error: publicErrorText(e, 'The notification could not be marked as read.') });
    }
});

/**
 * Mark all as read
 */
router.post('/read-all', authenticate, async (req: Request, res: Response) => {
    try {
        await notificationService.markAllAsRead(req.user.id);
        res.json({ success: true });
    } catch (e) {
        console.error('[notifications] mark-all-read failed:', e);
        res.status(500).json({ error: publicErrorText(e, 'Your notifications could not be marked as read.') });
    }
});

/**
 * Delete a notification
 */
router.delete('/:uuid', authenticate, async (req: Request, res: Response) => {
    try {
        const ok = await notificationService.deleteNotification(req.params.uuid, req.user.id);
        if (!ok) return res.status(404).json({ error: 'Notification not found' });
        res.json({ success: true });
    } catch (e) {
        console.error('[notifications] delete failed:', e);
        res.status(500).json({ error: publicErrorText(e, 'The notification could not be deleted.') });
    }
});

module.exports = router;
