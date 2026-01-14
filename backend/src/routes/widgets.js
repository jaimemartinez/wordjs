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
 * GET /widgets
 * List all available widgets
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
 * GET /widgets/sidebars
 * List all sidebars with their widgets
 */
router.get('/sidebars', asyncHandler(async (req, res) => {
    const sidebars = getSidebars();
    res.json(sidebars.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        widgets: getSidebarWidgets(s.id)
    })));
}));

/**
 * GET /widgets/sidebars/:id/render
 * Render a sidebar's widgets as HTML
 */
router.get('/sidebars/:id/render', asyncHandler(async (req, res) => {
    const html = renderSidebar(req.params.id);
    res.type('html').send(html);
}));

/**
 * POST /widgets/sidebars/:id
 * Add widget to sidebar
 */
router.post('/sidebars/:id', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const { widgetId, settings = {} } = req.body;

    if (!widgetId) {
        return res.status(400).json({ error: 'Widget ID required' });
    }

    const instanceKey = addWidgetToSidebar(req.params.id, widgetId, settings);
    res.json({ success: true, instanceKey });
}));

/**
 * POST /widgets/sidebars/:id/reorder
 * Reorder widgets in sidebar
 */
router.post('/sidebars/:id/reorder', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const { widgets } = req.body; // Array of instance keys
    const { setSidebarWidgets } = require('../core/widgets');

    if (!Array.isArray(widgets)) {
        return res.status(400).json({ error: 'Widgets array required' });
    }

    setSidebarWidgets(req.params.id, widgets);
    res.json({ success: true });
}));

/**
 * DELETE /widgets/sidebars/:sidebarId/:instanceKey
 * Remove widget from sidebar
 */
router.delete('/sidebars/:sidebarId/:instanceKey', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const result = removeWidgetFromSidebar(req.params.sidebarId, req.params.instanceKey);
    res.json({ success: result });
}));

/**
 * PUT /widgets/:widgetId/instances/:instanceId
 * Update widget instance settings
 */
router.put('/:widgetId/instances/:instanceId', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const { settings } = req.body;
    setWidgetSettings(req.params.widgetId, req.params.instanceId, settings || {});
    res.json({ success: true });
}));

module.exports = router;
