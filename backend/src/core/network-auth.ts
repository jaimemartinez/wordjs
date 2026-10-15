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
        return require('./network').isNetworkAdmin(Number(user.id));
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

module.exports = { isNetworkAdminRequest, requireNetworkAdmin };
