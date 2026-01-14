/**
 * WordJS - Menus Routes
 * /api/v1/menus/*
 */

const express = require('express');
const router = express.Router();
const { Menu, MenuItem } = require('../models/Menu');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /menus
 * List all menus
 */
router.get('/', optionalAuth, asyncHandler(async (req, res) => {
    const menus = Menu.findAll();
    res.json(menus.map(m => ({
        id: m.id,
        name: m.name,
        slug: m.slug,
        description: m.description
    })));
}));

/**
 * GET /menus/locations
 * Get menu locations
 */
router.get('/locations', asyncHandler(async (req, res) => {
    const locations = Menu.getLocations();
    res.json(locations);
}));

/**
 * GET /menus/:id
 * Get menu with items
 */
router.get('/:id', optionalAuth, asyncHandler(async (req, res) => {
    const menu = Menu.findById(parseInt(req.params.id, 10));

    if (!menu) {
        return res.status(404).json({
            code: 'rest_menu_invalid',
            message: 'Menu not found.',
            data: { status: 404 }
        });
    }

    res.json(menu.toJSON());
}));

/**
 * GET /menus/location/:location
 * Get menu by location
 */
router.get('/location/:location', optionalAuth, asyncHandler(async (req, res) => {
    const menu = Menu.findByLocation(req.params.location);

    if (!menu) {
        return res.status(404).json({
            code: 'rest_menu_invalid',
            message: 'No menu assigned to this location.',
            data: { status: 404 }
        });
    }

    res.json(menu.toJSON());
}));

/**
 * POST /menus
 * Create menu
 */
router.post('/', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const { name, slug, description } = req.body;

    if (!name) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Menu name is required.',
            data: { status: 400 }
        });
    }

    const menu = Menu.create({ name, slug, description });
    res.status(201).json(menu.toJSON());
}));

/**
 * PUT /menus/:id
 * Update menu
 */
router.put('/:id', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const menuId = parseInt(req.params.id, 10);
    const { name, slug, description } = req.body;

    const menu = Menu.update(menuId, { name, slug, description });
    res.json(menu.toJSON());
}));

/**
 * DELETE /menus/:id
 * Delete menu
 */
router.delete('/:id', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const menuId = parseInt(req.params.id, 10);
    const menu = Menu.findById(menuId);

    if (!menu) {
        return res.status(404).json({
            code: 'rest_menu_invalid',
            message: 'Menu not found.',
            data: { status: 404 }
        });
    }

    Menu.delete(menuId);
    res.json({ deleted: true, previous: menu.toJSON() });
}));

/**
 * POST /menus/:id/location
 * Set menu location
 */
router.post('/:id/location', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const menuId = parseInt(req.params.id, 10);
    const { location } = req.body;

    if (!location) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Location is required.',
            data: { status: 400 }
        });
    }

    Menu.setLocation(location, menuId);
    res.json({ success: true, location, menuId });
}));

// Menu Items

/**
 * POST /menus/:id/items
 * Add menu item
 */
router.post('/:id/items', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const menuId = parseInt(req.params.id, 10);
    const { title, url, target, type, objectId, parent, order, classes } = req.body;

    if (!title) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Title is required.',
            data: { status: 400 }
        });
    }

    const item = MenuItem.create({
        menuId,
        title,
        url: url || '#',
        target,
        type,
        objectId,
        parent,
        order,
        classes
    });

    res.status(201).json(item.toJSON());
}));

/**
 * PUT /menus/items/:itemId
 * Update menu item
 */
router.put('/items/:itemId', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const itemId = parseInt(req.params.itemId, 10);
    const item = MenuItem.update(itemId, req.body);
    res.json(item.toJSON());
}));

/**
 * DELETE /menus/items/:itemId
 * Delete menu item
 */
router.delete('/items/:itemId', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const itemId = parseInt(req.params.itemId, 10);
    const item = MenuItem.findById(itemId);

    if (!item) {
        return res.status(404).json({
            code: 'rest_menu_item_invalid',
            message: 'Menu item not found.',
            data: { status: 404 }
        });
    }

    MenuItem.delete(itemId);
    res.json({ deleted: true, previous: item.toJSON() });
}));

module.exports = router;
