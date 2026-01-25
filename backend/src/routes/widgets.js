/**
 * WordJS - Widgets Routes
 * /api/v1/widgets/*
 */

const express = require('express');
const router = express.Router();
const {
    getWidgets, getSidebars, getSidebarWidgets,
    addWidgetToSidebar, removeWidgetFromSidebar,
    setWidgetSettings, renderSidebar
} = require('../core/widgets');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * @swagger
 * tags:
 *   name: Widgets
 *   description: Sidebar and widget management
 */

/**
 * @swagger
 * /widgets:
 *   get:
 *     summary: List available widgets
 *     tags: [Widgets]
 *     responses:
 *       200:
 *         description: List of widgets
 */
router.get('/', asyncHandler(async (req, res) => {
    const widgets = getWidgets();
    res.json(widgets.map(w => ({
        id: w.id,
        name: w.name,
        description: w.description
    })));
}));

/**
 * @swagger
 * /widgets/sidebars:
 *   get:
 *     summary: List sidebars and their widgets
 *     tags: [Widgets]
 *     responses:
 *       200:
 *         description: List of sidebars
 */
router.get('/sidebars', asyncHandler(async (req, res) => {
    const sidebars = getSidebars();
    // We need to resolve widgets for each sidebar async
    const result = await Promise.all(sidebars.map(async s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        widgets: await getSidebarWidgets(s.id)
    })));
    res.json(result);
}));

/**
 * @swagger
 * /widgets/sidebars/{id}/render:
 *   get:
 *     summary: Render sidebar HTML
 *     tags: [Widgets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: HTML content
 */
router.get('/sidebars/:id/render', asyncHandler(async (req, res) => {
    const html = await renderSidebar(req.params.id);
    res.type('html').send(html);
}));

/**
 * @swagger
 * /widgets/sidebars/{id}:
 *   post:
 *     summary: Add widget to sidebar
 *     tags: [Widgets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [widgetId]
 *             properties:
 *               widgetId:
 *                 type: string
 *               settings:
 *                 type: object
 *     responses:
 *       200:
 *         description: Widget added
 */
router.post('/sidebars/:id', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const { widgetId, settings = {} } = req.body;

    if (!widgetId) {
        return res.status(400).json({ error: 'Widget ID required' });
    }

    const instanceKey = await addWidgetToSidebar(req.params.id, widgetId, settings);
    res.json({ success: true, instanceKey });
}));

/**
 * @swagger
 * /widgets/sidebars/{id}/reorder:
 *   post:
 *     summary: Reorder widgets in sidebar
 *     tags: [Widgets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [widgets]
 *             properties:
 *               widgets:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Widgets reordered
 */
router.post('/sidebars/:id/reorder', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const { widgets } = req.body; // Array of instance keys
    const { setSidebarWidgets } = require('../core/widgets');

    if (!Array.isArray(widgets)) {
        return res.status(400).json({ error: 'Widgets array required' });
    }

    await setSidebarWidgets(req.params.id, widgets);
    res.json({ success: true });
}));

/**
 * @swagger
 * /widgets/sidebars/{sidebarId}/{instanceKey}:
 *   delete:
 *     summary: Remove widget from sidebar
 *     tags: [Widgets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sidebarId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: instanceKey
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Widget removed
 */
router.delete('/sidebars/:sidebarId/:instanceKey', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const result = await removeWidgetFromSidebar(req.params.sidebarId, req.params.instanceKey);
    res.json({ success: result });
}));

/**
 * @swagger
 * /widgets/{widgetId}/instances/{instanceId}:
 *   put:
 *     summary: Update widget instance settings
 *     tags: [Widgets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: widgetId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: instanceId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               settings:
 *                 type: object
 *     responses:
 *       200:
 *         description: Settings updated
 */
router.put('/:widgetId/instances/:instanceId', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const { settings } = req.body;
    await setWidgetSettings(req.params.widgetId, req.params.instanceId, settings || {});
    res.json({ success: true });
}));

module.exports = router;
