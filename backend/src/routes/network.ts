/**
 * WordJS — the network screen's API (multisite): the sites of the network and their status.
 *
 *   GET  /network/status                 { enabled, networkAdmin } — any signed-in user of the main site
 *   GET  /network/sites                  every site
 *   POST /network/sites                  create a site (re-authenticates: currentPassword)
 *   POST /network/sites/:id/suspend      suspend a site (re-authenticates)
 *   POST /network/sites/:id/resume       resume it (re-authenticates)
 *   GET  /network/audit                  the network's own audit log
 *
 * Everything but /status is for NETWORK administrators (core/network-auth), on the main site only, with
 * a session (never an API token): a token minted for automation must not be able to create sites.
 */
import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const { authenticate, sessionOnly } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireSudoPassword } = require('./users');
const { isNetworkAdminRequest, requireNetworkAdmin } = require('../core/network-auth');
const siteContext = require('../core/site-context');

/**
 * @swagger
 * tags:
 *   name: Network
 *   description: Multisite. The sites of a network of WordJS sites served by one install, each with its own address, database, uploads, users and settings. Everything but /network/status is for network administrators (administrators of the main site listed in the network store), on the main site only, with an interactive session; every write re-authenticates with currentPassword. On a single-site install every operation but /network/status answers 404.
 * components:
 *   schemas:
 *     NetworkSite:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: 1 is the main site.
 *         slug:
 *           type: string
 *         url:
 *           type: string
 *           description: The main address of the site, the base of every link it builds.
 *         host:
 *           type: string
 *         status:
 *           type: string
 *           enum: [active, suspended]
 *         main:
 *           type: boolean
 *         createdAt:
 *           type: string
 *         updatedAt:
 *           type: string
 */

/**
 * @swagger
 * /network/status:
 *   get:
 *     summary: Is this install a network, and is the caller one of its administrators
 *     tags: [Network]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ enabled, networkAdmin }"
 *       401:
 *         description: Not signed in (rest_not_logged_in)
 */
router.get('/status', authenticate, (req: Request, res: Response) => {
    const enabled = siteContext.multisiteEnabled();
    res.set('Cache-Control', 'no-store');
    res.json({ enabled, networkAdmin: enabled && isNetworkAdminRequest(req) });
});

router.use(authenticate, sessionOnly, requireNetworkAdmin);

/** What the screen shows of a site: never its file paths. */
function publicSite(site: any) {
    return {
        id: site.id,
        slug: site.slug,
        url: site.mainUrl,
        host: site.mainHost,
        status: site.status,
        main: site.id === siteContext.PRIMARY_SITE_ID,
        createdAt: site.createdAt,
        updatedAt: site.updatedAt,
    };
}

function siteIdParam(raw: unknown): number | null {
    const s = String(raw || '');
    if (!/^[1-9][0-9]{0,8}$/.test(s)) return null;
    return Number(s);
}

function sendError(res: Response, e: any) {
    const code = e && typeof e.code === 'string' && e.code.startsWith('network_') ? e.code : null;
    if (!code) throw e;
    const status = typeof e.status === 'number' ? e.status : (code === 'network_site_not_found' ? 404 : 400);
    return res.status(status).json({ code, message: e.message, data: { status } });
}

/**
 * @swagger
 * /network/sites:
 *   get:
 *     summary: List the sites of the network
 *     tags: [Network]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ sites: NetworkSite[] }, the main site first"
 *       401:
 *         description: Not signed in (rest_not_logged_in)
 *       403:
 *         description: Not a network administrator (rest_forbidden_network), or an API token
 *       404:
 *         description: Multisite is off, or this is not the main site
 *   post:
 *     summary: Create a site
 *     description: Provisions the site end to end - its record and address, its database, its uploads directory, its default options and its first administrator - or nothing at all. The address must be a domain name that no site of the network answers yet.
 *     tags: [Network]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [slug, url, title, adminUsername, adminEmail, adminPassword, currentPassword]
 *             properties:
 *               slug:
 *                 type: string
 *               url:
 *                 type: string
 *                 example: https://blog.example.com
 *               title:
 *                 type: string
 *               adminUsername:
 *                 type: string
 *               adminEmail:
 *                 type: string
 *               adminPassword:
 *                 type: string
 *                 minLength: 8
 *               currentPassword:
 *                 type: string
 *                 description: The password of the caller (re-authentication).
 *     responses:
 *       201:
 *         description: "{ site: NetworkSite }"
 *       400:
 *         description: An invalid field (network_invalid_url, network_invalid_slug, network_invalid_title, network_invalid_admin, network_weak_password), or a wrong currentPassword
 *       401:
 *         description: Not signed in (rest_not_logged_in)
 *       403:
 *         description: Not a network administrator
 *       409:
 *         description: The address or the slug is taken (network_host_taken, network_slug_taken)
 */
