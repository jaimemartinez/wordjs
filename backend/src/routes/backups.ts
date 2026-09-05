/**
 * WordJS - Backup Routes
 * /api/v1/backups
 */

import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const { createBackup, listBackups, deleteBackup, getBackupPath, restoreBackup } = require('../core/backup');
const { authenticate } = require('../middleware/auth');
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
 */
router.post('/', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
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
 */
router.get('/:filename/download', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
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
 */
router.post('/:filename/restore', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const results = await restoreBackup(req.params.filename);
    // AFTER the swap — see the note next to the recordAudit import.
    await recordAudit(req.user && req.user.id, 'backup.restore', 'backup', req.params.filename, {});
    res.json({ success: true, results });
}));

module.exports = router;
