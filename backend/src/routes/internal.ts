import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { saveConfig, getConfig } = require('../core/configManager');
const config = require('../config/app');

/**
 * Constant-time string comparison that does not leak length or content via timing.
 * Returns false for any missing/empty input (no secret configured = deny).
 */
function secretsMatch(a: any, b: any) {
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

/**
 * @swagger
 * tags:
 *   name: Internal
 *   description: >-
 *     Control-plane hooks the gateway calls on the backend. NOT for public API clients — they are not
 *     part of the versioned REST surface, they are authenticated by a shared secret rather than by a user
 *     credential, and their contract may change without notice.
 */

/**
 * @swagger
 * /gateway-update:
 *   servers:
 *     - url: /api/internal
 *       description: >-
 *         Internal control plane. This router is mounted OUTSIDE the versioned /api/v1 base, so the full
 *         path is /api/internal/gateway-update.
 *   post:
 *     summary: Tell the backend which port the gateway now listens on
 *     description: >-
 *       INTERNAL — called by the gateway, not by public clients. Authenticated by the shared gateway
 *       secret in the `x-gateway-secret` header, compared in constant time; a backend with no secret
 *       configured refuses everything rather than matching an empty value. A genuine port CHANGE is
 *       persisted and the backend then exits so its supervisor respawns it with the new configuration —
 *       so an identical or invalid update is deliberately rejected or acknowledged as a no-op instead,
 *       to keep a flood of them from forcing repeated restarts. Not subject to the API-prefix CSRF
 *       middleware, because it is mounted outside that prefix.
 *     tags: [Internal]
 *     security: []
 *     parameters:
 *       - in: header
 *         name: x-gateway-secret
 *         required: true
 *         schema:
 *           type: string
 *         description: The shared gateway secret from the instance configuration.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [gatewayPort]
 *             properties:
 *               gatewayPort:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 65535
 *     responses:
 *       200:
 *         description: >-
 *           Either the configuration already matched (a no-op acknowledgement) or it was rewritten and
 *           the backend is about to restart. The message says which.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: gatewayPort missing, or not an integer in 1-65535.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
 *       401:
 *         description: The gateway secret is missing, wrong, or not configured on this backend.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
 *       500:
 *         description: The configuration could not be written.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
 */
// POST /api/internal/gateway-update
router.post('/gateway-update', (req: Request, res: Response) => {
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
