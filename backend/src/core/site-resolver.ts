/**
 * WordJS — assign every HTTP request to the site it was addressed to (multisite).
 *
 * Mounted right after the host gate (index.ts), before CORS, cookies, rate limiters and every route, so
 * all of them run inside the request's site context (core/site-context). The site comes from the
 * address the gate judged (`req.siteHost.siteId`), or, on the paths the gate does not check (static
 * files, probes), from the same classification done here:
 *
 *   another site's declared address        → that site (its database opened first)
 *   the main site's addresses, loopback,
 *   IP literals, no Host at all            → site 1
 *   an address no site declares            → no site: /uploads and /plugins answer 404 (nothing of any
 *                                            site is served there); probes and the network-wide static
 *                                            trees (/themes, /public, /.well-known, /health…) run as
 *                                            site 1, which is what they always served
 *
 * A suspended site answers 503 to everything. On a single site this middleware is a no-op.
 */
import type { Request, Response, NextFunction } from 'express';

const hostPolicy = require('./host-policy');
const siteContext = require('./site-context');

/** Paths of one site's own files: never served for an address that names no site. */
const SITE_FILE_PREFIXES = ['/uploads', '/plugins'];

function underPrefix(p: string, prefix: string): boolean {
    return p === prefix || p.startsWith(prefix + '/');
}

function resolveSiteId(req: Request, getPolicy: () => any): number | null {
    const judged = (req as Request & { siteHost?: { siteId?: unknown } }).siteHost;
    if (judged && typeof judged.siteId === 'number') return judged.siteId;
    const pol = getPolicy();
    const authority = hostPolicy.requestAuthority(req, pol);
    if (authority.absent) return siteContext.PRIMARY_SITE_ID;
    if (!authority.parsed) return null;
    return hostPolicy.siteIdOf(hostPolicy.classify(authority.parsed, pol, { proxied: authority.proxied }));
}

/**
 * Every response of a network says which site answered it (`X-WordJS-Site-Host`: that site's main
 * hostname). The frontend renders another site's pages from data it fetches server-side, through
 * whatever path the deployment gives it to the backend; it refuses data that came from any other site
 * (lib/server-api), so a topology that loses the site on the way fails closed instead of showing one
 * site's content under another's address. Names nothing a visitor of that site does not know already.
 */
const SITE_HEADER = 'X-WordJS-Site-Host';
function stateSite(res: Response, hostname: string | null): void {
    if (hostname) res.setHeader(SITE_HEADER, hostname);
}
function mainSiteHostname(): string | null {
    const site = hostPolicy.parseSiteUrl(require('../config/app').siteUrl);
    return site ? site.hostname : null;
}

function siteResolver(opts: { getPolicy: () => any }) {
    return function resolveSite(req: Request, res: Response, next: NextFunction) {
        if (!siteContext.multisiteEnabled()) return next();
        let siteId: number | null;
        try {
            siteId = resolveSiteId(req, opts.getPolicy);
        } catch (e) {
            return next(e);
        }
        const p = String(req.path || '/');
        if (siteId === null) {
            if (SITE_FILE_PREFIXES.some((x) => underPrefix(p, x))) {
                res.set('Cache-Control', 'no-store');
                return res.status(404).end();
            }
            // The API never gets here (the host gate answered 421); everything else the gate exempts is
            // network-wide and is answered as it always was.
            siteId = siteContext.PRIMARY_SITE_ID;
        }
        if (siteId === siteContext.PRIMARY_SITE_ID) {
            stateSite(res, mainSiteHostname());
            return siteContext.runWithSite(siteId, () => {
                // The body stream's events (an upload read by multer) resume as this site too.
                siteContext.bindRequestToCurrentSite(req);
                next();
            });
        }

        const network = require('./network');
        const site = network.getSite(siteId);
        if (!site) {
            // The policy named a site the registry no longer has (it changed in between): no such site.
            res.set('Cache-Control', 'no-store');
            return res.status(421).json({ code: 'rest_host_not_allowed', message: 'This site does not answer on this address.', data: { status: 421 } });
        }
        if (site.status === 'suspended') {
            res.set('Cache-Control', 'no-store');
            return res.status(503).json({ code: 'rest_site_suspended', message: 'This site is suspended.', data: { status: 503 } });
        }
        const id = siteId;
        stateSite(res, site.mainHost);
        siteContext.runWithSite(id, () => {
            siteContext.bindRequestToCurrentSite(req);
            // Prepared, then its plugin and theme workers running (started now if the site was idle, and
            // kept up until this response is over — core/site-workers), so the request reaches them.
            require('./network-sites').prepareSite(id)
                .then(() => require('./site-workers').enterRequest(id, res))
                .then(() => next())
                .catch((e: any) => next(e));
        });
    };
}

module.exports = { siteResolver, resolveSiteId };
