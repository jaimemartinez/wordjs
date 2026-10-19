/**
 * WordJS — the MCP endpoint (Model Context Protocol, Streamable HTTP transport).
 *
 * POST /api/v1/mcp carries JSON-RPC messages from an MCP client (Claude Code, Claude Desktop, any agent
 * framework). It runs STATELESS: every request authenticates on its own and gets a fresh server built for
 * that connection (core/mcp-server), and the answer is plain JSON (`enableJsonResponse`), never a held-open
 * stream. That is what makes it work unchanged behind the gateway, in monolith mode and on N nodes with no
 * sticky sessions — there is no session state to route back to. GET (the optional server→client stream)
 * and DELETE (session teardown) therefore answer 405, as the specification allows for a stateless server.
 *
 * AUTH: `Authorization: Bearer wja_…` — an agent connection token (models/AgentConnection), and nothing
 * else. A session cookie or a `wjt_` API token is refused here, so an agent's identity is always one an
 * administrator reviewed, and an agent token is refused everywhere else (the REST `authenticate` does not
 * know the prefix). CSRF does not apply (no ambient credential); the host gate, CORS and the limiters
 * mounted in index.ts do.
 */

import type { Request, Response, NextFunction } from 'express';

const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const AgentConnection = require('../models/AgentConnection');
const User = require('../models/User');
const { narrowUser } = require('../core/agent-capabilities');

function jsonRpcError(res: Response, httpStatus: number, message: string, code = -32001) {
    if (httpStatus === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="wordjs-mcp"');
    res.status(httpStatus).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

async function agentAuth(req: Request, res: Response, next: NextFunction) {
    const header = String(req.headers.authorization || '');
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!raw.startsWith(AgentConnection.PREFIX)) {
        return jsonRpcError(res, 401, 'An agent connection token (Bearer wja_…) is required. Create one under Admin → AI agents.');
    }
    const rec = await AgentConnection.findByRawToken(raw);
    if (!rec) return jsonRpcError(res, 401, 'Invalid, expired or revoked agent token.');
    const user = await User.findById(rec.userId);
    if (!user) return jsonRpcError(res, 401, 'The user this agent acts for no longer exists.');
    // Handed to the handler through res.locals — no new request mark (src/types/globals.d.ts declares those).
    res.locals.agentConnection = rec;
    res.locals.agentUser = user;
    AgentConnection.touch(rec.id);
    next();
}

/**
 * @swagger
 * /mcp:
 *   post:
 *     summary: Model Context Protocol endpoint for AI agents
 *     description: >-
 *       JSON-RPC 2.0 over the MCP Streamable HTTP transport, stateless, JSON responses. Authenticate with an
 *       agent connection token (`Authorization: Bearer wja_…`); the tools offered are exactly those the
 *       connection was granted, and every call runs with the bound user's capabilities narrowed by that
 *       grant. Clients must send `Accept: application/json, text/event-stream`.
 *     tags: [Agents]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: A JSON-RPC response.
 *       202:
 *         description: A notification or response was accepted (no body).
 *       401:
 *         description: Missing or invalid agent token.
 *   get:
 *     summary: Server-to-client stream (not offered)
 *     description: This server is stateless and never opens a stream; answers 405.
 *     tags: [Agents]
 *     security: []
 *     responses:
 *       405:
 *         description: Method not allowed.
 *   delete:
 *     summary: Session teardown (not offered)
 *     description: This server is stateless and issues no session id; answers 405.
 *     tags: [Agents]
 *     security: []
 *     responses:
 *       405:
 *         description: Method not allowed.
 */
router.post('/', agentAuth, asyncHandler(async (req: Request, res: Response) => {
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { buildMcpServer } = require('../core/mcp-server');
    const rec = res.locals.agentConnection;
    const user = res.locals.agentUser;
    const grants = rec.status === 'active' ? rec.granted : [];
    // While the site requires a person to confirm what agents publish (core/agent-publishing), the user
    // the calls run as does not hold `content:publish`: REST then files an agent's publish as pending.
    const { publishConfirmationRequired, grantsForNarrowing } = require('../core/agent-publishing');
    const confirmationRequired = await publishConfirmationRequired();
    const server = buildMcpServer({
        connection: rec,
        user,
        narrowed: narrowUser(user, grantsForNarrowing(grants, confirmationRequired)),
        origin: req,
        publishConfirmationRequired: confirmationRequired,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
        transport.close().catch(() => { /* already closed */ });
        server.close().catch(() => { /* already closed */ });
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
}));

const notAllowed = (_req: Request, res: Response) => {
    res.setHeader('Allow', 'POST');
    jsonRpcError(res, 405, 'Method not allowed: this MCP server is stateless and only accepts POST.', -32000);
};
router.get('/', notAllowed);
router.delete('/', notAllowed);

module.exports = router;
