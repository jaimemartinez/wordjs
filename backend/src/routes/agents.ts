/**
 * WordJS — AI agent connections (the identities the MCP server at /api/v1/mcp authenticates).
 *
 * THE SAME MODEL AS PLUGINS: the connection REQUESTS capabilities, an administrator GRANTS them.
 *   • Anyone who may mint API tokens (`manage_api_tokens`) may create a connection bound to THEMSELVES. It
 *     starts `pending`: it can connect and introspect, but holds no tool until it is granted.
 *   • Only an administrator grants, and only a subset of what was requested. An administrator may also
 *     create a connection bound to another user (e.g. a dedicated "editorial bot" account).
 *   • The owner or an administrator may revoke; revocation is terminal.
 * Whatever is granted, the effective authority of every call is grant ∩ the bound user's own live
 * capabilities (core/agent-capabilities), so a grant can never lift a user above their role.
 *
 * Every route here is SESSION-only: an API token or an agent cannot mint, grant or revoke agents.
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const { authenticate, sessionOnly, sessionBoundToSecondaryAddress } = require('../middleware/auth');
const { can } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { routeIdOrNull } = require('../core/query-params');
const { recordAudit, listAuditForTarget } = require('../core/audit');
const {
    AGENT_CAPABILITIES, invalidAgentCapabilities, normalizeAgentCapabilities, grantWithinRequest, effectiveAgentCapabilities,
} = require('../core/agent-capabilities');
const AgentConnection = require('../models/AgentConnection');
const User = require('../models/User');
const config = require('../config/app');

/** At most this many live (pending or active) connections per bound user. */
const MAX_LIVE_CONNECTIONS_PER_USER = 25;

const isAdministrator = (req: Request) => !!(req.user && req.user.getRole() === 'administrator');

function mcpEndpoint(): string {
    const base = String((config.site && config.site.url) || '').replace(/\/+$/, '');
    return `${base}${config.api.prefix}/mcp`;
}

async function present(rec: any) {
    const user = await User.findById(rec.userId);
    const expired = rec.expiresAt != null && rec.expiresAt * 1000 <= Date.now();
    return {
        ...rec,
        expired,
        user: user ? { id: user.id, login: user.userLogin, displayName: user.displayName, role: user.getRole() } : null,
        // The grant words this user can actually exercise — a grant beyond the user's role is shown inert.
        effective: user && rec.status === 'active' ? effectiveAgentCapabilities(user, rec.granted) : [],
    };
}

const forbidden = (res: Response, message: string) =>
    res.status(403).json({ code: 'rest_forbidden', message, data: { status: 403 } });
const notFound = (res: Response) =>
    res.status(404).json({ code: 'rest_agent_not_found', message: 'Agent connection not found.', data: { status: 404 } });

/** Resolve :id to a connection the caller may see (owner or administrator), or answer and return null. */
async function connectionForCaller(req: Request, res: Response): Promise<any | null> {
    const id = routeIdOrNull(req.params.id);
    if (id === null) {
        res.status(400).json({ code: 'rest_invalid_param', message: 'Invalid agent connection id.', data: { status: 400 } });
        return null;
    }
    const rec = await AgentConnection.findById(id);
    // Someone else's connection answers exactly like a missing one: no existence oracle.
    if (!rec || (!isAdministrator(req) && rec.userId !== req.user.id)) { notFound(res); return null; }
    return rec;
}

/**
 * @swagger
 * /agents:
 *   get:
 *     summary: List AI agent connections
 *     description: >-
 *       Administrators see every connection; anyone else sees the connections bound to themselves. Never
 *       returns a token. Session-only, requires manage_api_tokens.
 *     tags: [Agents]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The connections, the capability vocabulary and the MCP endpoint URL.
 */
