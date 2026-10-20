/**
 * WordJS — the network screen's API (multisite): the sites of the network and their status.
 *
 *   GET  /network/status                 { enabled, networkAdmin } — any signed-in user of the main site
 *   GET  /network/sites                  every site
 *   POST /network/sites                  create a site (re-authenticates: currentPassword)
 *   POST /network/sites/:id/suspend      suspend a site (re-authenticates)
 *   POST /network/sites/:id/resume       resume it (re-authenticates)
 *   DELETE /network/sites/:id            delete a site and everything it holds (re-authenticates; confirmSlug)
 *   GET  /network/certificates           every other site's TLS certificate (status, never a key)
 *   POST /network/sites/:id/certificate  issue it now with Let's Encrypt (re-authenticates)
 *   PUT  /network/sites/:id/certificate  install one the operator brings (re-authenticates)
 *   GET  /network/audit                  the network's own audit log
 *   GET  /network/plugins                the installed plugins and what the network offers the sites
 *   PUT  /network/plugins/:slug/ceiling  offer a plugin to the sites, up to a grant ceiling (re-authenticates)
 *   DELETE /network/plugins/:slug/ceiling  stop offering it; it is deactivated on every other site (re-authenticates)
 *   GET  /network/quotas                 the media storage quota of every site, and what each one uses
 *   PUT  /network/quotas/default         the quota a site without its own follows (re-authenticates)
 *   PUT  /network/sites/:id/quota        one site's own quota (re-authenticates)
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
async function changeStatus(req: Request, res: Response, status: 'active' | 'suspended') {
    const id = siteIdParam(req.params.id);
    if (id === null) return res.status(404).json({ code: 'network_site_not_found', message: 'No such site.', data: { status: 404 } });
    try {
        const site = await require('../core/network-sites').setSiteStatus(id, status, Number(req.user.id));
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
 * /network/sites/{id}:
 *   delete:
 *     summary: Delete a site and everything it holds
 *     description: Removes the site for good - its database (SQLite file, Postgres schema or MySQL database), its uploads and private files (on disk and in the media bucket), its plugin and theme workers, the database principals of its plugins, its cached entries, its certificates and its addresses. The site must be suspended first, and the request must repeat its slug. Its id is never given to another site. The main site cannot be deleted.
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
 *             required: [currentPassword, confirmSlug]
 *             properties:
 *               currentPassword:
 *                 type: string
 *               confirmSlug:
 *                 type: string
 *                 description: The slug of the site being deleted, repeated.
 *     responses:
 *       200:
 *         description: "{ deleted: id }"
 *       400:
 *         description: The main site (network_primary_site), a confirmSlug that does not match (network_confirm_mismatch), or a wrong currentPassword
 *       401:
 *         description: Not signed in (rest_not_logged_in)
 *       403:
 *         description: Not a network administrator
 *       404:
 *         description: No such site (network_site_not_found)
 *       409:
 *         description: The site is not suspended (network_site_active)
 */
router.delete('/sites/:id', asyncHandler(async (req: Request, res: Response) => {
    if (await requireSudoPassword(req, res, (req.body || {}).currentPassword)) return;
    const id = siteIdParam(req.params.id);
    if (id === null) return res.status(404).json({ code: 'network_site_not_found', message: 'No such site.', data: { status: 404 } });
    try {
        await require('../core/network-sites').deleteSite(id, { confirmSlug: (req.body || {}).confirmSlug, actorUserId: Number(req.user.id) });
        res.json({ deleted: id });
    } catch (e: any) {
        return sendError(res, e);
    }
}));