router.get('/sites', (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.json({ sites: require('../core/network').listSites().map(publicSite) });
});

router.post('/sites', asyncHandler(async (req: Request, res: Response) => {
    if (await requireSudoPassword(req, res, (req.body || {}).currentPassword)) return;
    const b = req.body || {};
    try {
        const site = await require('../core/network-sites').createSite({
            slug: b.slug,
            url: b.url,
            title: b.title,
            adminUsername: b.adminUsername,
            adminEmail: b.adminEmail,
            adminPassword: b.adminPassword,
            actorUserId: Number(req.user.id),
        });
        res.status(201).json({ site: publicSite(site) });
    } catch (e: any) {
        return sendError(res, e);
    }
}));

/** Suspend or resume a site, once the caller re-authenticated. The main site can be neither. */
function changeStatus(req: Request, res: Response, status: 'active' | 'suspended') {
    const id = siteIdParam(req.params.id);
    if (id === null) return res.status(404).json({ code: 'network_site_not_found', message: 'No such site.', data: { status: 404 } });
    try {
        const site = require('../core/network-sites').setSiteStatus(id, status, Number(req.user.id));
        return res.json({ site: publicSite(site) });
    } catch (e: any) {
        return sendError(res, e);
    }
}

/**
 * @swagger
 * /network/sites/{id}/suspend:
 *   post:
 *     summary: Suspend a site
 *     description: A suspended site answers 503 rest_site_suspended to every request, at the edge and at the backend. Its data is kept.
 *     tags: [Network]
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
 *             required: [currentPassword]
 *             properties:
 *               currentPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ site: NetworkSite }"
 *       400:
 *         description: The main site (network_primary_site), or a wrong currentPassword
 *       401:
 *         description: Not signed in (rest_not_logged_in)
 *       403:
 *         description: Not a network administrator
 *       404:
 *         description: No such site (network_site_not_found)
 */
router.post('/sites/:id/suspend', asyncHandler(async (req: Request, res: Response) => {
    if (await requireSudoPassword(req, res, (req.body || {}).currentPassword)) return;
    return changeStatus(req, res, 'suspended');
}));

/**
 * @swagger
 * /network/sites/{id}/resume:
 *   post:
 *     summary: Resume a suspended site
 *     tags: [Network]
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
 *             required: [currentPassword]
 *             properties:
 *               currentPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ site: NetworkSite }"
 *       400:
 *         description: A wrong currentPassword
 *       401:
 *         description: Not signed in (rest_not_logged_in)
 *       403:
 *         description: Not a network administrator
 *       404:
 *         description: No such site (network_site_not_found)
 */
router.post('/sites/:id/resume', asyncHandler(async (req: Request, res: Response) => {
    if (await requireSudoPassword(req, res, (req.body || {}).currentPassword)) return;
    return changeStatus(req, res, 'active');
}));

/**
 * @swagger
 * /network/audit:
 *   get:
 *     summary: The audit log of the network itself (sites created, suspended, resumed; network administrators)
 *     tags: [Network]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 500
 *     responses:
 *       200:
 *         description: "{ entries }, newest first"
 *       401:
 *         description: Not signed in (rest_not_logged_in)
 *       403:
 *         description: Not a network administrator
 */

router.get('/audit', (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.json({ entries: require('../core/network').auditLog(Number(req.query.limit) || 100) });
});

module.exports = router;
