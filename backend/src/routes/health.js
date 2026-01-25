const express = require('express');
const router = express.Router();
const SystemHealth = require('../core/system-health');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');

/**
 * Public high-level health check (Gateway use)
 */
router.get('/', async (req, res) => {
    const status = await SystemHealth.checkDatabase();
    res.json({
        status: status.status === 'OK' ? 'ok' : 'error',
        timestamp: new Date().toISOString()
    });
});

/**
 * Private detailed system status (Admin use)
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
