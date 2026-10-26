/**
 * WordJS — Audit trail route (FRENTE C-3)
 * GET /api/v1/audit — paginated, admin-only, read-only view of the append-only audit_log.
 * GET /api/v1/audit/verify — walks the hash chain over the rows (core/audit-chain) and names the first break.
 * GET/PUT /api/v1/audit/settings — how long rows are kept, and the external copy (core/audit-export).
 * POST /api/v1/audit/export/test, /export/flush — try the external copy, deliver what is waiting.
 *
 * There is deliberately NO route that updates or deletes a row: the log is written only by
 * core/audit.recordAudit at the mutation sites, and it is append-only by design. Anything that makes the
 * log keep LESS (a shorter retention) or changes where its external copy goes re-authenticates.
 */

import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { listAudit, recordAudit, auditRetentionDays, retentionShortens, AUDIT_RETENTION_CHOICES } = require('../core/audit');
const chain = require('../core/audit-chain');
const auditExport = require('../core/audit-export');
const { requireSudoPassword } = require('./users');

/**
 * @swagger
 * /audit:
 *   get:
 *     summary: Read the append-only audit log (admin only)
 *     tags: [Audit]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: per_page
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: A page of audit entries, newest first.
 *       403:
 *         description: Forbidden (not an administrator).
 */
router.get('/', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const perPage = Math.min(Math.max(parseInt(String(req.query.per_page), 10) || 50, 1), 200);
    const page = Math.max(parseInt(String(req.query.page), 10) || 1, 1);
    const offset = (page - 1) * perPage;
    const result = await listAudit({ limit: perPage, offset });
    res.set('X-WP-Total', String(result.total));
    res.set('X-WP-TotalPages', String(Math.max(1, Math.ceil(result.total / perPage))));
    res.json({ entries: result.rows, total: result.total, page, perPage });
}));


/**
 * @swagger
 * /audit/verify:
 *   get:
 *     summary: Check the audit log's hash chain (admin only)
 *     description: Recomputes every sealed row's hash in chain order and checks that each row links to the one before it, with no gap. ok is false when a row was changed (altered), removed (gap / link) or the oldest remaining row does not match the retention anchor (start); firstBreak names the place. pending counts rows not sealed yet.
 *     tags: [Audit]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ ok, complete, checked, pending, oldestPendingAt, head, anchor, firstBreak }"
 */
router.get('/verify', authenticate, isAdmin, asyncHandler(async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    await chain.sealPending();
    res.json(await chain.verifyAuditChain());
}));

/**
 * @swagger
 * /audit/settings:
 *   get:
 *     summary: Retention and the external copy of the audit log (admin only)
 *     tags: [Audit]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ retentionDays, choices, export: { config, hasSecret, cursor, behind, lastSuccessAt, lastError } } — never the secret"
 *   put:
 *     summary: Change the retention or the external copy (admin only)
 *     description: Keeping the log for a SHORTER time, or changing the external copy in any way, re-authenticates with currentPassword (plus mfaCode with two-factor authentication). Keeping it longer does not.
 *     tags: [Audit]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               retentionDays: { type: integer, enum: [0, 90, 180, 365, 730] }
 *               export:
 *                 type: object
 *                 properties:
 *                   mode: { type: string, enum: [off, syslog, webhook] }
 *                   host: { type: string }
 *                   port: { type: integer }
 *                   transport: { type: string, enum: [udp, tcp, tls] }
 *                   url: { type: string }
 *                   allowPrivate: { type: boolean }
 *                   secret: { type: string, description: "Webhook signing secret; omit to keep the stored one, empty string to remove it" }
 *               currentPassword: { type: string }
 *               mfaCode: { type: string }
 *     responses:
 *       200:
 *         description: The saved settings (as GET)
 *       400:
 *         description: A value the screen does not offer (rest_invalid_param)
 *       403:
 *         description: Wrong currentPassword (rest_bad_current_password) or a missing 2FA code (rest_mfa_step_up_required)
 */
async function auditSettings() {
    return { retentionDays: await auditRetentionDays(), choices: AUDIT_RETENTION_CHOICES, export: await auditExport.exportStatus() };
}