/**
 * @swagger
 * /network/certificates:
 *   get:
 *     summary: The TLS certificate of every site other than the main one
 *     description: Each site of a network has its own certificate for its main address, served by SNI at the edge. autoIssue tells whether Let's Encrypt issues and renews them on its own (ACME enabled with http-01 and an email, in Settings → Certificates). Never returns a private key.
 *     tags: [Network]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ autoIssue, certificates: [{ siteId, host, installed, notAfter, issuer, daysLeft, updatedAt }] }"
 *       403:
 *         description: Not a network administrator
 * /network/sites/{id}/certificate:
 *   post:
 *     summary: Issue a site's certificate now (Let's Encrypt, HTTP-01)
 *     description: Orders a certificate for the site's main address with the install's ACME account. The address must already point at this server.
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
 *         description: "{ certificate } (its status, served: whether the edge has it already)"
 *       400:
 *         description: The main site (network_primary_site), or a wrong currentPassword
 *       404:
 *         description: No such site (network_site_not_found)
 *       409:
 *         description: No ACME email configured (network_acme_unconfigured), or an issuance already running (network_acme_busy)
 *       502:
 *         description: The CA refused or could not validate the address (network_acme_failed)
 *   put:
 *     summary: Install a certificate the operator brings for a site
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
 *             required: [certPem, keyPem, currentPassword]
 *             properties:
 *               certPem:
 *                 type: string
 *                 description: The certificate and its chain (PEM).
 *               keyPem:
 *                 type: string
 *                 description: Its private key (PEM).
 *               currentPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ certificate }"
 *       400:
 *         description: The pair does not name the site's address, does not match, or has expired (network_invalid_certificate); the main site; a wrong currentPassword
 *       404:
 *         description: No such site (network_site_not_found)
 */
router.get('/certificates', asyncHandler(async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const siteCerts = require('../core/site-certs');
    const certificates = [];
    for (const site of require('../core/network').listSites()) {
        if (site.id === siteContext.PRIMARY_SITE_ID) continue;
        try { certificates.push({ siteId: site.id, ...(await siteCerts.siteCertificateStatus(site.id)) }); }
        catch { certificates.push({ siteId: site.id, host: site.mainHost, installed: false }); }
    }
    res.json({ autoIssue: siteCerts.autoIssueEnabled(), certificates });
}));

router.post('/sites/:id/certificate', asyncHandler(async (req: Request, res: Response) => {
    if (await requireSudoPassword(req, res, (req.body || {}).currentPassword)) return;
    const id = siteIdParam(req.params.id);
    if (id === null) return res.status(404).json({ code: 'network_site_not_found', message: 'No such site.', data: { status: 404 } });
    try {
        res.json({ certificate: await require('../core/site-certs').issueSiteCertificate(id, { actorUserId: Number(req.user.id) }) });
    } catch (e: any) {
        return sendError(res, e);
    }
}));

