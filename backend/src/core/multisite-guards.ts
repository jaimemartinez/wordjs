/**
 * WordJS — what a site other than the main one may not do (multisite).
 *
 * Some of the install is network-wide, not per site: the plugin and theme code on disk, the backups of
 * the main database, the certificates, the main site's addresses, the installer. Those stay the main
 * site's (its administrators run the network); on every other site the routes that change them, or that
 * would hand out the main site's files, are refused.
 *
 * Phase 2: plugins RUN per site. Another site activates the plugins the network offers it, grants them
 * permissions up to the network's ceiling, and serves their routes, assets and bundles through its own
 * workers (core/plugins, core/plugin-isolate). Installing, updating, deleting or building plugin code
 * stays the network's.
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
 * /api/v1/plugins on another site. What a site does with the plugins the network installed is the
 * site's: list them, activate and deactivate them, grant and revoke their permissions (bounded by the
 * network's ceiling — core/plugin-permissions), set their egress allowlist, restart their worker, read
 * their status, and everything the admin shell and the public pages read (menus, active list, registry,
 * assets, bundles). What changes the CODE on disk — upload, delete, pack, the sample generator, installing
 * a bundled theme, freeing a port the plugin's listener needs, downloading its package — is the network's.
 */
const SITE_PLUGIN_ROUTES = [
    { method: 'GET', re: /^\/(?:menus|active|registry|assets)?\/?$/ },
    { method: 'GET', re: /^\/[^/]+\/(?:status|egress-hosts)\/?$/ },
    { method: 'POST', re: /^\/[^/]+\/(?:activate|deactivate|permissions|egress-hosts|reload)\/?$/ },
    // The frontend bundles of plugins (routes/plugin-bundles): reads, answered for this site's plugins.
    { method: 'GET', re: /^\/[^/]+\/(?:bundle(?:\/manifest|\/css)?|portal|admin-style(?:\/css)?)\/?$/ },
];
function pluginsOnSecondarySite(req: Request, res: Response, next: NextFunction) {
    if (!onSecondarySite()) return next();
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (method === 'OPTIONS' || SITE_PLUGIN_ROUTES.some((r) => r.method === method && r.re.test(req.path))) return next();
    return refuse(res, 403, 'rest_network_only', 'Plugin code is installed and removed by the network administrator.');
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
