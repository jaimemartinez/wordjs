/**
 * WordJS — the network screen's API (multisite): the sites of the network and their status.
 *
 *   GET  /network/status                 { enabled, networkAdmin } — any signed-in user of the main site
 *   GET  /network/setup                  what turning the network on needs (main-site administrators while off)
 *   POST /network/enable                 turn it on and restart (re-authenticates: password + two-factor code)
 *   POST /network/disable                turn it off and restart, while the main site is the only site (same)
 *   GET  /network/admins                 the main site's administrators, and which are network administrators
 *   POST /network/admins                 make one a network administrator (re-authenticates)
 *   DELETE /network/admins/:id           take that away again, never from the last one (re-authenticates)
 *   GET  /network/sites                  every site
 *   POST /network/sites                  create a site (re-authenticates: currentPassword)
 *   POST /network/sites/:id/suspend      suspend a site (re-authenticates)
 *   POST /network/sites/:id/resume       resume it (re-authenticates)
 *   DELETE /network/sites/:id            delete a site and everything it holds (re-authenticates; confirmSlug)
 *   POST /network/sites/:id/handoff      open the site's admin as administrator: a one-time link (re-authenticates)
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
 * Everything but /status, /setup, /enable and /disable is for NETWORK administrators (core/network-auth), on the main site only, with
 * a session (never an API token): a token minted for automation must not be able to create sites.
 */
import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const { authenticate, sessionOnly, sessionMfaVerified, accountAuthorityOnly } = require('../middleware/auth');
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

// ── Turning the network on and off from the panel (Settings → Network) ──────────────────────────────
// Zero config: everything `npm run network -- enable|disable` does, from the admin panel, followed by the
// restart the switch needs (core/restart), on every backend node. These routes are declared BEFORE the
// network-administrator gate below because while the network is off there is no network administrator
// yet: they are for the main site's administrators then, and for network administrators once it is on.

/** Who may see and use the switch: an administrator of the main site (a network administrator once on). */
function refuseSetupCaller(req: Request, res: Response): boolean {
    if (siteContext.multisiteEnabled()) {
        if (siteContext.currentSiteIdOrNull() !== siteContext.PRIMARY_SITE_ID) {
            res.status(404).json({ code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } });
            return true;
        }
        if (!isNetworkAdminRequest(req)) {
            res.status(403).json({ code: 'rest_forbidden_network', message: 'Only a network administrator can do this.', data: { status: 403 } });
            return true;
        }
        return false;
    }
    const role = req.user && (typeof req.user.getRole === 'function' ? req.user.getRole() : req.user.role);
    if (role !== 'administrator') {
        res.status(403).json({ code: 'rest_forbidden', message: 'Only an administrator of the main site can turn the network on.', data: { status: 403 } });
        return true;
    }
    return false;
}

/**
 * The second factor for the switch: the account must have two-factor authentication, and the request must
 * carry a current code (`mfaCode`) even when the session signed in with one — a fresh proof, like the
 * password. Returns the assurance recorded in the audit log, or null when it has answered the request.
 */
async function requireStepUp(req: Request, res: Response): Promise<string | null> {
    const mfa = require('../core/mfa');
    if (!(await mfa.isEnabled(req.user.id))) {
        res.status(403).json({
            code: 'network_mfa_enrollment_required',
            message: 'Turn on two-factor authentication for your account first (Profile → Two-factor authentication). Switching the network on or off asks for a code.',
            data: { status: 403 },
        });
        return null;
    }
    const code = (req.body || {}).mfaCode;
    if (typeof code !== 'string' || !code.trim()) {
        res.status(403).json({ code: 'rest_mfa_step_up_required', message: 'Enter a current authentication code from your authenticator app.', data: { status: 403 } });
        return null;
    }
    const ok = await require('./auth').verifyManagedMfaCode(req, res, code);
    return ok ? 'step_up' : null;
}

