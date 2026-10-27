/**
 * WordJS — Admin → Site Health → Duplicate records (core/unique-integrity).
 *
 *   GET  /database-integrity                     every uniqueness rule: enforced by its index, or how many values collide
 *   GET  /database-integrity/:rule/duplicates    the colliding values of one rule, with their rows
 *   POST /database-integrity/resolve             one value: the chosen row keeps it, the others get a new unique one
 *   POST /database-integrity/enforce             build every unique index that can be built now
 *
 * Administrators of the site (each site of a network has its own database). Resolving changes logins,
 * email addresses or URLs, so it re-authenticates (currentPassword, plus a current code with 2FA), returns
 * every change it made, and audits it. Nothing is ever deleted.
 */

import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireSudoPassword } = require('./users');
const integrity = require('../core/unique-integrity');
const { recordAudit } = require('../core/audit');

router.use(authenticate, isAdmin);

function badRule(res: Response) {
    return res.status(400).json({ code: 'rest_invalid_param', message: `rule must be one of ${integrity.RULE_IDS.join(', ')}.`, data: { status: 400, params: ['rule'] } });
}

/**
 * @swagger
 * /database-integrity:
 *   get:
 *     summary: The database's uniqueness rules and whether each is enforced
 *     description: One entry per rule (users.login, users.email, posts.slug, terms.slug) with the unique index that enforces it, whether it exists, and how many stored values collide when it does not.
 *     tags: [Database integrity]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ rules: [{ id, table, index, enforced, duplicateGroups }] }"
 *       403:
 *         description: Not an administrator
 */
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.json({ rules: await integrity.uniqueIntegrityStatus() });
}));

/**
 * @swagger
 * /database-integrity/{rule}/duplicates:
 *   get:
 *     summary: The values that collide under one rule, each with its rows
 *     tags: [Database integrity]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: rule
 *         required: true
 *         schema: { type: string, enum: [users.login, users.email, posts.slug, terms.slug] }
 *     responses:
 *       200:
 *         description: "{ rule, groups: [{ key, count, rows }] }"
 *       400:
 *         description: Unknown rule (rest_invalid_param)
 */
router.get('/:rule/duplicates', asyncHandler(async (req: Request, res: Response) => {
    const rule = req.params.rule;
    if (!integrity.ruleById(rule)) return badRule(res);
    res.set('Cache-Control', 'no-store');
    res.json({ rule, groups: await integrity.listDuplicates(rule, { limit: Number(req.query.limit) || 50 }) });
}));

/**
 * @swagger
 * /database-integrity/resolve:
 *   post:
 *     summary: Resolve one duplicated value
 *     description: The row named by keepId keeps the value; every other row of the group gets a new unique one (a login with its id, the same mailbox with a +dup tag, a slug with a number). Nothing is deleted; previous logins and emails are kept in the account's meta, the changes are returned and audited, and the rule's unique index is built when nothing else collides. Re-authenticates with currentPassword, plus mfaCode when the account has two-factor authentication.
 *     tags: [Database integrity]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rule, key, keepId, currentPassword]
 *             properties:
 *               rule: { type: string }
 *               key: { type: string }
 *               keepId: { type: integer }
 *               currentPassword: { type: string }
 *               mfaCode: { type: string }
 *     responses:
 *       200:
 *         description: "{ changes: [{ id, field, from, to }], rules }"
 *       400:
 *         description: Unknown rule, or keepId is not part of the group (rest_invalid_param)
 *       403:
 *         description: Wrong currentPassword (rest_bad_current_password) or a missing 2FA code (rest_mfa_step_up_required)
 *       404:
 *         description: The value is no longer duplicated (rest_duplicate_gone)
 */
router.post('/resolve', asyncHandler(async (req: Request, res: Response) => {
    const b = req.body || {};
    if (!integrity.ruleById(b.rule)) return badRule(res);
    if (typeof b.key !== 'string' || !Number.isInteger(Number(b.keepId)) || Number(b.keepId) <= 0) {
        return res.status(400).json({ code: 'rest_invalid_param', message: 'key (string) and keepId (integer) are required.', data: { status: 400, params: ['key', 'keepId'] } });
    }
    if (await requireSudoPassword(req, res, b.currentPassword)) return;
    const reauth = await require('./network').requireStepUp(req, res);
    if (!reauth) return;
    let changes;
    try {
        changes = await integrity.resolveDuplicate(b.rule, b.key, Number(b.keepId));
    } catch (e: any) {
        if (e && e.status) return res.status(e.status).json({ code: e.code || 'rest_invalid_param', message: e.message, data: { status: e.status } });
        throw e;
    }
    await recordAudit(req.user.id, 'database.duplicates.resolve', 'database', b.rule, {
        rule: b.rule, keptId: Number(b.keepId), changedIds: changes.map((c: any) => c.id), fields: [...new Set(changes.map((c: any) => c.field))], reauth,
    });
    await integrity.ensureUniqueIndexes();
    res.json({ changes, rules: await integrity.uniqueIntegrityStatus() });
}));

/**
 * @swagger
 * /database-integrity/enforce:
 *   post:
 *     summary: Build every unique index that can be built now
 *     description: The same step every boot runs; after duplicates are resolved it saves waiting for a restart.
 *     tags: [Database integrity]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ enforced, missing, rules }"
 */
router.post('/enforce', asyncHandler(async (_req: Request, res: Response) => {
    const r = await integrity.ensureUniqueIndexes();
    res.json({ ...r, rules: await integrity.uniqueIntegrityStatus() });
}));

module.exports = router;
