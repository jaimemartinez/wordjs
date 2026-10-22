/**
 * The "backend unreachable" render of a public route must never be CACHED (FALLOS 120).
 *
 * A public page is ISR (revalidate 60): whatever it renders is stored and served to everyone, stale
 * included, until a later render replaces it. Two moments rendered the outage message into that store:
 *   - `next build`, which prerenders the homepage with no backend running: the release shipped
 *     `.next/server/app/index.html` as "Service Temporarily Unavailable", and a fresh install or upgrade
 *     served it (x-nextjs-cache STALE) for minutes;
 *   - a background revalidation during a backend blip, which replaced the good cached page with the
 *     outage one.
 *
 * At runtime the route THROWS instead (`BackendUnavailableError`): Next keeps serving the last good
 * render, or answers this one request with the error page, and caches nothing. During `next build`
 * a throw would fail the build, so the page renders the outage markup tagged with OUTAGE_ATTR, and the
 * post-build step (scripts/drop-outage-prerenders.js) deletes every prerender carrying it: the first
 * request after start renders the page for real.
 */

/** The attribute that tags an outage render; the post-build step finds prerenders by it. */
export const OUTAGE_ATTR = "data-wjs-outage";

export class BackendUnavailableError extends Error {
    constructor(route: string) {
        super(`WordJS backend unreachable while rendering ${route}; not caching an outage render`);
        this.name = "BackendUnavailableError";
    }
}

/** True inside `next build` (static generation), where a throw would fail the whole build. */
export function isBuildPhase(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.NEXT_PHASE === "phase-production-build";
}

/**
 * Call where a public route found no backend. Throws at runtime (nothing gets cached); returns during
 * the build, so the caller renders its OUTAGE_ATTR-tagged markup for the post-build step to remove.
 */
export function refuseOutageRender(route: string, env: NodeJS.ProcessEnv = process.env): void {
    if (!isBuildPhase(env)) throw new BackendUnavailableError(route);
}