/**
 * @swagger
 * /network/setup:
 *   get:
 *     summary: What turning the network on needs, and who can run it
 *     description: For the main site's administrators while multisite is off, for network administrators once it is on (404 on any other site). Lists each requirement in plain words with how to fix it from the panel (the database engine, the database user's CREATE right, the main address, whether WordJS can restart itself), the main site's administrators (the candidates for network administrator), whether the caller has two-factor authentication (the switch asks for a code), and the restart state (bootId changes on every boot).
 *     tags: [Network]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ enabled, ready, requirements, administrators, mfaEnrolled, driver, otherSites, restart }"
 *       401:
 *         description: Not signed in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator of the main site (rest_forbidden), not a network administrator once on (rest_forbidden_network), or an API token
 *       404:
 *         description: Another site of the network
 * /network/enable:
 *   post:
 *     summary: Turn the network on and restart
 *     description: Records the main site as site 1, makes the chosen administrators of the main site network administrators, sets multisite.enabled, audits it, and restarts the backend (every node). Interactive session at the main address only; re-authenticates with currentPassword and a current two-factor code.
 *     tags: [Network]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [admins, currentPassword, mfaCode]
 *             properties:
 *               admins:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: User ids of administrators of the main site.
 *               currentPassword:
 *                 type: string
 *               mfaCode:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ enabled: true, admins, restart } — restart is supervisor, watch or service (it restarts itself) or manual (restart it by hand)"
 *       400:
 *         description: No administrator chosen (network_admins_required), one is not an administrator of the main site (network_admin_not_administrator), or a wrong mfaCode (rest_mfa_invalid)
 *       403:
 *         description: Not an administrator, a wrong currentPassword (rest_bad_current_password), no two-factor authentication (network_mfa_enrollment_required), no code (rest_mfa_step_up_required)
 *       409:
 *         description: Already on (network_already_enabled), or a requirement is not met (network_requirements_unmet)
 * /network/disable:
 *   post:
 *     summary: Turn the network off and restart
 *     description: Only while the main site is the only site. Network administrators; re-authenticates with currentPassword and a current two-factor code; audited; restarts the backend (every node).
 *     tags: [Network]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, mfaCode]
 *             properties:
 *               currentPassword:
 *                 type: string
 *               mfaCode:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ enabled: false, restart }"
 *       403:
 *         description: Not a network administrator, a wrong currentPassword, no two-factor authentication or no code
 *       404:
 *         description: Another site of the network
 *       409:
 *         description: Already off (network_not_enabled), or other sites exist (network_has_sites)
 */
router.get('/setup', authenticate, sessionOnly, asyncHandler(async (req: Request, res: Response) => {
    if (refuseSetupCaller(req, res)) return;
    const setup = require('../core/network-setup');
    const requirements = await setup.requirements();
    const enabled = siteContext.multisiteEnabled();
    let otherSites = 0;
    if (enabled) { try { otherSites = require('../core/network').listSites().filter((s: any) => s.id !== siteContext.PRIMARY_SITE_ID).length; } catch { /* store not readable */ } }
    res.set('Cache-Control', 'no-store');
    res.json({
        enabled,
        ready: requirements.every((r: any) => !r.blocking || r.ok),
        requirements,
        administrators: await setup.mainSiteAdministrators(),
        mfaEnrolled: await require('../core/mfa').isEnabled(req.user.id),
        driver: String(require('../config/app').dbDriver || 'sqlite-native'),
        otherSites,
        restart: require('../core/restart').restartInfo(),
    });
}));

router.post('/enable', authenticate, sessionOnly, accountAuthorityOnly, asyncHandler(async (req: Request, res: Response) => {
    if (refuseSetupCaller(req, res)) return;
    if (siteContext.multisiteEnabled()) return res.status(409).json({ code: 'network_already_enabled', message: 'The network is already on.', data: { status: 409 } });
    if (await requireSudoPassword(req, res, (req.body || {}).currentPassword)) return;
    const mfa = await requireStepUp(req, res);
    if (!mfa) return;
    try {
        const r = await require('../core/network-setup').enableNetwork({ adminIds: (req.body || {}).admins, actorUserId: Number(req.user.id), mfa });
        res.json({ enabled: true, admins: r.admins, restart: r.restart });
    } catch (e: any) {
        return sendError(res, e);
    }
}));

