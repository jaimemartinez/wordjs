/**
 * WordJS — what a site other than the main one may not do (multisite, phase 1).
 *
 * Some of the install is network-wide, not per site: the plugin and theme code on disk, the backups of
 * the main database, the certificates, the main site's addresses, the installer. In phase 1 those stay
 * the main site's (its administrators run the network); on every other site the routes that change
 * them, or that would hand out the main site's files, are refused. Plugins are not active on the other
 * sites at all, so their routes, assets and bundles do not exist there.
 *
 * Every guard here is a no-op on a single site and on the main site.
 */
import type { Request, Response, NextFunction } from 'express';

const siteContext = require('./site-context');

/** True while working for a site other than the main one (never on a single site). */
function onSecondarySite(): boolean {
    return siteContext.multisiteEnabled() && siteContext.currentSiteId() !== siteContext.PRIMARY_SITE_ID;
}

function refuse(res: Response, status: number, code: string, message: string) {
    return res.status(status).json({ code, message, data: { status } });
}

/** The whole subtree is the main site's: 404 elsewhere (as if it did not exist). */
function mainSiteOnly(req: Request, res: Response, next: NextFunction) {
    if (!onSecondarySite()) return next();
    return refuse(res, 404, 'rest_no_route', 'Not available on this site.');
}

/** Reads are allowed, every write is the main site's (the installer, theme files). */
function mainSiteWrites(req: Request, res: Response, next: NextFunction) {
    if (!onSecondarySite() || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    return refuse(res, 403, 'rest_network_only', 'Only the main site can change this; ask the network administrator.');
}

/**
 * /api/v1/plugins on another site: the admin shell's reads answer for THIS site, where no plugin is
 * active (an empty menu of plugin pages, no active plugins, no public assets); everything else — the
 * installed list, activation, upload, permissions — belongs to the main site.
 */
function pluginsOnSecondarySite(req: Request, res: Response, next: NextFunction) {
    if (!onSecondarySite()) return next();
    if (req.method === 'GET') {
        const p = req.path.replace(/\/+$/, '');
        if (p === '/menus') return next(); // core entries of this site (core/adminMenu is per site)
        if (p === '/active' || p === '/registry') return res.json([]);
        if (p === '/assets') return res.json({ scripts: [], styles: [] });
    }
    return refuse(res, 403, 'rest_network_only', 'Plugins are managed on the main site of the network.');
}

/** Theme files are network-wide: creating, editing, uploading, restoring or deleting them is the main site's. */
const THEME_FILE_WRITES = [
    { method: 'POST', re: /^\/upload\/?$/ },
    { method: 'POST', re: /^\/?$/ },
    { method: 'POST', re: /^\/default\/?$/ },
    { method: 'PUT', re: /^\/[^/]+\/?$/ },
    { method: 'DELETE', re: /^\/[^/]+\/?$/ },
];
function themeFilesOnSecondarySite(req: Request, res: Response, next: NextFunction) {
    if (!onSecondarySite()) return next();
    if (THEME_FILE_WRITES.some((w) => w.method === req.method && w.re.test(req.path))) {
        return refuse(res, 403, 'rest_network_only', 'Themes are installed and edited on the main site of the network.');
    }
    return next();
}

module.exports = {
    onSecondarySite,
    mainSiteOnly,
    mainSiteWrites,
    pluginsOnSecondarySite,
    themeFilesOnSecondarySite,
};
