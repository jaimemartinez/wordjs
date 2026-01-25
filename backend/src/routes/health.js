const express = require('express');
const router = express.Router();
const SystemHealth = require('../core/system-health');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');

/**
 * Public high-level health check (Gateway use)
 */
/**
 * @swagger
 * /health:
 *   get:
 *     summary: Check gateway and basic database health
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: System is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 timestamp:
 *                   type: string
 */
router.get('/', async (req, res) => {
    const status = await SystemHealth.checkDatabase();
    res.json({
        status: status.status === 'OK' ? 'ok' : 'error',
        timestamp: new Date().toISOString()
    });
});

/**
 * @swagger
 * /health/details:
 *   get:
 *     summary: Get detailed system status
 *     description: Returns status of database, mTLS security, and filesystem. Requires Admin privileges.
 *     tags: [Health]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Detailed status object
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 database:
 *                   type: object
 *                 mtls:
 *                   type: object
 *                 filesystem:
 *                   type: object
 *       403:
 *         description: Forbidden (Non-admin)
 */
router.get('/details', authenticate, isAdmin, async (req, res) => {
    try {
        const fullStatus = await SystemHealth.getFullStatus();
        res.json(fullStatus);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
