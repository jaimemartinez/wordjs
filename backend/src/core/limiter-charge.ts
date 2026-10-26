/**
 * WordJS - charge a rate limiter for work a request does beyond the one hit its mount already counted.
 *
 * express-rate-limit counts a REQUEST once. Some requests do the work of many: a GraphQL query is resolved
 * by REST sub-requests dispatched in process (core/graphql/dispatch), which never pass the API limiter's
 * mount again, and a multipart GraphQL request may carry several files past the upload limiter's single
 * hit. index.ts owns the limiters and their stores and registers one charger per limiter here; the code
 * that knows how much work a request does charges it, hit by hit, as the work happens.
 *
 * A limiter with no registered charger (a unit test that mounts the routers without index.ts) charges
 * nothing, and a store that fails is passed like the limiter itself passes it (passOnStoreError).
 */

import type { Request } from 'express';

/** Count `hits` more against `req`'s bucket; resolves false once the bucket is over its limit. */
export type LimiterCharger = (req: Request, hits: number) => Promise<boolean>;

const chargers = new Map<string, LimiterCharger>();

/** Register (or, with null, remove) the charger for `name`; returns the one it replaces. */
export function registerLimiterCharge(name: string, charger: LimiterCharger | null): LimiterCharger | null {
    const previous = chargers.get(name) || null;
    if (charger) chargers.set(name, charger);
    else chargers.delete(name);
    return previous;
}

/** true while `req`'s bucket is within the limit (or nothing is registered under `name`). */
export async function chargeLimiter(name: string, req: Request, hits = 1): Promise<boolean> {
    const charger = chargers.get(name);
    if (!charger || !(hits > 0)) return true;
    try {
        return await charger(req, hits);
    } catch {
        return true;
    }
}
