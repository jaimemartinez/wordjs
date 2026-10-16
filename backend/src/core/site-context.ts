/**
 * WordJS — which site the current work belongs to (multisite).
 *
 * A network serves several sites from one install; each site has its own database, uploads root,
 * caches and signing key (see documentation/multisite-design.md). Everything that touches site data
 * asks THIS module which site it is working for, and the answer travels with the async call chain
 * through one AsyncLocalStorage, so a request, everything it awaits and every timer it schedules stay
 * on the site the request was addressed to.
 *
 * SINGLE-SITE INSTALLS. Unless `multisite.enabled` is true in wordjs-config.json there is exactly one
 * site, id 1, and `currentSiteId()` answers 1 with no context at all. No other module changes
 * behaviour: site 1 keeps today's database, upload paths, cache keys, tags and tokens.
 *
 * FAIL CLOSED. With multisite on, work that reaches site data with NO site context throws
 * `site_context_missing` instead of defaulting to site 1. Defaulting would turn every missed
 * propagation (a callback re-entering from another process, a timer created outside a request) into
 * a read or write on the main site's data. The HTTP layer always enters a context (index.ts), the boot
 * sequence runs as site 1, and background work for the other sites goes through `forEachSite`.
 *
 * A context whose site is `null` is an explicit "this request names no site we serve": any data access
 * from it throws as well. It is what a request on an unknown address runs with until it is refused.
 */
import { AsyncLocalStorage } from 'async_hooks';

const config = require('../config/app');

export const PRIMARY_SITE_ID = 1;

type SiteStore = { siteId: number | null };

const storage = new AsyncLocalStorage<SiteStore>();

/** A typed error with a stable code, so callers and tests can tell this failure from any other. */
export class SiteContextError extends Error {
    code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = 'SiteContextError';
        this.code = code;
    }
}

/** Is this install a network of sites? Read live: tests and the CLI flip it on the config object. */
export function multisiteEnabled(): boolean {
    const m = (config as any).multisite;
    return !!(m && typeof m === 'object' && m.enabled === true);
}

/** A site id is a positive safe integer. Anything else is refused before it reaches a lookup. */
export function isSiteId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * The site the current work belongs to. Single-site: always 1. Multisite: the site of the enclosing
 * context; throws when there is none, or when the context names no site.
 */
export function currentSiteId(): number {
    if (!multisiteEnabled()) return PRIMARY_SITE_ID;
    const store = storage.getStore();
    if (!store) {
        throw new SiteContextError('site_context_missing', 'No site context: this work did not say which site it belongs to.');
    }
    if (store.siteId === null) {
        throw new SiteContextError('site_unresolved', 'This request was not addressed to a site this network serves.');
    }
    return store.siteId;
}

/** The current site id, or null where `currentSiteId()` would throw. Never a default. */
export function currentSiteIdOrNull(): number | null {
    try { return currentSiteId(); } catch { return null; }
}

/** True for site 1 (and for every single-site install). Throws like `currentSiteId()`. */
export function isPrimarySite(): boolean {
    return currentSiteId() === PRIMARY_SITE_ID;
}

/**
 * Run `fn` (and everything it awaits or schedules) as `siteId`. `null` runs it as "no site": a
 * request on an address that maps to no site, so data access from it fails.
 */
export function runWithSite<T>(siteId: number | null, fn: () => T): T {
    if (siteId !== null && !isSiteId(siteId)) {
        throw new SiteContextError('site_invalid', `Not a site id: ${String(siteId)}`);
    }
    return storage.run({ siteId }, fn);
}

/**
 * The key segment that keeps one site's entries apart from another's in a shared namespace (a cache
 * key, a lock name, a tag): '' for site 1, so single-site and main-site keys stay exactly what they
 * were, and `s<id>:` for every other site.
 */
export function siteKeyPrefix(siteId: number = currentSiteId()): string {
    return siteId === PRIMARY_SITE_ID ? '' : `s${siteId}:`;
}

/**
 * Module state that must be one value per site (a cache of roles, a throttle, a queue). `get()`
 * returns the current site's value, creating it with `init` on first use. Site 1's value is the one a
 * single-site install has always had.
 */
export function perSite<T>(init: () => T): { get(): T; forSite(siteId: number): T; reset(): void } {
    const values = new Map<number, T>();
    const forSite = (siteId: number): T => {
        let v = values.get(siteId);
        if (v === undefined) {
            v = init();
            values.set(siteId, v);
        }
        return v;
    };
    return {
        get: () => forSite(currentSiteId()),
        forSite,
        reset: () => values.clear(),
    };
}
