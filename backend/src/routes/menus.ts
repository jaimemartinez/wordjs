/**
 * WordJS - Menus Routes
 * /api/v1/menus/*
 */

import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const { Menu, MenuItem } = require('../models/Menu');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
// ISR: the public nav renders from Next Data Cache entries tagged 'menus' + 'menu:<ref>' with a 60s
// revalidate (frontend/src/lib/server-api.ts getMenuByLocation/getMenuById). No content hook fires on
// this router's mutations (menu items are written directly, not through wp_insert_post), so every
// mutation here must purge explicitly or the editor shows the new nav while the public site serves
// the stale one for up to a minute — breaking frontend-purge's own instant-purge contract, whose
// docstring lists 'menus' among its tags.
// The BROAD 'menus' tag is purged on purpose: both frontend fetches declare it alongside their
// precise tag, the same menu is cached under a location key AND an id key at once, and the item
// routes only know the item — per-ref precision would need reverse lookups (item → menu → locations)
// for no real win (a site has a handful of menus, re-rendering them is cheap, and the flush is
// debounced anyway).
const { purgeFrontend } = require('../core/frontend-purge');

// SECURITY (XSS-03): menu item urls render site-wide as <a href={item.url}> in the public nav, so a
// `javascript:`/`data:`/`vbscript:` url set by an admin would execute stored XSS in every visitor's
// browser. Allow only safe link targets: relative paths, fragments, and http(s)/mailto/tel absolute
// URLs. Anything with a disallowed scheme is blanked to '#'. A blank input returns '' so existing
// `url || '#'` defaulting is preserved.
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);
/**
 * Characters the WHATWG URL parser STRIPS before parsing (tab, LF, CR). They are removed here first
 * so that what is validated is what the browser will actually see — see the two bugs below.
 */
