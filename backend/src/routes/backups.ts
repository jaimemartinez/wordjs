/**
 * WordJS - Backup Routes
 * /api/v1/backups
 */

const express = require('express');
const router = express.Router();
const { createBackup, listBackups, deleteBackup, getBackupPath, restoreBackup } = require('../core/backup');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');

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
router.get('/', authenticate, isAdmin, asyncHandler(async (req, res) => {
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
router.post('/', authenticate, isAdmin, asyncHandler(async (req, res) => {
    // Potentially long running, might want to increase timeout or use background job in future
    const result = await createBackup();
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
router.delete('/:filename', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const success = deleteBackup(req.params.filename);
    if (!success) {
        return res.status(404).json({ error: 'Backup not found' });
    }
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
router.get('/:filename/download', authenticate, isAdmin, asyncHandler(async (req, res) => {
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
router.post('/:filename/restore', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const results = await restoreBackup(req.params.filename);
    res.json({ success: true, results });
}));

module.exports = router;
