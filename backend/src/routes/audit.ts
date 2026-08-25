/**
 * WordJS — Audit trail route (FRENTE C-3)
 * GET /api/v1/audit — paginated, admin-only, read-only view of the append-only audit_log.
 *
 * There is deliberately NO write/update/delete route: the log is written only by core/audit.recordAudit
 * at the mutation sites, and it is append-only by design.
 */

import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { listAudit } = require('../core/audit');

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

module.exports = router;