router.put('/sites/:id/certificate', asyncHandler(async (req: Request, res: Response) => {
    const b = req.body || {};
    if (await requireSudoPassword(req, res, b.currentPassword)) return;
    const id = siteIdParam(req.params.id);
    if (id === null) return res.status(404).json({ code: 'network_site_not_found', message: 'No such site.', data: { status: 404 } });
    try {
        res.json({ certificate: await require('../core/site-certs').installSiteCertificate(id, b.certPem, b.keyPem, { actorUserId: Number(req.user.id) }) });
    } catch (e: any) {
        return sendError(res, e);
    }
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

router.get('/audit', asyncHandler(async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.json({ entries: await require('../core/network').auditLog(Number(req.query.limit) || 100) });
}));

// ── Plugins across the network (phase 2) ─────────────────────────────────────────────────────────────

const PLUGIN_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** The permissions a plugin's manifest requests, as grant tokens ("scope:access" / "network"). */
function requestedTokens(plugin: any): string[] {
    return Array.from(new Set(((plugin && plugin.permissions) || [])
        .map((perm: any) => (perm && perm.scope) ? (perm.scope === 'network' ? 'network' : `${perm.scope}:${perm.access || 'read'}`) : null)
        .filter(Boolean))) as string[];
}

function pluginErrorStatus(res: Response, e: any) {
    const code = e && typeof e.code === 'string' ? e.code : '';
    if (code.startsWith('network_') || code.startsWith('plugin_')) {
        const status = typeof e.status === 'number' ? e.status : 400;
        return res.status(status).json({ code, message: e.message, data: { status } });
    }
    throw e;
}

/**
 * @swagger
 * /network/plugins:
 *   get:
 *     summary: The plugins installed on the network and the grant ceiling each one is offered to the sites with
 *     description: A plugin with `ceiling` null is not offered — only the main site can activate it. Otherwise any site may activate it and grant it at most the tokens of its ceiling.
 *     tags: [Network]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ plugins: [{ slug, name, version, requestedPermissions, ceiling }] }"
 *       401:
 *         description: Not signed in (rest_not_logged_in)
 *       403:
 *         description: Not a network administrator
 */
router.get('/plugins', asyncHandler(async (req: Request, res: Response) => {
    const network = require('../core/network');
    const all = await require('../core/plugins').getAllPlugins();
    res.set('Cache-Control', 'no-store');
    res.json({
        plugins: all.map((p: any) => ({
            slug: p.slug,
            name: p.name || p.slug,
            version: p.version || '',
            requestedPermissions: requestedTokens(p),
            ceiling: network.pluginCeiling(p.slug),
        })),
    });
}));

/**
 * @swagger
 * /network/plugins/{slug}/ceiling:
 *   put:
 *     summary: Offer a plugin to the sites of the network, with the most any site may grant it
 *     description: Records the plugin's grant ceiling (replacing a previous one), installs its dependencies into the shared node_modules once, and restarts its running workers on the other sites so a lowered ceiling also reaches their children. A site administrator's grant beyond the ceiling is refused with 403 (plugin_grant_beyond_ceiling), and grants already stored beyond it stop counting at once.
 *     tags: [Network]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tokens, currentPassword]
 *             properties:
 *               tokens:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Grant tokens ("scope:access" or "network").
 *               currentPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ slug, ceiling }"
 *       400:
 *         description: A wrong currentPassword, a malformed token (network_invalid_ceiling), or not an isolated plugin
 *       401:
 *         description: Not signed in (rest_not_logged_in)
 *       403:
 *         description: Not a network administrator
 *       404:
 *         description: No such plugin (plugin_not_found)
 *   delete:
 *     summary: Stop offering a plugin to the sites of the network
 *     description: Removes its ceiling and deactivates it on every site other than the main one (their grants are kept for a later offer).
 *     tags: [Network]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
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
 *         description: "{ slug, withdrawn, deactivatedOn }"
 *       400:
 *         description: A wrong currentPassword
 *       401:
 *         description: Not signed in (rest_not_logged_in)
 *       403:
 *         description: Not a network administrator
 */
router.put('/plugins/:slug/ceiling', asyncHandler(async (req: Request, res: Response) => {
    const slug = String(req.params.slug || '');
    if (!PLUGIN_SLUG_RE.test(slug)) return res.status(400).json({ code: 'plugin_invalid_slug', message: 'Not a plugin slug.', data: { status: 400 } });
    const body = req.body || {};
    if (await requireSudoPassword(req, res, body.currentPassword)) return;
    try {
        const ceiling = await require('../core/plugins').offerPluginToSites(slug, body.tokens);
        await require('../core/network').audit('plugin.offered', { actor: Number(req.user.id), detail: { slug, ceiling } });
        res.json({ slug, ceiling });
    } catch (e: any) {
        return pluginErrorStatus(res, e);
    }
}));

router.delete('/plugins/:slug/ceiling', asyncHandler(async (req: Request, res: Response) => {
    const slug = String(req.params.slug || '');
    if (!PLUGIN_SLUG_RE.test(slug)) return res.status(400).json({ code: 'plugin_invalid_slug', message: 'Not a plugin slug.', data: { status: 400 } });
    if (await requireSudoPassword(req, res, (req.body || {}).currentPassword)) return;
    const result = await require('../core/plugins').withdrawPluginFromSites(slug);
    await require('../core/network').audit('plugin.withdrawn', { actor: Number(req.user.id), detail: { slug, deactivatedOn: result.deactivatedOn } });
    res.json({ slug, ...result });
}));

// ── Media storage quotas (core/network effectiveUploadQuota, core/site-upload-quota) ──────────────────

/**
 * @swagger
 * /network/quotas:
 *   get:
 *     summary: The media storage quota of every site and how much each one uses
 *     description: A quota is a number of bytes of media (uploads with their derivatives, public and private). A site's own quota wins; a site without one follows the network default; with neither there is no limit. The main site never has a quota.
 *     tags: [Network]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ defaultQuota, sites: [{ id, quota, effectiveQuota, used }] } (bytes; null = none / no limit; used null when the site's database cannot be read)"
 *       401:
 *         description: Not signed in (rest_not_logged_in)
 *       403:
 *         description: Not a network administrator
 */
router.get('/quotas', asyncHandler(async (req: Request, res: Response) => {
    const network = require('../core/network');
    const database = require('../config/database');
    const quota = require('../core/site-upload-quota');
    const sites = [];
    for (const site of network.listSites()) {
        let used: number | null;
        try {
            used = await siteContext.runWithSite(site.id, async () => {
                if (site.id !== siteContext.PRIMARY_SITE_ID) await database.openSiteDatabase(site.id, site.dbPath || network.siteDbPath(site.id));
                return quota.siteUploadUsage();
            });
        } catch { used = null; }
        sites.push({
            id: site.id,
            quota: network.siteUploadQuotaOverride(site.id),
            effectiveQuota: network.effectiveUploadQuota(site.id),
            used,
        });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ defaultQuota: network.defaultUploadQuota(), sites });
}));

/**
 * @swagger
 * /network/quotas/default:
 *   put:
 *     summary: Set the default media storage quota of the sites
 *     tags: [Network]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword]
 *             properties:
 *               bytes:
 *                 type: integer
 *                 nullable: true
 *                 description: null or absent removes the default (no limit).
 *               currentPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ defaultQuota }"
 *       400:
 *         description: Not a whole number of bytes (network_invalid_quota), or a wrong currentPassword
 * /network/sites/{id}/quota:
 *   put:
 *     summary: Set one site's own media storage quota
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
 *               bytes:
 *                 type: integer
 *                 nullable: true
 *                 description: null or absent removes the site's own quota (it follows the default again).
 *               currentPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ id, quota, effectiveQuota }"
 *       400:
 *         description: The main site (network_primary_site), not a whole number of bytes (network_invalid_quota), or a wrong currentPassword
 *       404:
 *         description: No such site (network_site_not_found)
 */
router.put('/quotas/default', asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    if (await requireSudoPassword(req, res, body.currentPassword)) return;
    try {
        const network = require('../core/network');
        const defaultQuota = await network.setDefaultUploadQuota(body.bytes);
        await network.audit('quota.default', { actor: Number(req.user.id), detail: { bytes: defaultQuota } });
        res.json({ defaultQuota });
    } catch (e: any) {
        return sendError(res, e);
    }
}));

router.put('/sites/:id/quota', asyncHandler(async (req: Request, res: Response) => {
    const id = siteIdParam(req.params.id);
    if (id === null) return res.status(404).json({ code: 'network_site_not_found', message: 'No such site.', data: { status: 404 } });
    const body = req.body || {};
    if (await requireSudoPassword(req, res, body.currentPassword)) return;
    try {
        const network = require('../core/network');
        const quota = await network.setSiteUploadQuota(id, body.bytes);
        await network.audit('quota.site', { actor: Number(req.user.id), siteId: id, detail: { bytes: quota } });
        res.json({ id, quota, effectiveQuota: network.effectiveUploadQuota(id) });
    } catch (e: any) {
        return sendError(res, e);
    }
}));

module.exports = router;
