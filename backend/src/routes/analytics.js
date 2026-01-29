const express = require('express');
const router = express.Router();
const analytics = require('../models/Analytics');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');

/**
 * @swagger
 * /api/v1/analytics/stats:
 *   get:
 *     summary: Get aggregated analytics stats
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 */
router.get('/stats', authenticate, isAdmin, async (req, res) => {
    try {
        const { period } = req.query; // 'weekly' or 'monthly'
        const data = await analytics.getStats(period || 'weekly');
        res.json(data);
    } catch (error) {
        console.error('Analytics Error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

/**
 * Public Endpoint for tracking (Pixel/Beacon)
 * Called by frontend on page load
 */
router.post('/track', async (req, res) => {
    try {
        const { type, resource, metadata } = req.body;

        // Simple pixel tracking
        await analytics.track({
            type: type || 'page_view',
            resource: resource || '/',
            visitor_ip: req.ip, // Express IP
            user_id: req.user ? req.user.id : null, // If auth middleware ran (optional)
            metadata: metadata || {}
        });

        res.status(200).send({ success: true });
    } catch (error) {
        // Fail silently for tracking
        console.error('Tracking Error:', error);
        res.status(200).send({ success: false });
    }
});

module.exports = router;
