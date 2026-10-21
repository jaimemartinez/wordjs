/**
 * WordJS — the cluster screen's API (Admin → Servers): the panel path for `npm run cluster -- token |
 * tokens | revoke-tokens | info` and `npm run node:join` (zero config).
 *
 *   GET  /system/cluster                  how this install runs, the nodes the gateway knows and their
 *                                         health, the outstanding join tokens
 *   POST /system/cluster/token            mint a short-lived, single-use join token (password + 2FA code)
 *   POST /system/cluster/tokens/revoke    burn every outstanding token (password)
 *   POST /system/cluster/nodes/remove     take a node out of the cluster (password + 2FA code)
 *   PUT  /system/cluster/forwards         the TCP ports the gateway forwards to the backend node (password)
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
const { authenticate, sessionOnly, accountAuthorityOnly, sessionBoundToSecondaryAddress, siteHostPolicy } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler, publicErrorText } = require('../middleware/errorHandler');
const log = require('../core/module-logger').moduleLogger('routes/cluster');
const { requireSudoPassword } = require('./users');
const { recordAudit } = require('../core/audit');

router.use(authenticate, isAdmin, sessionOnly);

function deploymentMode(): 'monolith' | 'split' {
    return process.env.WORDJS_EMBEDDED === '1' || process.env.WORDJS_MODE === 'mono' ? 'monolith' : 'split';
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * What the screen calls the deployment: 'separate' once any node the gateway knows lives on another
 * machine (a non-loopback address), 'split' while they all run next to it. QA X1-08: a three-machine
 * cluster was reported as "split".
 */
function clusterMode(nodes: unknown): 'split' | 'separate' {
    if (!Array.isArray(nodes)) return 'split';
    return nodes.some((n: any) => {
        try { return !LOOPBACK.has(new URL(String(n && n.url)).hostname.toLowerCase()); } catch { return false; }
    }) ? 'separate' : 'split';
}

/**
 * The writes here need a session started at the main address (accountAuthorityOnly). Said up front, so
 * the screen can explain it before the administrator types a password and a code (QA X1-06).
 */
function sessionAddress(req: Request): { boundSession: boolean; mainAddress: string | null } {
    let mainAddress: string | null;
    try { mainAddress = (siteHostPolicy.get().canonical || {}).origin || null; } catch { mainAddress = null; }
    return { boundSession: sessionBoundToSecondaryAddress(req) === true, mainAddress };
}

/**
 * The join-token request checked BEFORE the two-factor code is spent on it (QA X1-08: an invalid role or
 * TTL burned the code, and the corrected retry in the same 30 s window was refused). The gateway checks
 * the same fields again (src/cluster-admin.js); this only refuses what it would refuse.
 */
function tokenRequestProblem(b: any): { code: string; error: string } | null {
    if (b.role !== 'backend' && b.role !== 'frontend') return { code: 'cluster_invalid_role', error: 'role is backend or frontend' };
    const ttl = b.ttlMinutes;
    if (ttl !== undefined && ttl !== null && ttl !== '' && !(Number.isInteger(Number(ttl)) && Number(ttl) >= 1 && Number(ttl) <= 60)) {
        return { code: 'cluster_invalid_ttl', error: 'ttlMinutes is a whole number from 1 to 60' };
    }
    const host = b.host;
    if (host !== undefined && host !== null && host !== '') {
        const s = String(host).trim();
        const ip = require('net').isIP(s) !== 0;
        if (s.length > 253 || (!ip && !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(s))) {
            return { code: 'cluster_invalid_host', error: 'host is an IP address or a DNS name' };
        }
    }
    return null;
}

/** Ask the gateway; a coded failure instead of a throw when it cannot be reached. */
async function gateway(method: 'GET' | 'POST', urlPath: string, body: unknown): Promise<{ status: number; body: any }> {
    try {
        const r = await require('../core/cert-manager').gatewayControlRequest(method, urlPath, body, 5000);
        let parsed: any = null;
        try { parsed = JSON.parse(r.text); } catch { parsed = { error: r.text }; }
        return { status: r.status, body: parsed };
    } catch (e: any) {
        // The cause stays in the log: a caught error's text is not the caller's (middleware/errorHandler).
        log.warn(`[cluster] the gateway control channel failed: ${(e && e.message) || e}`);
        return { status: 502, body: { code: 'cluster_gateway_unreachable', error: publicErrorText(e, 'The gateway could not be reached over the cluster control channel.') } };
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
 * /system/cluster/forwards:
 *   put:
 *     summary: Set the TCP ports the gateway forwards to the backend node
 *     description: >-
 *       Replaces the list. Each forward makes the gateway listen on `port` (every interface) and pipe each
 *       connection to `targetPort` on the registered backend node, with a PROXY protocol v1 line first
 *       unless `proxyProtocol` is false — so a service on the backend machine (the mail server's SMTP
 *       listener in separate mode) is reachable at the cluster's public address. The gateway refuses its
 *       own ports. The answer says, per forward, whether it listens or why not.
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [forwards, currentPassword]
 *             properties:
 *               forwards:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     port:
 *                       type: integer
 *                     targetPort:
 *                       type: integer
 *                     proxyProtocol:
 *                       type: boolean
 *               currentPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ forwards: [{ port, targetPort, proxyProtocol, listening, error }] }"
 *       400:
 *         description: An invalid list (cluster_invalid_forward)
 *       403:
 *         description: Not an administrator, a wrong password, or a session started at another address
 *       409:
 *         description: A monolith (cluster_monolith)
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
    res.json({ ...r.body, mode: clusterMode(r.body && r.body.nodes), ...sessionAddress(req) });
}));

router.post('/token', accountAuthorityOnly, asyncHandler(async (req: Request, res: Response) => {
    if (deploymentMode() === 'monolith') return res.status(409).json({ code: 'cluster_monolith', error: 'This install runs as one process (the monolith); there is no gateway to join.' });
    const b = req.body || {};
    const problem = tokenRequestProblem(b);
    if (problem) return res.status(400).json(problem);
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

router.put('/forwards', accountAuthorityOnly, asyncHandler(async (req: Request, res: Response) => {
    if (deploymentMode() === 'monolith') return res.status(409).json({ code: 'cluster_monolith', error: 'This install runs as one process (the monolith); its own port is the public one.' });
    const b = req.body || {};
    if (await requireSudoPassword(req, res, b.currentPassword)) return;
    if (!Array.isArray(b.forwards)) return res.status(400).json({ code: 'cluster_invalid_forward', error: 'forwards must be a list' });
    const forwards = b.forwards.slice(0, 20).map((f: any) => ({ port: f && f.port, targetPort: f && f.targetPort, proxyProtocol: !(f && f.proxyProtocol === false) }));
    const r = await gateway('POST', '/tcp-forwards', { forwards });
    if (r.status === 200) {
        await recordAudit(req.user && req.user.id, 'cluster.forwards.set', 'cluster', '',
            { forwards: (r.body.forwards || []).map((f: any) => ({ port: f.port, targetPort: f.targetPort, proxyProtocol: f.proxyProtocol })) });
    }
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