router.get('/settings', authenticate, isAdmin, asyncHandler(async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.json(await auditSettings());
}));

const invalid = (res: Response, message: string, param: string) =>
    res.status(400).json({ code: 'rest_invalid_param', message, data: { status: 400, params: [param] } });

router.put('/settings', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const b = req.body || {};
    let retention: number | null = null;
    if (b.retentionDays !== undefined) {
        const n = typeof b.retentionDays === 'string' && b.retentionDays.trim() !== '' ? Number(b.retentionDays) : b.retentionDays;
        if (!AUDIT_RETENTION_CHOICES.includes(n)) return invalid(res, 'retentionDays must be 0, 90, 180, 365 or 730.', 'retentionDays');
        retention = n;
    }
    let exportConfig: any = null;
    let secret: string | undefined;
    if (b.export !== undefined) {
        if (!b.export || typeof b.export !== 'object' || Array.isArray(b.export)) return invalid(res, 'export must be an object.', 'export');
        exportConfig = auditExport.parseConfig(b.export);
        const problem = auditExport.configProblem(exportConfig);
        if (problem) return invalid(res, problem, 'export');
        if (b.export.secret !== undefined) {
            if (typeof b.export.secret !== 'string' || b.export.secret.length > 512) return invalid(res, 'secret must be text (at most 512 characters).', 'export.secret');
            secret = b.export.secret;
        }
    }

    const current = await auditRetentionDays();
    const currentExport = await auditExport.getConfig();
    const retentionChanges = retention !== null && retention !== current;
    const shortens = retention !== null && retentionShortens(current, retention);
    const exportChanges = exportConfig !== null && (JSON.stringify(exportConfig) !== JSON.stringify(currentExport) || secret !== undefined);
    let reauth: string | null = null;
    if (shortens || exportChanges) {
        if (await requireSudoPassword(req, res, b.currentPassword)) return;
        reauth = await require('./network').requireStepUp(req, res);
        if (!reauth) return;
    }

    if (retentionChanges) await require('../core/options').updateOption('audit_retention_days', String(retention));
    if (exportChanges) await auditExport.saveConfig(exportConfig, secret);
    if (retentionChanges || exportChanges) {
        await recordAudit(req.user.id, 'audit.settings.update', 'audit_log', '', {
            ...(retentionChanges ? { retentionFrom: current, retentionTo: retention } : {}),
            ...(exportChanges ? { exportMode: exportConfig.mode, exportTransport: exportConfig.mode === 'syslog' ? exportConfig.transport : exportConfig.mode } : {}),
            ...(reauth ? { reauth } : {}),
        });
    }
    res.json(await auditSettings());
}));

/**
 * @swagger
 * /audit/export/test:
 *   post:
 *     summary: Send one test event through the SAVED external copy (admin only)
 *     description: Uses the configuration saved with PUT /audit/settings — never an address from the request — and does not move the delivery position.
 *     tags: [Audit]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ ok: true } or { ok: false, error }"
 *       400:
 *         description: The external copy is off (rest_invalid_param)
 */
router.post('/export/test', authenticate, isAdmin, asyncHandler(async (_req: Request, res: Response) => {
    // Only where an administrator already pointed the copy (with the password): a test that took the
    // address from the request would be a way to make the server connect anywhere without re-authenticating.
    const c = await auditExport.getConfig();
    if (c.mode === 'off') return invalid(res, 'The external copy is off.', 'export');
    try {
        await auditExport.sendTest(c);
        res.json({ ok: true });
    } catch (e: any) {
        res.json({ ok: false, error: String((e && e.message) || e) });
    }
}));

/**
 * @swagger
 * /audit/export/flush:
 *   post:
 *     summary: Deliver the rows waiting for the external copy now (admin only)
 *     tags: [Audit]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ delivered, export }"
 */
router.post('/export/flush', authenticate, isAdmin, asyncHandler(async (_req: Request, res: Response) => {
    await chain.sealPending();
    const delivered = await auditExport.flushExport();
    res.json({ delivered, export: await auditExport.exportStatus() });
}));

module.exports = router;