router.post('/disable', authenticate, sessionOnly, accountAuthorityOnly, asyncHandler(async (req: Request, res: Response) => {
    if (refuseSetupCaller(req, res)) return;
    if (!siteContext.multisiteEnabled()) return res.status(409).json({ code: 'network_not_enabled', message: 'The network is already off.', data: { status: 409 } });
    if (await requireSudoPassword(req, res, (req.body || {}).currentPassword)) return;
    const mfa = await requireStepUp(req, res);
    if (!mfa) return;
    try {
        const r = await require('../core/network-setup').disableNetwork({ actorUserId: Number(req.user.id), mfa });
        res.json({ enabled: false, restart: r.restart });
    } catch (e: any) {
        return sendError(res, e);
    }
}));

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
        // The site's other host names (PUT /network/sites/:id/address); the main site's are its own screen's.
        aliases: site.id === siteContext.PRIMARY_SITE_ID ? [] : require('../core/network').siteAliases(site.id),
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
 *         description: "{ sites: NetworkSite[], localAddresses }, the main site first; localAddresses is true when the main site is on this computer (localhost), so new sites may use <name>.localhost addresses"
 *       401:
 *         description: Not signed in (rest_not_logged_in)
 *       403:
 *         description: Not a network administrator (rest_forbidden_network), or an API token
 *       404:
 *         description: Multisite is off, or this is not the main site
 *   post:
 *     summary: Create a site
 *     description: Provisions the site end to end - its record and address, its database, its uploads directory, its default options and its first administrator - or nothing at all. The address must be a domain name that no site of the network answers yet; while the main site is on this computer (localhost), a <name>.localhost address is accepted too.
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
    // localAddresses: the main site is on this computer, so new sites may use <name>.localhost addresses.
    res.json({ sites: require('../core/network').listSites().map(publicSite), localAddresses: require('../core/network-sites').mainSiteIsLocal() });
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

/**
 * @swagger
 * /network/sites/{id}/address:
 *   put:
 *     summary: Change a site's address and its other addresses
 *     description: >-
 *       Moves a site (not the main site, whose address is Settings → Site address) to another main
 *       address and/or replaces its other host names (the www twin, an old domain kept while visitors
 *       move). Each name is checked as at creation. Other host names are answered with the main address's
 *       scheme and port; links keep naming the main address. The site's own siteurl/home follow, a
 *       certificate kept for the old main address is removed, and the gateway hears the new addresses.
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
 *             required: [url, currentPassword]
 *             properties:
 *               url:
 *                 type: string
 *                 example: https://blog.example.com
 *               aliases:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: [www.blog.example.com]
 *               currentPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ site: NetworkSite }"
 *       400:
 *         description: An invalid address (network_invalid_url, network_invalid_alias), the main site (network_primary_site), or a wrong currentPassword
 *       401:
 *         description: Not signed in (rest_not_logged_in)
 *       403:
 *         description: Not a network administrator
 *       404:
 *         description: No such site (network_site_not_found)
 *       409:
 *         description: An address another site answers (network_host_taken)
 */
