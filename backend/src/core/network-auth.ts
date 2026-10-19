/**
 * WordJS — who is a network administrator (multisite).
 *
 * A network administrator is an ADMINISTRATOR OF THE MAIN SITE whose user id is listed in the network
 * store (core/network network_admins). The role alone is not enough — a main-site administrator who
 * is not listed manages the main site and nothing else — and the listing alone is not enough either:
 * removing the administrator role removes the network powers with it. It is judged on the main site
 * only: user ids repeat across sites, so user 1 of another site is never user 1 of the network.
 */
import type { Request, Response, NextFunction } from 'express';

const siteContext = require('./site-context');

function isNetworkAdminRequest(req: Request): boolean {
    if (!siteContext.multisiteEnabled()) return false;
    if (siteContext.currentSiteIdOrNull() !== siteContext.PRIMARY_SITE_ID) return false;
    const user = req.user;
    if (!user || typeof user.getRole !== 'function' || user.getRole() !== 'administrator') return false;
    try {
        return require('./network').isNetworkAdmin(Number(user.id), user.userLogin);
    } catch {
        return false;
    }
}

/** After authenticate: 404 off the main site or with multisite off, 403 for anyone but a network administrator. */
function requireNetworkAdmin(req: Request, res: Response, next: NextFunction) {
    if (!siteContext.multisiteEnabled() || siteContext.currentSiteIdOrNull() !== siteContext.PRIMARY_SITE_ID) {
        return res.status(404).json({ code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } });
    }
    if (!isNetworkAdminRequest(req)) {
        return res.status(403).json({ code: 'rest_forbidden_network', message: 'Only a network administrator can do this.', data: { status: 403 } });
    }
    return next();
}

/**
 * Is `targetUserId` a network administrator this request may NOT act on?
 *
 * A listed network administrator sits above the administrators of the main site: their password, email,
 * role, second factor, agent connections and the account itself are changed by a network administrator
 * (or by themselves through their own self-service routes), never by an administrator of the main site
 * who is not one — that would hand the whole network to anyone who runs the main site. Still protected
 * after losing the administrator role, as long as they are listed. Only on the main site of a network:
 * user ids repeat across sites, and on a single site there is no such account. If the network store
 * cannot be read the account is treated as protected (fail closed).
 */
function protectsNetworkAdmin(req: Request, targetUserId: unknown): boolean {
    if (!siteContext.multisiteEnabled()) return false;
    if (siteContext.currentSiteIdOrNull() !== siteContext.PRIMARY_SITE_ID) return false;
    const id = Number(targetUserId);
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    let listed: boolean;
    try {
        listed = require('./network').isNetworkAdmin(id);
    } catch {
        listed = true;
    }
    if (!listed) return false;
    if (req.user && Number(req.user.id) === id) return false;
    return !isNetworkAdminRequest(req);
}

/** The one answer for protectsNetworkAdmin: 403 rest_forbidden_network. */
function refuseNetworkAdminTarget(res: Response) {
    return res.status(403).json({
        code: 'rest_forbidden_network',
        message: 'Only a network administrator can change or remove a network administrator account.',
        data: { status: 403 },
    });
}

/**
 * Settings whose effect is NETWORK-wide, not the site's: the Redis object-cache switch is one process-wide
 * flag (core/cache) shared by every site this server answers. Every writer of options that takes a value
 * from a request (routes/settings, the site import) leaves them alone when networkSettingsReadOnly.
 */
const NETWORK_WIDE_SETTINGS: ReadonlySet<string> = new Set(['redis_cache_enabled']);

/** May this request NOT change the network-wide settings? Another site, or a main-site admin who is not a network admin. Never on a single site. */
function networkSettingsReadOnly(req: Request): boolean {
    if (!siteContext.multisiteEnabled()) return false;
    if (siteContext.currentSiteIdOrNull() !== siteContext.PRIMARY_SITE_ID) return true;
    return !isNetworkAdminRequest(req);
}

/**
 * Re-check the network administrator rows against the main site's accounts (core/network
 * reconcileNetworkAdmins): at boot and after the main database is restored. Runs as the main site.
 */
async function recheckNetworkAdmins() {
    const User = require('../models/User');
    const account = (u: any) => (u ? { id: Number(u.id), login: String(u.userLogin) } : null);
    return siteContext.runWithSite(siteContext.PRIMARY_SITE_ID, () => require('./network').reconcileNetworkAdmins({
        byId: async (id: number) => account(await User.findById(id)),
        byLogin: async (login: string) => account(await User.findByLogin(login)),
    }));
}

module.exports = {
    recheckNetworkAdmins,
    isNetworkAdminRequest,
    requireNetworkAdmin,
    protectsNetworkAdmin,
    refuseNetworkAdminTarget,
    NETWORK_WIDE_SETTINGS,
    networkSettingsReadOnly,
};
