const express = require('express');
const router = express.Router();
const { saveConfig, getConfig } = require('../core/configManager');
const config = require('../config/app');

// POST /api/internal/gateway-update
router.post('/gateway-update', (req, res) => {
    // SECURITY: Validate Secret
    const incomeSecret = req.headers['x-gateway-secret'];
    const mySecret = config.gatewaySecret || (getConfig() || {}).gatewaySecret;

    if (!mySecret || incomeSecret !== mySecret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { gatewayPort } = req.body;

    if (!gatewayPort) return res.status(400).json({ error: 'Missing gatewayPort' });

    console.log(`[Backend] 🔄 Received Gateway Configuration Update: Port ${gatewayPort}`);

    // Update Config
    const success = saveConfig({
        gatewayPort: parseInt(gatewayPort)
    });

    if (success) {
        res.json({ success: true, message: 'Configuration updated. Backend restarting...' });

        // Trigger Restart (Supervisor/Server.js will respawn us)
        setTimeout(() => {
            console.log('[Backend] 🛑 Restarting process to apply new Gateway config...');
            process.exit(0);
        }, 1000);
    } else {
        res.status(500).json({ error: 'Failed to write config' });
    }
});

module.exports = router;
