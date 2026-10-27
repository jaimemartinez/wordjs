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
    const twins = schemeTwins(url, targetOwner, cn);

    // Deleting an emptied route IS right here, unlike in the health sweep: a registration is an
    // authenticated, owner-checked declaration of what this node now serves, so a route it no
    // longer declares must stop existing rather than 502 forever. (And routing is owner-aware, so
    // a deleted '/api' still cannot be inherited by the frontend's '/'.)
    registry.forEach((group, route) => {
        for (const stale of [url, ...twins]) group.targets.delete(stale);
        if (group.targets.size === 0) registry.delete(route);
    });
    for (const stale of twins) targetOwner.delete(stale);

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

/**
 * The same peer's targets at the SAME host and port in the OTHER scheme — which a new registration
 * replaces rather than joins.
 *
 * A single-host split install starts the frontend before setup, so it listens in plain HTTP and
 * registers `http://127.0.0.1:3001` once the installer issues its certificate; after its first restart
 * it listens with mTLS on that very socket and registers `https://127.0.0.1:3001`. The registry is
 * persisted, so without this both stayed in the group and round-robin sent every other request as
 * plain HTTP into a TLS socket (502 ECONNRESET) until the health sweep evicted the dead one. Only a
 * target the SAME authenticated identity owns is replaced: one node can never displace another's.
 */
function schemeTwins(url, targetOwner, cn) {
    if (!cn) return [];
    let parsed;
    try { parsed = new URL(url); } catch { return []; }
    const twins = [];
    for (const [other, owner] of targetOwner) {
        if (other === url || owner !== String(cn)) continue;
        try {
            const o = new URL(other);
            if (o.host === parsed.host && o.protocol !== parsed.protocol) twins.push(other);
        } catch { /* an unparsable stale entry is left to the health sweep */ }
    }
    return twins;
}

// ─── The registered target URL ──────────────────────────────────────────────────────────────────────

const net = require('net');
const os = require('os');

/** A loopback host: 127.0.0.0/8, ::1 (also IPv4-mapped), or the name localhost. */
function isLoopbackHost(host) {
    const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
    const v4 = h.startsWith('::ffff:') ? h.slice(7) : h;
    return net.isIPv4(v4) && v4.startsWith('127.');
}

/** This machine's own interface addresses (a co-located node may dial the gateway through one). */
function ownAddresses() {
    const out = new Set();
    try {
        for (const list of Object.values(os.networkInterfaces())) {
            for (const a of list || []) if (a && a.address) out.add(String(a.address).toLowerCase());
        }
    } catch { /* interfaces unreadable: loopback alone still counts */ }
    return out;
}

/**
 * Is the peer that sent a registration on THIS machine? Only such a peer may register a loopback
 * target: "127.0.0.1" in a registration names the GATEWAY's loopback, so a node elsewhere that sent it
 * would be pointing a route at whatever listens on the gateway machine's own ports.
 */
function peerIsLocal(remoteAddress, own = ownAddresses) {
    const a = String(remoteAddress || '').toLowerCase();
    if (!a) return false;
    if (isLoopbackHost(a)) return true;
    const plain = a.startsWith('::ffff:') && net.isIPv4(a.slice(7)) ? a.slice(7) : a;
    const mine = typeof own === 'function' ? own() : own;
    return !!mine && (mine.has(a) || mine.has(plain));
}

/**
 * A registered target in ONE canonical form, or null when it is not a usable origin.
 *
 * The value that is checked must be the value that is stored and the value ownership is compared on,
 * so the target is reduced to its origin (scheme, host, port: no path, query, fragment or credentials,
 * host lower-cased by the WHATWG parser, default port dropped) before any check runs. `socket` is what
 * ownership compares: the address the gateway would actually dial, with every loopback spelling
 * (localhost, 127.x, ::1) folded into one and the scheme left out — http and https on one port are one
 * listener, so they cannot belong to two identities.
 */
function normalizeTarget(raw) {
    if (typeof raw !== 'string' || raw === '' || raw.length > 2048) return null;
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!host) return null;
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const loopback = isLoopbackHost(host);
    return { url: u.origin, protocol: u.protocol, host, port, loopback, socket: `${loopback ? 'loopback' : host}:${port}` };
}

/**
 * The identity that already owns a target on the same SOCKET as `url` (any spelling, either scheme),
 * when that identity is not `cn`; otherwise null.
 */
function conflictingOwner(targetOwner, url, cn) {
    const t = normalizeTarget(url);
    if (!t) return null;
    for (const [other, owner] of targetOwner) {
        if (owner === String(cn)) continue;
        const o = normalizeTarget(other);
        if (o && o.socket === t.socket) return owner;
    }
    return null;
}

/**
 * Why /register must refuse this target, or null. Checks only what depends on the target and on who
 * sent it; the route, certificate-coverage, removed-node and ownership checks stay in the handler.
 *   · a loopback target is accepted only from a peer on this machine;
 *   · plain http is accepted only for a loopback target (a co-located service that started before
 *     its certificate existed). Between machines the cluster speaks mTLS: a registered http:// target
 *     on another host would carry every proxied request — credentials included — in clear text.
 */
function targetProblem(target, remoteAddress, own = ownAddresses) {
    if (!target) return 'invalid';
    if (target.loopback && !peerIsLocal(remoteAddress, own)) return 'loopback-from-remote';
    if (target.protocol === 'http:' && !target.loopback) return 'plain-http-remote';
    return null;
}

module.exports = {
    groupOwner, applyRegistration, schemeTwins,
    isLoopbackHost, peerIsLocal, normalizeTarget, conflictingOwner, targetProblem,
};
