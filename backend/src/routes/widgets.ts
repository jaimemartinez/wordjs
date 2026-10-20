/**
 * WordJS - Widgets Routes
 * /api/v1/widgets/*
 */

const express = require('express');
const router = express.Router();
const {
    getWidgets, getSidebars, getSidebarWidgets,
    addWidgetToSidebar, removeWidgetFromSidebar,
    setWidgetSettings, getWidgetSettings, renderSidebar,
    getWidget, sanitizeWidgetSettings
} = require('../core/widgets');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
import type { Request, Response } from 'express';

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
router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const widgets = getWidgets();
    res.json(widgets.map((w: any) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        // The settings form of an instance (core/widgets WidgetField); null for a widget without one.
        fields: w.fields,
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
router.get('/sidebars', asyncHandler(async (req: Request, res: Response) => {
    const sidebars = getSidebars();
    // We need to resolve widgets for each sidebar async
    const result = await Promise.all(sidebars.map(async (s: any) => ({
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
router.get('/sidebars/:id/render', asyncHandler(async (req: Request, res: Response) => {
    const html = await renderSidebar(req.params.id);
    // Anonymous text/html on the API origin, which is same-origin with the admin. The frontend fetches
    // this as text and sanitizes it before painting it (PublicSidebar → sanitizeHTML), so these headers
    // change nothing for it; they only matter when the URL is NAVIGATED to directly, where the markup
    // would otherwise run as a document of this origin. Same policy as the uploads route in index.ts:
    // no script, no subresources, and a sandboxed (opaque) origin.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
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
router.post('/sidebars/:id', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const { widgetId, settings = {} } = req.body;

    if (!widgetId) {
        return res.status(400).json({ error: 'Widget ID required' });
    }
    const widget = getWidget(widgetId);
    if (!widget) return res.status(404).json({ error: 'Unknown widget' });
    // The same rule as editing an instance: only the widget's own fields, coerced and bounded.
    const clean = sanitizeWidgetSettings(widget, settings);
    if (!clean.ok) return res.status(400).json({ error: clean.error });

    const instanceKey = await addWidgetToSidebar(req.params.id, widgetId, clean.settings);
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
router.post('/sidebars/:id/reorder', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
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
router.delete('/sidebars/:sidebarId/:instanceKey', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const result = await removeWidgetFromSidebar(req.params.sidebarId, req.params.instanceKey);
    res.json({ success: result });
}));

/**
 * @swagger
 * /widgets/{widgetId}/instances/{instanceId}:
 *   get:
 *     summary: Read a widget instance's settings
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
 *     responses:
 *       200:
 *         description: The instance's settings ({ settings, fields })
 *       404:
 *         description: Unknown widget
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
router.get('/:widgetId/instances/:instanceId', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const widget = getWidget(String(req.params.widgetId));
    if (!widget) return res.status(404).json({ error: 'Unknown widget' });
    res.json({ settings: await getWidgetSettings(widget.id, String(req.params.instanceId)), fields: widget.fields });
}));

router.put('/:widgetId/instances/:instanceId', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const widget = getWidget(String(req.params.widgetId));
    if (!widget) return res.status(404).json({ error: 'Unknown widget' });
    const clean = sanitizeWidgetSettings(widget, (req.body && req.body.settings) ?? {});
    if (!clean.ok) return res.status(400).json({ error: clean.error });
    await setWidgetSettings(widget.id, String(req.params.instanceId), clean.settings);
    res.json({ success: true, settings: clean.settings });
}));

module.exports = router;
