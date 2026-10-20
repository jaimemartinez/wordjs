/**
 * WordJS — the cluster screen's API (Admin → Servers): the panel path for `npm run cluster -- token |
 * tokens | revoke-tokens | info` and `npm run node:join` (zero config).
 *
 *   GET  /system/cluster                  how this install runs, the nodes the gateway knows and their
 *                                         health, the outstanding join tokens
 *   POST /system/cluster/token            mint a short-lived, single-use join token (password + 2FA code)
 *   POST /system/cluster/tokens/revoke    burn every outstanding token (password)
 *   POST /system/cluster/nodes/remove     take a node out of the cluster (password + 2FA code)
 *
 * The gateway owns the cluster (its CA, its tokens, its registry); this route asks it over the backend's
 * mTLS control channel (core/cert-manager gatewayControlRequest → gateway /cluster*). A monolith has no
 * gateway and no other node: GET answers { mode: 'monolith' } and the screen explains it.
 *
 * Who: administrators of a single site, network administrators of a network, the main site only
 * (routes/index.ts), with an interactive session at the main address — a join token admits a machine
 * into the cluster's trust, so it is never minted for an API token or a bound session, and every write is
 * audited (cluster.token.create, cluster.tokens.revoke, cluster.node.remove).
 */
import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const { authenticate, sessionOnly, accountAuthorityOnly } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireSudoPassword } = require('./users');
const { recordAudit } = require('../core/audit');

router.use(authenticate, isAdmin, sessionOnly);

function deploymentMode(): 'monolith' | 'split' {
    return process.env.WORDJS_EMBEDDED === '1' || process.env.WORDJS_MODE === 'mono' ? 'monolith' : 'split';
}

/** Ask the gateway; a coded failure instead of a throw when it cannot be reached. */
async function gateway(method: 'GET' | 'POST', urlPath: string, body: unknown): Promise<{ status: number; body: any }> {
    try {
        const r = await require('../core/cert-manager').gatewayControlRequest(method, urlPath, body, 5000);
        let parsed: any = null;
        try { parsed = JSON.parse(r.text); } catch { parsed = { error: r.text }; }
        return { status: r.status, body: parsed };
    } catch (e: any) {
        return { status: 502, body: { code: 'cluster_gateway_unreachable', error: `The gateway could not be reached (${(e && e.message) || e}).` } };
    }
}

function relay(res: Response, r: { status: number; body: any }) {
    return res.status(r.status).json(r.body);
}