router.put('/sites/:id/address', asyncHandler(async (req: Request, res: Response) => {
    if (await requireSudoPassword(req, res, (req.body || {}).currentPassword)) return;
    const id = siteIdParam(req.params.id);
    if (id === null) return res.status(404).json({ code: 'network_site_not_found', message: 'No such site.', data: { status: 404 } });
    const b = req.body || {};
    try {
        const site = await require('../core/network-sites').changeSiteAddress(id, { url: b.url, aliases: b.aliases, actorUserId: Number(req.user.id) });
        return res.json({ site: publicSite(site) });
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
 * /network/sites/{id}/handoff:
 *   post:
 *     summary: Open a site's admin as administrator (a one-time, audited handoff)
 *     description: >-
 *       Re-authenticates the network administrator and answers a one-time URL on the site's main address
 *       (/login/handoff, the token in the fragment). The token is signed with the site's own key, names
 *       this network administrator and the site's address, works once and for 60 seconds; redeeming it
 *       (POST /auth/handoff on the site) starts a 30-minute session there, marked as a handoff, under the
 *       site's handoff account for this network administrator. Recorded in the network audit log
 *       (site.handoff.issued) and, once redeemed, in both logs. Never for the main site, a suspended site,
 *       an API token or an agent.
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
 *         description: "{ url, expiresAt }"
 *       400:
 *         description: The main site (network_primary_site)
 *       401:
 *         description: Not signed in (rest_not_logged_in)
 *       403:
 *         description: A wrong currentPassword (rest_bad_current_password), not a network administrator (rest_forbidden_network), or an API token or agent (rest_token_management_forbidden)
 *       404:
 *         description: No such site (network_site_not_found)
 *       409:
 *         description: The site is suspended (network_site_suspended)
 */
router.post('/sites/:id/handoff', asyncHandler(async (req: Request, res: Response) => {
    const id = siteIdParam(req.params.id);
    if (id === null) return res.status(404).json({ code: 'network_site_not_found', message: 'No such site.', data: { status: 404 } });
    if (await requireSudoPassword(req, res, (req.body || {}).currentPassword)) return;
    try {
        const handoff = await require('../core/network-handoff').issueHandoff(id, { id: Number(req.user.id), login: String(req.user.userLogin) }, {
            mfa: sessionMfaVerified(req),
            ip: String(require('../core/client-ip').clientIp(req) || '').slice(0, 45),
        });
        res.set('Cache-Control', 'no-store');
        res.json(handoff);
    } catch (e: any) {
        return sendError(res, e);
    }
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

// ── Network administrators (the panel's path for `npm run network -- admins add|remove`) ────────────

/**
 * @swagger
 * /network/admins:
 *   get:
 *     summary: The main site's administrators, and which of them are network administrators
 *     tags: [Network]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ administrators: [{ id, login, displayName, networkAdmin }] }"
 *       403:
 *         description: Not a network administrator
 *   post:
 *     summary: Make an administrator of the main site a network administrator
 *     tags: [Network]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, currentPassword]
 *             properties:
 *               userId:
 *                 type: integer
 *               currentPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: "{ administrators }"
 *       400:
 *         description: Not an administrator of the main site (network_admin_not_administrator)
 *       403:
 *         description: Not a network administrator, or a wrong currentPassword
 * /network/admins/{id}:
 *   delete:
 *     summary: Stop a user being a network administrator (never the last one)
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
 *         description: "{ administrators }"
 *       403:
 *         description: Not a network administrator, or a wrong currentPassword
 *       404:
 *         description: Not a network administrator (network_admin_not_found)
 *       409:
 *         description: The last network administrator (network_last_admin)
 */
router.get('/admins', asyncHandler(async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.json({ administrators: await require('../core/network-setup').mainSiteAdministrators() });
}));

router.post('/admins', asyncHandler(async (req: Request, res: Response) => {
    if (await requireSudoPassword(req, res, (req.body || {}).currentPassword)) return;
    const setup = require('../core/network-setup');
    try {
        const [admin] = await setup.checkedAdministrators([(req.body || {}).userId]);
        const network = require('../core/network');
        await network.addNetworkAdmin(admin.id, admin.login);
        await network.audit('network.admin.added', { actor: Number(req.user.id), detail: { login: admin.login, via: 'panel' } });
        await require('../core/audit').recordAudit(req.user.id, 'network.admin.add', 'user', admin.id, { login: admin.login });
        res.json({ administrators: await setup.mainSiteAdministrators() });
    } catch (e: any) {
        return sendError(res, e);
    }
}));

router.delete('/admins/:id', asyncHandler(async (req: Request, res: Response) => {
    if (await requireSudoPassword(req, res, (req.body || {}).currentPassword)) return;
    const id = siteIdParam(req.params.id);
    const network = require('../core/network');
    if (id === null || !network.listNetworkAdmins().includes(id)) {
        return res.status(404).json({ code: 'network_admin_not_found', message: 'That user is not a network administrator.', data: { status: 404 } });
    }
    if (network.listNetworkAdmins().length <= 1) {
        return res.status(409).json({ code: 'network_last_admin', message: 'The network needs at least one network administrator. Add another one first.', data: { status: 409 } });
    }
    await network.removeNetworkAdmin(id);
    await network.audit('network.admin.removed', { actor: Number(req.user.id), detail: { userId: id, via: 'panel' } });
    await require('../core/audit').recordAudit(req.user.id, 'network.admin.remove', 'user', id, {});
    res.json({ administrators: await require('../core/network-setup').mainSiteAdministrators() });
}));

module.exports = router;
// The password-and-fresh-code gate of the network switch, for the other doors that admit or remove
// machines (routes/cluster.ts).
module.exports.requireStepUp = requireStepUp;
