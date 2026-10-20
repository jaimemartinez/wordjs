/**
 * WordJS — the server settings an administrator used to set in wordjs-config.json or an environment
 * variable and then restart for (zero config): Security → Server.
 *
 *   GET /system/server   the reverse-proxy trust and the log level, what is in force and where it comes from
 *   PUT /system/server   change them (re-authenticates: currentPassword), audited; the backend restarts itself
 *
 * trustProxy decides which address a request is counted against — the login lockout, the rate limits and
 * the audit log all key on it — so a wrong value either lumps every visitor into the proxy's address or
 * lets a client choose its own. The panel therefore offers only address-based values (the presets and
 * IP addresses / subnets), never `true` or a hop count, and changing it takes the password and an
 * interactive session at the main address (accountAuthorityOnly). Main site only, network administrators
 * on a network (routes/index.ts). An environment variable still wins over the file for the log level
 * (LOG_LEVEL), as it always did: the screen says so instead of pretending.
 */
import type { Request, Response } from 'express';

const express = require('express');
const net = require('net');
const router = express.Router();
const { authenticate, sessionOnly, accountAuthorityOnly } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireSudoPassword } = require('./users');
const { recordAudit } = require('../core/audit');

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];
const TRUST_PRESETS = ['loopback', 'linklocal', 'uniquelocal'];

router.use(authenticate, isAdmin);

/** The panel's trust value: null (automatic) or a comma-separated list of presets, IPs and subnets. */
function checkedTrustProxy(raw: unknown): { ok: true; value: string | null } | { ok: false } {
    if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
    if (typeof raw !== 'string' || raw.length > 600) return { ok: false };
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length || parts.length > 20) return { ok: false };
    for (const p of parts) {
        if (TRUST_PRESETS.includes(p)) continue;
        const [addr, bits, extra] = p.split('/');
        if (extra !== undefined) return { ok: false };
        const kind = net.isIP(addr);
        if (!kind) return { ok: false };
        if (bits !== undefined && (!/^[0-9]{1,3}$/.test(bits) || Number(bits) > (kind === 4 ? 32 : 128))) return { ok: false };
    }
    return { ok: true, value: parts.join(', ') };
}

function fileConfig(): any { return require('../core/configManager').getConfig() || {}; }

function current() {
    const file = fileConfig();
    const config = require('../config/app');
    const fileTrust = file.trustProxy;
    const fileLevel = file.logging && file.logging.level;
    return {
        trustProxy: {
            value: fileTrust === undefined || fileTrust === null || fileTrust === '' ? null : String(fileTrust),
            inForce: config.trustProxy === null || config.trustProxy === undefined ? null : String(config.trustProxy),
            fromEnvironment: (fileTrust === undefined || fileTrust === null || fileTrust === '') && !!process.env.WORDJS_TRUST_PROXY,
            // In split mode the gateway is the first hop a visitor meets: the proxy in front of it is
            // trusted in gateway/gateway-config.json, and this value only says how far to trust the gateway.
            appliesToGateway: process.env.WORDJS_EMBEDDED !== '1',
        },
        logLevel: {
            value: typeof fileLevel === 'string' && LOG_LEVELS.includes(fileLevel) ? fileLevel : null,
            inForce: String((config.logging && config.logging.level) || 'info'),
            fromEnvironment: !!process.env.LOG_LEVEL,
        },
        restart: require('../core/restart').restartInfo(),
    };
}

/**
 * @swagger
 * /system/server:
 *   get:
 *     summary: The reverse-proxy trust and the log level (Security → Server)
 *     description: What wordjs-config.json says, what is in force, and whether an environment variable decides it instead. Administrators of the main site (network administrators on a network).
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ trustProxy: { value, inForce, fromEnvironment, appliesToGateway }, logLevel: { value, inForce, fromEnvironment }, restart }"
 *       403:
 *         description: Not an administrator
 *   put:
 *     summary: Change the reverse-proxy trust and the log level, then restart
 *     description: trustProxy is null (automatic for the deployment mode) or a comma-separated list of loopback, linklocal, uniquelocal, IP addresses and subnets. logLevel is error, warn, info, debug or null (info). Re-authenticates with currentPassword; an interactive session at the main address only; audited (system.server.update); the backend then restarts itself to apply it.
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
 *               trustProxy:
 *                 type: string
 *                 nullable: true
 *               logLevel:
 *                 type: string
 *                 nullable: true
 *                 enum: [error, warn, info, debug]
 *               currentPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ ...the new state, restart } — restart is supervisor, watch or service, or manual (restart it by hand)"
 *       400:
 *         description: An invalid value (rest_invalid_param, params names the field)
 *       403:
 *         description: Not an administrator, a wrong currentPassword, an API token or a session from another address
 */
router.get('/', (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.json(current());
});

router.put('/', sessionOnly, accountAuthorityOnly, asyncHandler(async (req: Request, res: Response) => {
    const b = req.body || {};
    const bad = (param: string, message: string) => res.status(400).json({ code: 'rest_invalid_param', message, data: { status: 400, params: [param] } });
    const changes: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(b, 'trustProxy')) {
        const t = checkedTrustProxy(b.trustProxy);
        if (!t.ok) return bad('trustProxy', 'Trust is "loopback", "linklocal", "uniquelocal" or IP addresses and subnets (such as 10.0.0.0/8), separated by commas; empty for automatic.');
        changes.trustProxy = t.value;
    }
    if (Object.prototype.hasOwnProperty.call(b, 'logLevel')) {
        const l = b.logLevel === '' ? null : b.logLevel;
        if (l !== null && !LOG_LEVELS.includes(l)) return bad('logLevel', `The log level is one of ${LOG_LEVELS.join(', ')}.`);
        changes.logLevel = l;
    }
    if (await requireSudoPassword(req, res, b.currentPassword)) return;
    if (!Object.keys(changes).length) return res.json({ ...current(), restart: null });

    const r = require('../core/configManager').updateConfig((c: any) => {
        const next = { ...c };
        if ('trustProxy' in changes) {
            if (changes.trustProxy === null) delete next.trustProxy;
            else next.trustProxy = changes.trustProxy;
        }
        if ('logLevel' in changes) {
            const logging = { ...(c.logging || {}) };
            if (changes.logLevel === null) delete logging.level;
            else logging.level = changes.logLevel;
            next.logging = logging;
        }
        return next;
    }, { reload: false });
    if (!r.ok) return res.status(500).json({ code: 'rest_config_unwritable', message: 'wordjs-config.json could not be written.', data: { status: 500 } });
    await recordAudit(req.user && req.user.id, 'system.server.update', 'config', '', { fields: Object.keys(changes), ...changes });
    // Both are read when the process starts (the Express `trust proxy` setting, the logger): restart.
    const mode = require('../core/restart').scheduleRestart('server settings changed in the panel');
    res.json({ ...current(), restart: mode });
}));

module.exports = router;
module.exports.checkedTrustProxy = checkedTrustProxy;
