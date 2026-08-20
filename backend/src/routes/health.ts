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
 *       `sandbox.kernel` reports the native confinement layer (`landlock`, `appcontainer`, `seatbelt`,
 *       or `none`) and the probe result on this host:
 *
 *
 *       * `mechanism: none` + `state: unsupported` — this platform has no such layer; there is nothing
 *         to install or enable.
 *       * `state: disabled` — an operator explicitly opted out of the native layer.
 *       * `mechanism: <any>` + `state: degraded` — it WAS turned on and its probe could not demonstrate
 *         confinement here, so plugins run without it. This is the one state that needs a human; it is
 *         also surfaced as the boolean `sandbox.kernelDegraded`.
 *       * `state: active` — real children proved filesystem/process confinement and both network-policy
 *         shapes. No layer reports `active` on weaker evidence.
 *
 *
 *       `kernel.appliesTo` is every isolated production plugin on every supported OS. A network grant
 *       changes only egress; that platform's filesystem/process boundary stays active.
 *
 *
 *       `sandbox.kernel.floor` is Linux-only. `landlock+seccomp` needs no user namespace, sysctl or
 *       separately installed sandbox executable. Landlock scopes reads/writes and cross-process access;
 *       seccomp removes process-creation/anonymous-executable/dangerous syscalls, denies every new socket
 *       without a network grant, and admits only AF_INET/AF_INET6 client sockets with one.
 *
 *
 *       * `floor.inForce: landlock+seccomp` — the zero-configuration Linux layer was certified.
 *       * `floor.inForce: none` — there is genuinely no kernel floor. This is the state that used to be
 *         reported identically to the one above it, and it is the only one that is a call to action.
 *
 *
 *       `sandbox.useKernelHardening: false` explicitly turns the Linux layer off.
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
 *                       description: Native sandbox state for this operating system.
 *                       enum: [unknown, unsupported, disabled, active, degraded]
 *                     network:
 *                       type: string
 *                       description: Native network-policy probe state.
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
 *                           enum: [landlock, appcontainer, seatbelt, none]
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
 *                         floor:
 *                           type: object
 *                           description: LINUX ONLY. Landlock/seccomp floor state.
 *                           properties:
 *                             inForce:
 *                               type: string
 *                               enum: [landlock+seccomp, none]
 *                             layers:
 *                               type: object
 *                               properties:
 *                                 landlock:
 *                                   type: object
 *                                   properties:
 *                                     state:
 *                                       type: string
 *                                       enum: [unknown, unsupported, disabled, active, degraded]
 *                                     note:
 *                                       type: string
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
 *                 contentOutbox:
 *                   type: object
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [OK, DEGRADED, ERROR, UNKNOWN]
 *                     pending:
 *                       type: integer
 *                     processing:
 *                       type: integer
 *                     dead:
 *                       type: integer
 *                     delayedSeconds:
 *                       type: integer
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
