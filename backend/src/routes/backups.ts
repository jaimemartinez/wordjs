/**
 * WordJS - Backup Routes
 * /api/v1/backups
 */

import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const { createBackup, listBackups, deleteBackup, getBackupPath, restoreBackup } = require('../core/backup');
// accountAuthorityOnly: a restore replaces the accounts and roles with the snapshot's (and, from a full
// snapshot, the passwords, two-factor enrolments, API tokens, plugin grants and registration settings), so
// it is not for an API token nor for a session started at an address other than the main one
// (middleware/auth.ts refuseAccountAuthority).
// credentialExportSessionOnly: an archive IS a copy of those credentials (the physical database snapshot
// holds the bcrypt password hashes, the two-factor seeds in user_meta and the API token hashes; the
// plugins/ tree holds plugin secrets with the key files that decrypt them), so an API token may neither
// have one written nor download one (middleware/auth.ts refuseCredentialExportByToken).
const { authenticate, accountAuthorityOnly, credentialExportSessionOnly } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
// A RESTORE IS THE MOST DESTRUCTIVE OPERATION THE PRODUCT OFFERS: it replaces the database and the
// uploads with somebody else's snapshot, and everything written since that snapshot — including the
// audit rows describing whatever preceded it — goes with it. Hence the ORDER below: the restore row is
// written AFTER the swap, into the restored database, which is the only copy that still exists once
// the operation finishes. (A restore that throws leaves no row: there is no database left to put one
// in that a reader would ever see.)
const { recordAudit } = require('../core/audit');

/**
 * @swagger
 * tags:
 *   name: Backups
 *   description: System backup and restore
 */

/**
 * @swagger
 * /backups:
 *   get:
 *     summary: List all backups
 *     tags: [Backups]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of backup files
 */
router.get('/', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const files = listBackups();
    res.json(files);
}));

/**
 * @swagger
 * /backups:
 *   post:
 *     summary: Create a new backup
 *     tags: [Backups]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Backup created details
 *       403:
 *         description: >-
 *           Not an administrator, or rest_token_management_forbidden (an API token). The archive is a copy
 *           of the credentials at rest (password hashes, two-factor secrets, API token hashes, plugin
 *           secrets), so a token may not have one written; scheduled backups run in the server's own cron.
 */
router.post('/', authenticate, isAdmin, credentialExportSessionOnly, asyncHandler(async (req: Request, res: Response) => {
    // Potentially long running, might want to increase timeout or use background job in future
    const result = await createBackup();
    await recordAudit(req.user && req.user.id, 'backup.create', 'backup', (result && result.filename) || '', {
        size: (result && result.size) != null ? result.size : null
    });
    res.json(result);
}));

/**
 * @swagger
 * /backups/{filename}:
 *   delete:
 *     summary: Delete a backup
 *     tags: [Backups]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: filename
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Backup deleted
 */
router.delete('/:filename', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const success = deleteBackup(req.params.filename);
    if (!success) {
        return res.status(404).json({ error: 'Backup not found' });
    }
    // Recorded only on the path that actually removed a file — a 404 destroyed nothing.
    await recordAudit(req.user && req.user.id, 'backup.delete', 'backup', req.params.filename, {});
    res.json({ success: true });
}));

/**
 * @swagger
 * /backups/{filename}/download:
 *   get:
 *     summary: Download a backup file
 *     tags: [Backups]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: filename
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Backup zip file
 *       403:
 *         description: >-
 *           Not an administrator, or rest_token_management_forbidden (an API token): the archive holds the
 *           password hashes, the two-factor secrets, the API token hashes and the plugins' secrets, which is
 *           what an interactive login needs, so it is never handed to a token.
 */
router.get('/:filename/download', authenticate, isAdmin, credentialExportSessionOnly, asyncHandler(async (req: Request, res: Response) => {
    const filepath = getBackupPath(req.params.filename);
    if (!filepath) {
        return res.status(404).json({ error: 'Backup not found' });
    }
    res.download(filepath);
}));

/**
 * @swagger
 * /backups/{filename}/restore:
 *   post:
 *     summary: Restore a backup (Destructive!)
 *     tags: [Backups]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: filename
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Restore results
 *       403:
 *         description: >-
 *           Not an administrator, rest_token_management_forbidden (an API token), or
 *           rest_account_bound_session (a session started at an address other than the main one). A
 *           restore replaces the accounts and roles with the snapshot's (and, from a full snapshot, the
 *           passwords, two-factor enrolments, API tokens, plugin grants and registration settings), so it is
 *           refused to both before anything is read or written.
 */
// THE SAME AUTHORITY AS THE ACCOUNT IMPORT, AND MORE. The logical path of a restore is importSite with
// importUsers + updateExisting (the very write POST /import refuses to an API token), and the physical
// path swaps the whole database file: an administrator demoted since the snapshot is an administrator
// again, with the password and the second factor they had then, and the plugins/ and themes/ code of the
// snapshot is written back. Revoking the token that asked for it would undo none of that.
router.post('/:filename/restore', authenticate, isAdmin, accountAuthorityOnly, asyncHandler(async (req: Request, res: Response) => {
    const results = await restoreBackup(req.params.filename);
    // AFTER the swap — see the note next to the recordAudit import.
    await recordAudit(req.user && req.user.id, 'backup.restore', 'backup', req.params.filename, {});
    res.json({ success: true, results });
}));

module.exports = router;
