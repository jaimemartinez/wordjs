/**
 * WordJS - Notification Routes
 */

const express = require('express');
const router = express.Router();
const notificationService = require('../core/notifications');
const { authenticate, authenticateAllowQuery } = require('../middleware/auth');

/**
 * SSE Endpoint for real-time notifications
 */
router.get('/stream', authenticateAllowQuery, (req, res) => {
    const startTime = Date.now();
    console.log(`[SSE] 📥 New Stream Request from User ${req.user.id} (IP: ${req.ip})`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering

    // Send initial keep-alive
    res.write('retry: 10000\n\n');

    notificationService.addClient(res, req.user.id);

    // Keep connection alive (Ping every 5s to prevent proxy timeouts)
    const keepAlive = setInterval(() => {
        if (res.writableTimeout || res.writable) {
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
router.get('/', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const notifications = await notificationService.getNotifications(userId);
        res.json(notifications);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Mark as read
 */
router.post('/:uuid/read', authenticate, async (req, res) => {
    try {
        await notificationService.markAsRead(req.params.uuid);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Mark all as read
 */
router.post('/read-all', authenticate, async (req, res) => {
    try {
        await notificationService.markAllAsRead(req.user.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Delete a notification
 */
router.delete('/:uuid', authenticate, async (req, res) => {
    try {
        await notificationService.deleteNotification(req.params.uuid);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
