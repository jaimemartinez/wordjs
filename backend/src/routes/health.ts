import type { Request, Response } from 'express';
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
router.get('/', async (req: Request, res: Response) => {
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
 *     description: >
 *       Returns status of database, mTLS security, filesystem, plugin sandbox and on-demand cache
 *       purging. Requires Admin privileges. `purge.broken` lists the PERMANENT failures that have
 *       killed on-demand cache invalidation in this process (e.g. a refused cluster TLS handshake);
 *       when it is non-empty, published changes only become visible when the ISR window expires and
 *       nothing will recover without a configuration fix.
 *
 *
 *       `sandbox.kernel` reports the KERNEL confinement layer of the platform this host is running on,
 *       and it exists because `sandbox.hardening` could not: that field is about bubblewrap
 *       specifically, so off Linux it reads `unsupported` whether or not anything else is confining the
 *       plugin. `kernel.mechanism` is what this OS HAS (`bwrap` on Linux, `appcontainer` on Windows,
 *       `seatbelt` on macOS, `none` elsewhere) and `kernel.state` is what this HOST actually got. The
 *       two together separate situations that demand opposite actions and that a single `unsupported`
 *       used to blur:
 *
 *
 *       * `mechanism: none` + `state: unsupported` — this platform has no such layer; there is nothing
 *         to install or enable.
 *       * `mechanism: appcontainer|seatbelt` + `state: disabled` — the layer exists on this host and
 *         nobody turned it on (`sandbox.useAppContainer` / `sandbox.useSeatbelt`).
 *       * `mechanism: <any>` + `state: degraded` — it WAS turned on and its probe could not demonstrate
 *         confinement here, so plugins run without it. This is the one state that needs a human; it is
 *         also surfaced as the boolean `sandbox.kernelDegraded`.
 *       * `state: active` — a real child, launched through the real profile, was actually refused the
 *         network and an out-of-zone read on THIS host. No layer reports `active` on any weaker
 *         evidence.
 *
 *
 *       `kernel.appliesTo` is stated rather than implied because it differs: bwrap wraps every isolated
 *       child, while the AppContainer and Seatbelt layers are applied only to plugins WITHOUT the
 *       `network` grant (a zero-capability container cannot hold a socket, and the network-permitting
 *       Seatbelt profile is a shape no probe has certified). For those plugins, egress remains bounded
 *       by the in-process guard — the same posture Linux takes when it withholds `--unshare-net`.
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
 *                 sandbox:
 *                   type: object
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [OK, DEGRADED, REFUSING, NOT_HARDENED, UNKNOWN]
 *                     platform:
 *                       type: string
 *                       example: linux
 *                     hardening:
 *                       type: string
 *                       description: bubblewrap ONLY (Linux); 'unsupported' elsewhere by definition.
 *                       enum: [unknown, unsupported, disabled, active, degraded]
 *                     netns:
 *                       type: string
 *                       description: bwrap --unshare-net ONLY (Linux); 'unsupported' elsewhere.
 *                       enum: [unknown, unsupported, disabled, active, degraded]
 *                     permission:
 *                       type: string
 *                       description: Node's own C++-enforced permission model — the one layer that is not platform-specific.
 *                       enum: [unknown, unsupported, disabled, active, degraded]
 *                     kernelDegraded:
 *                       type: boolean
 *                       description: True ONLY when this platform's kernel layer was enabled and its probe could not demonstrate confinement.
 *                     kernel:
 *                       type: object
 *                       properties:
 *                         mechanism:
 *                           type: string
 *                           enum: [bwrap, appcontainer, seatbelt, none]
 *                         state:
 *                           type: string
 *                           enum: [unknown, unsupported, disabled, active, degraded]
 *                         appliesTo:
 *                           type: string
 *                         note:
 *                           type: string
 *                         network:
 *                           type: object
 *                           properties:
 *                             mechanism:
 *                               type: string
 *                             state:
 *                               type: string
 *                               enum: [unknown, unsupported, disabled, active, degraded]
 *                 purge:
 *                   type: object
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [OK, BROKEN, UNKNOWN]
 *                     broken:
 *                       type: array
 *                       items:
 *                         type: string
 *                     transport:
 *                       type: string
 *                     target:
 *                       type: string
 *       403:
 *         description: Forbidden (Non-admin)
 */
router.get('/details', authenticate, isAdmin, async (req: Request, res: Response) => {
    try {
        const fullStatus = await SystemHealth.getFullStatus();
        res.json(fullStatus);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