const URL_STRIPPED_CONTROLS = /[\t\n\r]/g;
function safeMenuUrl(raw: any) {
    if (raw === undefined || raw === null) return raw;
    // Strip BEFORE deciding, and keep the stripped value: `trim()` only touches the ends, so
    // "/\t/evil.example" kept its tab, satisfied the "starts with / but not //" test below, and the
    // browser — parsing it without the tab — navigated to https://evil.example/. Validating the raw
    // string while the browser parses a different one is how a guard comes to protect nothing.
    const value = String(raw).replace(URL_STRIPPED_CONTROLS, '').trim();
    if (!value) return '';
    // AUTHORITY-RELATIVE, in both spellings. "//host" was already handled; "/\host" was NOT, and it
    // needs no control character at all: for a special scheme the parser treats `\` exactly like `/`,
    // so "/\evil.example" is an EXTERNAL navigation that the old `!startsWith('//')` waved through.
    // This mirrors the chrome guard's `/^\/[/\\]/` — the two must agree, they defend the same thing.
    if (/^\/[/\\]/.test(value)) return '#';
    // Same-origin relative paths and in-page fragments have no scheme and are always safe.
    if (value.startsWith('/') || value.startsWith('#') || value.startsWith('?')) {
        return value;
    }
    try {
        // No protocol-relative coercion: "//host" is left as-is so new URL() rejects it (→ catch → '#'),
        // closing the open-redirect. Genuine absolute URLs (http(s)/mailto/tel) parse and are scheme-checked.
        const parsed = new URL(value);
        if (SAFE_URL_SCHEMES.has(parsed.protocol)) {
            // The CLEANED value, never `raw`: returning the original would hand the renderer back the
            // string with the control characters still in it, which is the whole bug.
            return value;
        }
    } catch {
        // Not an absolute URL and not a recognized relative form: fall through.
    }
    // Disallowed scheme (javascript:, data:, vbscript:, ...) or unparseable: neutralize.
    return '#';
}

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
router.get('/', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
    const menus = await Menu.findAll();
    res.json(menus.map((m: any) => ({
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
router.get('/locations', asyncHandler(async (req: Request, res: Response) => {
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
router.get('/:id', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
    const menu = await Menu.findById(parseInt(req.params.id as string, 10));

    if (!menu) {
        return res.status(404).json({
            code: 'rest_menu_invalid',
            message: 'Menu not found.',
            data: { status: 404 }
        });
    }

    const items = await menu.getItems();
    const response = menu.toJSON();
    response.items = items.map((i: any) => i.toJSON());
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
router.get('/location/:location', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
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
    response.items = items.map((i: any) => i.toJSON());
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
router.post('/', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const { name, slug, description } = req.body;

    if (!name) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Menu name is required.',
            data: { status: 400 }
        });
    }

    const menu = await Menu.create({ name, slug, description });
    purgeFrontend(['menus']);
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
router.put('/:id', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const menuId = parseInt(req.params.id as string, 10);
    const { name, slug, description } = req.body;

    const existing = await Menu.findById(menuId);
    if (!existing) {
        return res.status(404).json({
            code: 'rest_menu_invalid',
            message: 'Menu not found.',
            data: { status: 404 }
        });
    }

    const menu = await Menu.update(menuId, { name, slug, description });
    purgeFrontend(['menus']);
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
router.delete('/:id', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const menuId = parseInt(req.params.id as string, 10);
    const menu = await Menu.findById(menuId);

    if (!menu) {
        return res.status(404).json({
            code: 'rest_menu_invalid',
            message: 'Menu not found.',
            data: { status: 404 }
        });
    }

    await Menu.delete(menuId);
    purgeFrontend(['menus']);
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
router.post('/:id/location', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const menuId = parseInt(req.params.id as string, 10);
    const { location } = req.body;

    if (!location) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Location is required.',
            data: { status: 400 }
        });
    }

    await Menu.setLocation(location, menuId);
    // Also purged by the updated_option('nav_menu_locations') hook once wired; the explicit call keeps
    // the route correct on its own and the debounced flush coalesces the two into one request.
    purgeFrontend(['menus']);
    res.json({ success: true, location, menuId });
}));

// Menu Items

/**
 * POST /menus/:id/items
 * Add menu item
 */
router.post('/:id/items', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const menuId = parseInt(req.params.id as string, 10);
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
        url: safeMenuUrl(url) || '#',
        target,
        type,
        objectId,
        parent,
        order,
        classes
    });

    purgeFrontend(['menus']);
    res.status(201).json(item.toJSON());
}));

/**
 * PUT /menus/items/:itemId
 * Update menu item
 */
router.put('/items/:itemId', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const itemId = parseInt(req.params.itemId as string, 10);

    const existing = await MenuItem.findById(itemId);
    if (!existing) {
        return res.status(404).json({
            code: 'rest_menu_item_invalid',
            message: 'Menu item not found.',
            data: { status: 404 }
        });
    }

    // SECURITY (XSS-03): sanitize the url before persisting. Only sanitize when a url is actually being
    // updated so the model's "update only provided fields" contract is preserved; an explicitly-cleared
    // url becomes '#' rather than being dropped.
    const updateData = req.body;
    if (updateData && updateData.url !== undefined) {
        updateData.url = safeMenuUrl(updateData.url) || '#';
    }

    const item = await MenuItem.update(itemId, updateData);
    purgeFrontend(['menus']);
    res.json(item.toJSON());
}));

/**
 * DELETE /menus/items/:itemId
 * Delete menu item
 */
router.delete('/items/:itemId', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const itemId = parseInt(req.params.itemId as string, 10);
    const item = await MenuItem.findById(itemId);

    if (!item) {
        return res.status(404).json({
            code: 'rest_menu_item_invalid',
            message: 'Menu item not found.',
            data: { status: 404 }
        });
    }

    await MenuItem.delete(itemId);
    purgeFrontend(['menus']);
    res.json({ deleted: true, previous: item.toJSON() });
}));

module.exports = router;