router.get('/', authenticate, sessionOnly, can('manage_api_tokens'), asyncHandler(async (req: Request, res: Response) => {
    const rows = await AgentConnection.list(isAdministrator(req) ? undefined : req.user.id);
    res.json({
        connections: await Promise.all(rows.map(present)),
        capabilities: AGENT_CAPABILITIES,
        canGrant: isAdministrator(req),
        mcpUrl: mcpEndpoint(),
    });
}));

/**
 * @swagger
 * /agents:
 *   post:
 *     summary: Create an AI agent connection
 *     description: >-
 *       Creates a PENDING connection that requests the given capabilities. The plaintext `wja_` token is
 *       returned ONCE. Nothing is granted here — an administrator grants with PUT /agents/{id}/grant.
 *       Only an administrator may bind the connection to another user (userId).
 *     tags: [Agents]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               requested:
 *                 type: array
 *                 items: { type: string, enum: [content:read, content:draft, content:publish, media:upload, taxonomy:write, comments:moderate, settings:read] }
 *               userId: { type: integer }
 *               expiresInDays: { type: integer }
 *     responses:
 *       201:
 *         description: Created; the token is in the body and is never shown again.
 *       400:
 *         description: Unknown capability, nothing requested, or invalid expiry.
 */
router.post('/', authenticate, sessionOnly, can('manage_api_tokens'), asyncHandler(async (req: Request, res: Response) => {
    if (sessionBoundToSecondaryAddress(req)) {
        return res.status(403).json({
            code: 'rest_token_bound_session',
            message: 'Agent connections can only be created from a session started at the main address.',
            data: { status: 403 }
        });
    }
    const { name, requested, expiresInDays, userId } = req.body || {};
    const bad = invalidAgentCapabilities(requested);
    if (bad.length) {
        return res.status(400).json({
            code: 'rest_invalid_capability',
            message: `Unknown agent capability: ${bad.join(', ')}. Known: ${AGENT_CAPABILITIES.join(', ')}.`,
            data: { status: 400 }
        });
    }
    const caps = normalizeAgentCapabilities(requested);
    if (!caps.length) {
        return res.status(400).json({ code: 'rest_missing_param', message: 'Request at least one capability.', data: { status: 400 } });
    }
    if (expiresInDays != null && (!Number.isFinite(Number(expiresInDays)) || Number(expiresInDays) <= 0)) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'expiresInDays must be a positive number of days.', data: { status: 400 } });
    }

    let boundId = req.user.id;
    if (userId != null && userId !== '' && Number(userId) !== req.user.id) {
        if (!isAdministrator(req)) return forbidden(res, 'Only an administrator can create an agent connection for another user.');
        // JSON gives a number, a form gives a string; routeIdOrNull's contract is the string shape.
        const target = await User.findById(routeIdOrNull(typeof userId === 'number' ? String(userId) : userId));
        if (!target) return res.status(400).json({ code: 'rest_invalid_param', message: 'That user does not exist.', data: { status: 400 } });
        boundId = target.id;
    }

    const live = (await AgentConnection.list(boundId)).filter((c: any) => c.status !== 'revoked');
    if (live.length >= MAX_LIVE_CONNECTIONS_PER_USER) {
        return res.status(400).json({
            code: 'rest_agent_limit',
            message: `This user already has ${MAX_LIVE_CONNECTIONS_PER_USER} agent connections. Revoke one first.`,
            data: { status: 400 }
        });
    }

    const { token, connection } = await AgentConnection.create({
        userId: boundId, name, requested: caps, createdBy: req.user.id, expiresInDays: expiresInDays ?? null,
    });
    await recordAudit(req.user.id, 'agent.create', 'agent', connection.id, {
        name: connection.name, boundUser: boundId, requested: connection.requested,
    });
    res.status(201).json({ token, connection: await present(connection), mcpUrl: mcpEndpoint() });
}));