/**
 * @swagger
 * /system/cluster:
 *   get:
 *     summary: The cluster (Admin → Servers) - the nodes the gateway knows, their health, outstanding join tokens
 *     description: In a monolith there is no gateway and no other node, and the answer is { mode monolith }. Otherwise it is the gateway's view over the backend's mTLS control channel. initialized false means the gateway has no cluster CA yet (one machine, split mode).
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ mode, initialized, advertiseHost, enrollPort, caFingerprint, nodes: [{ url, role, routes, status (up, down, unknown), latencyMs, lastError }], tokens: [{ role, host, expiresAt }], removed: [url] }"
 *       403:
 *         description: Not an administrator, or an API token
 *       502:
 *         description: The gateway could not be reached (cluster_gateway_unreachable)
 * /system/cluster/token:
 *   post:
 *     summary: Mint a single-use join token for a new backend or frontend node
 *     description: The token admits one machine into the cluster's trust, so it takes the password and a current two-factor code, an interactive session at the main address, and is audited. host pins the address the node will advertise (recommended; it also re-admits a node removed earlier at that address). ttlMinutes is 1 to 60 (15 by default). The answer carries the token once and the node-join command to run on the new machine.
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [role, currentPassword, mfaCode]
 *             properties:
 *               role:
 *                 type: string
 *                 enum: [backend, frontend]
 *               host:
 *                 type: string
 *               ttlMinutes:
 *                 type: integer
 *               currentPassword:
 *                 type: string
 *               mfaCode:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ token, role, host, expiresAt, command, readmitted }"
 *       400:
 *         description: An invalid role, host or ttl (cluster_invalid_*), or a wrong code
 *       403:
 *         description: Not an administrator, a wrong password, no two-factor authentication or no code
 *       409:
 *         description: A monolith (cluster_monolith) or a gateway without a cluster CA (cluster_not_initialized)
 * /system/cluster/tokens/revoke:
 *   post:
 *     summary: Revoke every outstanding join token
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword]
 *             properties:
 *               currentPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ revoked: true }"
 *       403:
 *         description: Not an administrator, or a wrong password
 * /system/cluster/nodes/remove:
 *   post:
 *     summary: Take a node out of the cluster
 *     description: Every route the node serves stops receiving traffic, and the gateway refuses its re-registration until a new join token is minted for its host. Password and a current two-factor code; audited.
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url, currentPassword, mfaCode]
 *             properties:
 *               url:
 *                 type: string
 *               currentPassword:
 *                 type: string
 *               mfaCode:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ removed, routes }"
 *       403:
 *         description: Not an administrator, a wrong password, no two-factor authentication or no code
 *       404:
 *         description: No registered node has that address (cluster_node_not_found)
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (deploymentMode() === 'monolith') return res.json({ mode: 'monolith', initialized: false, nodes: [], tokens: [], removed: [] });
    const r = await gateway('GET', '/cluster', null);
    if (r.status !== 200) return relay(res, r);
    res.json({ mode: 'split', ...r.body });
}));

router.post('/token', accountAuthorityOnly, asyncHandler(async (req: Request, res: Response) => {
    if (deploymentMode() === 'monolith') return res.status(409).json({ code: 'cluster_monolith', error: 'This install runs as one process (the monolith); there is no gateway to join.' });
    const b = req.body || {};
    if (await requireSudoPassword(req, res, b.currentPassword)) return;
    const mfa = await require('./network').requireStepUp(req, res);
    if (!mfa) return;
    const r = await gateway('POST', '/cluster/token', { role: b.role, host: b.host, ttlMinutes: b.ttlMinutes });
    if (r.status === 200) {
        await recordAudit(req.user && req.user.id, 'cluster.token.create', 'cluster', String(r.body.role || ''), { role: r.body.role, host: r.body.host || null, expiresAt: r.body.expiresAt, mfa });
    }
    res.set('Cache-Control', 'no-store');
    return relay(res, r);
}));

router.post('/tokens/revoke', accountAuthorityOnly, asyncHandler(async (req: Request, res: Response) => {
    if (deploymentMode() === 'monolith') return res.status(409).json({ code: 'cluster_monolith', error: 'This install runs as one process (the monolith); there is no gateway.' });
    if (await requireSudoPassword(req, res, (req.body || {}).currentPassword)) return;
    const r = await gateway('POST', '/cluster/tokens/revoke', {});
    if (r.status === 200) await recordAudit(req.user && req.user.id, 'cluster.tokens.revoke', 'cluster', '', {});
    return relay(res, r);
}));

router.post('/nodes/remove', accountAuthorityOnly, asyncHandler(async (req: Request, res: Response) => {
    if (deploymentMode() === 'monolith') return res.status(409).json({ code: 'cluster_monolith', error: 'This install runs as one process (the monolith); there is no other node.' });
    const b = req.body || {};
    if (await requireSudoPassword(req, res, b.currentPassword)) return;
    const mfa = await require('./network').requireStepUp(req, res);
    if (!mfa) return;
    const url = typeof b.url === 'string' ? b.url.slice(0, 300) : '';
    const r = await gateway('POST', '/cluster/nodes/remove', { url });
    if (r.status === 200) await recordAudit(req.user && req.user.id, 'cluster.node.remove', 'cluster', url, { url, routes: r.body.routes, mfa });
    return relay(res, r);
}));

module.exports = router;
