/**
 * WordJS - Roles Routes
 * /api/v1/roles/*
 */

import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const { getRoles, setRole, getRole, removeRole, getAllAvailableCapabilities, isPluginRole, countRoleHolders } = require('../core/roles');
// accountAuthorityOnly: a role definition is what every account holding it may do, so neither an API token
// nor a session started at an address other than the main one may change one (middleware/auth.ts
// refuseAccountAuthority).
const { authenticate, accountAuthorityOnly } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * Plugin-declared roles (core/plugin-roles.ts, core/roles.ts) are the plugin's while it is installed:
 * an administrator may not rename or delete one then (the plugin would simply bring it back on its next
 * activation, and users assigned to it would lose it in between). Once the plugin is gone the role is an
 * ordinary leftover the administrator may tidy up.
 */
function pluginOwning(slug: string): { plugin: string; installed: boolean; orphaned: boolean } | null {
    const role = getRole(slug);
    if (!isPluginRole(role)) return null;
    return { plugin: role.plugin, installed: require('../core/plugins').isPluginInstalled(role.plugin), orphaned: !!role.orphaned };
}

function installedPluginIds(): string[] {
    try { return require('../core/plugins').listInstalledPluginIds(); } catch { return []; }
}

/**
 * @swagger
 * tags:
 *   name: Roles
 *   description: User Capability and Role management
 */

/**
 * @swagger
 * /roles:
 *   get:
 *     summary: List all roles
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: >-
 *           Map of roles and capabilities. A role a plugin declared also carries `source: "plugin"`, `plugin`
 *           (the plugin id), `description`, `pluginInstalled` and, once its plugin was deleted while users
 *           still held it, `orphaned: true`.
 */
router.get('/', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // A copy: plugin-declared roles carry their provenance ({ source: 'plugin', plugin, orphaned? }) and,
    // computed here, whether that plugin is still installed — what the Roles screen needs to show them
    // as "provided by plugin X" and offer (or not) to delete a leftover.
    const roles = getRoles();
    const out: Record<string, any> = {};
    for (const slug of Object.keys(roles)) {
        const role = roles[slug];
        out[slug] = isPluginRole(role)
            ? { ...role, pluginInstalled: require('../core/plugins').isPluginInstalled(role.plugin) }
            : role;
    }
    res.json(out);
}));

/**
 * @swagger
 * /roles/capabilities:
 *   get:
 *     summary: List all available system capabilities
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of capabilities
 */
router.get('/capabilities', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    res.json(getAllAvailableCapabilities());
}));

/**
 * @swagger
 * /roles/{slug}:
 *   get:
 *     summary: Get a single role
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Role details
 *       404:
 *         description: Role not found
 */
router.get('/:slug', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const role = getRole(req.params.slug);
    if (!role) {
        return res.status(404).json({
            code: 'rest_role_invalid_id',
            message: 'Invalid role slug.',
            data: { status: 404 }
        });
    }
    res.json(role);
}));

/**
 * @swagger
 * /roles:
 *   post:
 *     summary: Create or update a role
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [slug, name]
 *             properties:
 *               slug:
 *                 type: string
 *               name:
 *                 type: string
 *               capabilities:
 *                 type: object
 *     responses:
 *       201:
 *         description: Role saved
 *       400:
 *         description: >-
 *           rest_missing_param (no slug or name), rest_invalid_param (a slug that is not a role name), or
 *           rest_role_plugin_capability — the role was declared by a plugin and may only hold read,
 *           access_admin_panel and capabilities in that plugin's namespace.
 *       403:
 *         description: >-
 *           rest_forbidden (not an administrator), rest_token_management_forbidden (an API token), or
 *           rest_account_bound_session (a session started at an address other than the main one): neither
 *           may change what a role may do.
 *       409:
 *         description: >-
 *           rest_role_plugin_managed — the role was declared by a plugin that is still installed, so it
 *           cannot be renamed.
 */
router.post('/', authenticate, isAdmin, accountAuthorityOnly, asyncHandler(async (req: Request, res: Response) => {
    const { slug, name, capabilities } = req.body;

    if (!slug || !name) {
        return res.status(400).json({
            code: 'rest_missing_param',
            message: 'Role slug and name are required.',
            data: { status: 400 }
        });
    }

    // A role a plugin declared stays that plugin's while it is installed: no renaming. Its capabilities
    // may change only inside the plugin's namespace — setRole refuses anything else (core/roles.ts).
    const owning = pluginOwning(slug);
    if (owning && owning.installed && name !== getRole(slug).name) {
        return res.status(409).json({
            code: 'rest_role_plugin_managed',
            message: `Role "${slug}" is provided by plugin "${owning.plugin}" and cannot be renamed while that plugin is installed.`,
            data: { status: 409, plugin: owning.plugin }
        });
    }
    try {
        await setRole(slug, { name, capabilities }, { installedPluginIds: installedPluginIds() });
    } catch (e: any) {
        if (e && (e.code === 'rest_role_plugin_capability' || e.code === 'rest_invalid_param')) {
            return res.status(400).json({ code: e.code, message: e.message, data: { status: 400 } });
        }
        throw e;
    }
    res.status(201).json(getRole(slug));
}));

/**
 * @swagger
 * /roles/{slug}:
 *   delete:
 *     summary: Delete a role
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Role deleted
 *       400:
 *         description: Cannot delete core roles
 *       403:
 *         description: >-
 *           rest_forbidden (not an administrator), rest_token_management_forbidden (an API token), or
 *           rest_account_bound_session (a session started at an address other than the main one).
 *       409:
 *         description: >-
 *           rest_role_plugin_managed — the role was declared by a plugin that is still installed; it goes
 *           away with the plugin (or stays, orphaned, while users hold it). rest_role_in_use — a role a
 *           plugin declared that users still hold (`data.holders`): give them another role first.
 */
router.delete('/:slug', authenticate, isAdmin, accountAuthorityOnly, asyncHandler(async (req: Request, res: Response) => {
    const slug: string = req.params.slug as string;

    // Prevent deleting core roles
    const coreRoles = ['administrator', 'editor', 'author', 'contributor', 'subscriber'];
    if (coreRoles.includes(slug)) {
        return res.status(400).json({
            code: 'rest_role_protected',
            message: 'Core roles cannot be deleted.',
            data: { status: 400 }
        });
    }

    const owning = pluginOwning(slug);
    if (owning && owning.installed && !owning.orphaned) {
        return res.status(409).json({
            code: 'rest_role_plugin_managed',
            message: `Role "${slug}" is provided by plugin "${owning.plugin}" and cannot be deleted while that plugin is installed.`,
            data: { status: 409, plugin: owning.plugin }
        });
    }
    // A plugin's leftover role goes only once nobody holds it: deleting it under its holders would leave
    // their accounts naming a role that no longer exists — which the next plugin declaring that slug would
    // silently hand back to them, with whatever capabilities it declares.
    if (owning) {
        const holders = await countRoleHolders(slug);
        if (holders > 0) {
            return res.status(409).json({
                code: 'rest_role_in_use',
                message: `${holders} user(s) still hold role "${slug}". Give them another role first, then delete it.`,
                data: { status: 409, holders }
            });
        }
    }

    const removed = await removeRole(slug);
    if (!removed) {
        return res.status(404).json({
            code: 'rest_role_invalid_id',
            message: 'Role not found.',
            data: { status: 404 }
        });
    }

    res.json({ deleted: true, slug });
}));

module.exports = router;
