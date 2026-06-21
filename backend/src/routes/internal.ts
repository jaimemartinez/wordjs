const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { saveConfig, getConfig } = require('../core/configManager');
const config = require('../config/app');

/**
 * Constant-time string comparison that does not leak length or content via timing.
 * Returns false for any missing/empty input (no secret configured = deny).
 */
function secretsMatch(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
        return false;
    }
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    // timingSafeEqual requires equal-length buffers; hash both to a fixed length first so a length
    // mismatch is itself compared in constant time (no early-out length oracle).
    const ah = crypto.createHash('sha256').update(ab).digest();
    const bh = crypto.createHash('sha256').update(bb).digest();
    return crypto.timingSafeEqual(ah, bh);
}

// POST /api/internal/gateway-update
router.post('/gateway-update', (req, res) => {
    // SECURITY: Validate the gateway secret in constant time (no early-out timing oracle), and refuse
    // when no secret is configured rather than allowing an empty/default match.
    const incomeSecret = req.headers['x-gateway-secret'];
    const mySecret = config.gatewaySecret || (getConfig() || {}).gatewaySecret;

    if (!secretsMatch(incomeSecret, mySecret)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { gatewayPort } = req.body;

    if (!gatewayPort) return res.status(400).json({ error: 'Missing gatewayPort' });

    // Guard the matcher: only restart if the port actually changed to a valid value, so a flood of
    // identical/invalid updates cannot force repeated process.exit() restarts (availability).
    const parsedPort = parseInt(gatewayPort, 10);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        return res.status(400).json({ error: 'Invalid gatewayPort' });
    }
    const currentPort = config.gatewayPort || (getConfig() || {}).gatewayPort;
    if (currentPort && parseInt(currentPort, 10) === parsedPort) {
        // No-op: config already matches. Acknowledge without restarting.
        return res.json({ success: true, message: 'Gateway configuration already up to date.' });
    }

    console.log(`[Backend] 🔄 Received Gateway Configuration Update: Port ${parsedPort}`);

    // Update Config
    const success = saveConfig({
        gatewayPort: parsedPort
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
