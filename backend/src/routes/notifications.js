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
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering

    // Send initial keep-alive
    res.write('retry: 10000\n\n');

    notificationService.addClient(res, req.user.id);

    // Keep connection alive
    const keepAlive = setInterval(() => {
        res.write(': keepalive\n\n');
    }, 30000);

    req.on('close', () => {
        clearInterval(keepAlive);
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
