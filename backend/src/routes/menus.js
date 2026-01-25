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
 * @swagger
 * tags:
 *   name: Menus
 *   description: Menu and navigation management
 */

/**
 * @swagger
 * /menus:
 *   get:
 *     summary: List all menus
 *     tags: [Menus]
 *     responses:
 *       200:
 *         description: List of menus
 */
router.get('/', optionalAuth, asyncHandler(async (req, res) => {
    const menus = await Menu.findAll();
    res.json(menus.map(m => ({
        id: m.id,
        name: m.name,
        slug: m.slug,
        description: m.description
    })));
}));

/**
 * @swagger
 * /menus/locations:
 *   get:
 *     summary: Get registered menu locations
 *     tags: [Menus]
 *     responses:
 *       200:
 *         description: List of locations
 */
router.get('/locations', asyncHandler(async (req, res) => {
    const locations = await Menu.getLocations();
    res.json(locations);
}));

/**
 * @swagger
 * /menus/{id}:
 *   get:
 *     summary: Get a menu with items
 *     tags: [Menus]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Menu details with items
 *       404:
 *         description: Menu not found
 */
router.get('/:id', optionalAuth, asyncHandler(async (req, res) => {
    const menu = await Menu.findById(parseInt(req.params.id, 10));

    if (!menu) {
        return res.status(404).json({
            code: 'rest_menu_invalid',
            message: 'Menu not found.',
            data: { status: 404 }
        });
    }

    const items = await menu.getItems();
    const response = menu.toJSON();
    response.items = items.map(i => i.toJSON());
    res.json(response);
}));

/**
 * @swagger
 * /menus/location/{location}:
 *   get:
 *     summary: Get a menu by its location
 *     tags: [Menus]
 *     parameters:
 *       - in: path
 *         name: location
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Menu details with items
 *       404:
 *         description: No menu assigned
 */
router.get('/location/:location', optionalAuth, asyncHandler(async (req, res) => {
    const menu = await Menu.findByLocation(req.params.location);

    if (!menu) {
        return res.status(404).json({
            code: 'rest_menu_invalid',
            message: 'No menu assigned to this location.',
            data: { status: 404 }
        });
    }

    const items = await menu.getItems();
    const response = menu.toJSON();
    response.items = items.map(i => i.toJSON());
    res.json(response);
}));

/**
 * @swagger
 * /menus:
 *   post:
 *     summary: Create a menu
 *     tags: [Menus]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *               slug:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       201:
 *         description: Menu created
 *       400:
 *         description: Validation error
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

    const menu = await Menu.create({ name, slug, description });
    res.status(201).json(menu.toJSON());
}));

/**
 * @swagger
 * /menus/{id}:
 *   put:
 *     summary: Update a menu
 *     tags: [Menus]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               slug:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Menu updated
 */
router.put('/:id', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const menuId = parseInt(req.params.id, 10);
    const { name, slug, description } = req.body;

    const menu = await Menu.update(menuId, { name, slug, description });
    res.json(menu.toJSON());
}));

/**
 * @swagger
 * /menus/{id}:
 *   delete:
 *     summary: Delete a menu
 *     tags: [Menus]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Menu deleted
 *       404:
 *         description: Menu not found
 */
router.delete('/:id', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const menuId = parseInt(req.params.id, 10);
    const menu = await Menu.findById(menuId);

    if (!menu) {
        return res.status(404).json({
            code: 'rest_menu_invalid',
            message: 'Menu not found.',
            data: { status: 404 }
        });
    }

    await Menu.delete(menuId);
    res.json({ deleted: true, previous: menu.toJSON() });
}));

/**
 * @swagger
 * /menus/{id}/location:
 *   post:
 *     summary: Set menu location
 *     tags: [Menus]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [location]
 *             properties:
 *               location:
 *                 type: string
 *     responses:
 *       200:
 *         description: Location updated
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

    await Menu.setLocation(location, menuId);
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

    const item = await MenuItem.create({
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
    const item = await MenuItem.update(itemId, req.body);
    res.json(item.toJSON());
}));

/**
 * DELETE /menus/items/:itemId
 * Delete menu item
 */
router.delete('/items/:itemId', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const itemId = parseInt(req.params.itemId, 10);
    const item = await MenuItem.findById(itemId);

    if (!item) {
        return res.status(404).json({
            code: 'rest_menu_item_invalid',
            message: 'Menu item not found.',
            data: { status: 404 }
        });
    }

    await MenuItem.delete(itemId);
    res.json({ deleted: true, previous: item.toJSON() });
}));

module.exports = router;