/**
 * @swagger
 * /agents/{id}/grant:
 *   put:
 *     summary: Grant capabilities to an AI agent connection (administrators only)
 *     description: >-
 *       Replaces the grant. The grant must be a subset of what the connection requested; an empty grant
 *       returns it to pending. A revoked connection cannot be re-granted. The effective authority is
 *       always the grant intersected with the bound user's own capabilities.
 *     tags: [Agents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               granted:
 *                 type: array
 *                 items: { type: string }
 *     responses:
 *       200:
 *         description: The updated connection.
 *       400:
 *         description: The grant exceeds the request, or names an unknown capability.
 *       403:
 *         description: Not an administrator.
 */
router.put('/:id/grant', authenticate, sessionOnly, can('manage_api_tokens'), asyncHandler(async (req: Request, res: Response) => {
    if (!isAdministrator(req)) return forbidden(res, 'Only an administrator can grant capabilities to an agent.');
    const rec = await connectionForCaller(req, res);
    if (!rec) return;
    if (rec.status === 'revoked') {
        return res.status(409).json({ code: 'rest_agent_revoked', message: 'This connection was revoked; create a new one.', data: { status: 409 } });
    }
    const granted = (req.body || {}).granted;
    const bad = invalidAgentCapabilities(granted);
    if (bad.length) {
        return res.status(400).json({ code: 'rest_invalid_capability', message: `Unknown agent capability: ${bad.join(', ')}.`, data: { status: 400 } });
    }
    const within = grantWithinRequest(rec.requested, granted);
    if (!within.ok) {
        return res.status(400).json({
            code: 'rest_grant_exceeds_request',
            message: `A grant can only include what the connection requested. Not requested: ${within.excess.join(', ')}.`,
            data: { status: 400 }
        });
    }
    const changed = await AgentConnection.setGrant(rec.id, within.grant, req.user.id);
    if (!changed) {
        return res.status(409).json({ code: 'rest_agent_revoked', message: 'This connection was revoked; create a new one.', data: { status: 409 } });
    }
    await recordAudit(req.user.id, 'agent.grant', 'agent', rec.id, { previous: rec.granted, granted: within.grant, boundUser: rec.userId });
    res.json({ connection: await present(await AgentConnection.findById(rec.id)) });
}));

/**
 * @swagger
 * /agents/{id}:
 *   delete:
 *     summary: Revoke an AI agent connection
 *     description: The bound user or an administrator may revoke. Revocation is immediate and terminal.
 *     tags: [Agents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Revoked.
 *       404:
 *         description: Not found, not yours, or already revoked.
 */
router.delete('/:id', authenticate, sessionOnly, can('manage_api_tokens'), asyncHandler(async (req: Request, res: Response) => {
    const rec = await connectionForCaller(req, res);
    if (!rec) return;
    const ok = await AgentConnection.revoke(rec.id);
    if (!ok) return notFound(res);
    await recordAudit(req.user.id, 'agent.revoke', 'agent', rec.id, { name: rec.name, boundUser: rec.userId });
    res.json({ revoked: true, id: rec.id });
}));

/**
 * @swagger
 * /agents/{id}/audit:
 *   get:
 *     summary: The audit trail of one AI agent connection
 *     description: Creation, grants, revocation and every write (or refused call) the agent made, newest first.
 *     tags: [Agents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: per_page
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: A page of audit entries.
 */
router.get('/:id/audit', authenticate, sessionOnly, can('manage_api_tokens'), asyncHandler(async (req: Request, res: Response) => {
    const rec = await connectionForCaller(req, res);
    if (!rec) return;
    const perPage = Math.min(Math.max(parseInt(String(req.query.per_page), 10) || 50, 1), 200);
    const page = Math.max(parseInt(String(req.query.page), 10) || 1, 1);
    const result = await listAuditForTarget('agent', rec.id, { limit: perPage, offset: (page - 1) * perPage });
    res.json({ entries: result.rows, total: result.total, page, perPage });
}));

module.exports = router;
