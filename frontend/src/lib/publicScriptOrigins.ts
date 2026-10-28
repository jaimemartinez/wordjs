/**
 * The script origins the active plugins' public scripts declare (GET /plugins/assets → scripts[].origins),
 * for the public pages' Content-Security-Policy (lib/contentSecurityPolicy.ts).
 *
 * Read by src/proxy.ts, which runs on every request — so the answer is kept per site for a short while
 * (FRESH_MS), and a failed read is remembered briefly too (FAILED_MS) instead of being retried on every
 * request. A read that fails yields no origin: a third-party tag is then refused until the next read,
 * which is the safe direction. The request is the one the public layout makes for the same list (same
 * destination, same forwarded host, same relay proof), only uncached by Next.
 */
import { backendUrl, configuredPublicHost, relayProofFor, resolveServerBase } from './server-api';
import { resolveRevalidateSecret } from './revalidateSecret';
import { sanitizeScriptOrigins } from './contentSecurityPolicy';

const FRESH_MS = 30_000;
const FAILED_MS = 5_000;
const TIMEOUT_MS = 2_000;

const cache = new Map<string, { origins: string[]; until: number }>();
const inflight = new Map<string, Promise<string[]>>();

async function read(siteHost: string | null): Promise<string[]> {
    const url = backendUrl(resolveServerBase(), '/plugins/assets');
    if (!url) return [];
    const headers: Record<string, string> = { Accept: 'application/json' };
    const pub = configuredPublicHost();
    const host = siteHost || (pub && pub.host);
    if (host) {
        headers['x-forwarded-host'] = host;
        headers['x-forwarded-proto'] = pub ? pub.proto : 'https';
        const proof = relayProofFor(resolveRevalidateSecret());
        if (proof) headers['x-wordjs-relay'] = proof;
    }
    const res = await fetch(url, { headers, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GET /plugins/assets answered ${res.status}`);
    const body = (await res.json()) as { scripts?: Array<{ origins?: unknown }> };
    const all: string[] = [];
    for (const s of Array.isArray(body && body.scripts) ? body.scripts! : []) {
        if (s && Array.isArray(s.origins)) all.push(...(s.origins as string[]));
    }
    return sanitizeScriptOrigins(all);
}

/** The declared origins for this site (`siteHost`: another site of a network, null for the main one). */
export async function publicScriptOrigins(siteHost: string | null): Promise<string[]> {
    const key = siteHost || '';
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.origins;
    let pending = inflight.get(key);
    if (!pending) {
        pending = read(siteHost)
            .then((origins) => { cache.set(key, { origins, until: Date.now() + FRESH_MS }); return origins; })
            .catch(() => { cache.set(key, { origins: [], until: Date.now() + FAILED_MS }); return [] as string[]; })
            .finally(() => { inflight.delete(key); });
        inflight.set(key, pending);
    }
    return pending;
}

/** Tests only. */
export function _clearPublicScriptOrigins(): void {
    cache.clear();
    inflight.clear();
}
