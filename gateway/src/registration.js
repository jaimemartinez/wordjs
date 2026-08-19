'use strict';
/**
 * WHAT A REGISTRATION IS ALLOWED TO WRITE INTO THE REGISTRY — in one place, reachable from a test.
 *
 * THE BUG THIS EXISTS TO CLOSE (adversarial re-verify of audit #22). The proxy's owner check —
 * `routing.resolveTarget`, the control that stops a frontend node from serving `/api/v1/auth/login` —
 * decides with `group.name`. That label used to be copied verbatim out of the REQUEST BODY:
 *
 *     registry.set(route, { name: service.name, … })   // service === req.body
 *
 * The three guards on /register (ROLE_ROUTES, certCoversHost, target ownership) look at the declared
 * ROUTES, at the target URL and at who owns that URL. None of them ever looked at `req.body.name`. So
 * a node holding a perfectly valid `CN=frontend` certificate could register
 * `{ name: 'backend', url: 'https://its-own-host:3001', routes: ['/'] }`: every guard passes (`/` is
 * its role's route, the host is its own), and the catch-all group is now LABELLED 'backend'. The next
 * `/api/v1/auth/login` that arrives while no `/api` entry exists — first boot, or the window after a
 * backend restart — matches `/`, is judged by that label, and is proxied to the frontend node with the
 * password in the body. The guard trusted the very thing it was supposed to verify.
 *
 * So the label is derived here from things the peer cannot choose:
 *   1. the ROLE that owns the prefix in routing.ROLE_ROUTES — a static map, and the same one
 *      /register already enforced when it accepted the route;
 *   2. failing that, the AUTHENTICATED identity (the certificate CN handed in by requireIdentity),
 *      never `service.name`, which stays a display string with no authority at all.
 *
 * It is also applied to groups that ALREADY exist (a registry.json written by an older gateway may
 * carry a poisoned name) and on load, so a stale file cannot keep a label its peer chose.
 */

const routing = require('./routing');

/**
 * The authoritative label for a registered route: prefix ownership first, the authenticated CN
 * second, and `undefined` when neither is known (routing then falls back to prefixOwner itself, and
 * a path that requires a role gets no target — the safe answer).
 *
 * @param {string} route  the registered prefix
 * @param {string} [cn]   the peer's AUTHENTICATED certificate CN (never a body field)
 */
function groupOwner(route, cn) {
    return routing.prefixOwner(route) || (cn ? String(cn) : undefined);
}

/**
 * Apply one AUTHENTICATED registration to the registry.
 *
 * @param {Map} registry     the primary's registry
 * @param {Map} targetOwner  url → owning CN
 * @param {{url: string, routes: string[]}} service  the registration, ALREADY validated by /register
 * @param {string} [cn]      the peer's authenticated certificate CN
 */
function applyRegistration(registry, targetOwner, service, cn) {
    const url = service.url;
    const routes = Array.isArray(service.routes) ? service.routes : [];

    // Deleting an emptied route IS right here, unlike in the health sweep: a registration is an
    // authenticated, owner-checked declaration of what this node now serves, so a route it no
    // longer declares must stop existing rather than 502 forever. (And routing is owner-aware, so
    // a deleted '/api' still cannot be inherited by the frontend's '/'.)
    registry.forEach((group, route) => {
        if (group.targets.has(url)) {
            group.targets.delete(url);
            if (group.targets.size === 0) registry.delete(route);
        }
    });

    routes.forEach((route) => {
        if (!registry.has(route)) {
            registry.set(route, { name: groupOwner(route, cn), targets: new Set(), index: 0, metrics: new Map() });
        }
        const group = registry.get(route);
        // Re-stamp an existing group too: a label loaded from an older registry.json (or written by a
        // pre-fix gateway) must not survive a legitimate registration.
        group.name = groupOwner(route, cn) || group.name;
        group.targets.add(url);
    });

    if (cn) targetOwner.set(url, String(cn));
}

module.exports = { groupOwner, applyRegistration };
