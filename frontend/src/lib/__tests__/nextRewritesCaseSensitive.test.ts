/**
 * Next's rewrites match a path exactly as the gateway and the monolith route it (review EDGE-R1).
 *
 * Both dispatchers send the backend's prefixes (`/api`, `/uploads`, …) to the backend by the raw,
 * case-sensitive path, and everything else to Next. Next compares its custom routes case-INsensitively
 * unless `experimental.caseSensitiveRoutes` is on, so `/API/v1/settings` went to Next, matched the
 * `/api/:path*` rewrite and was proxied back into the public listener as /api/v1/settings — from
 * loopback, with Next's loopback Host and the visitor's X-Forwarded-For: what the backend reads as a
 * local proxy rewriting Host. The matcher below is Next's own, compiled the way
 * next/dist/server/lib/router-utils/filesystem.js (buildCustomRoute) compiles each rewrite.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig from "../../../next.config";

type Rewrite = { source: string; destination: string };
const target = createRequire(import.meta.url)("../../../backend-proxy-target.js") as {
    isProxiedPath: (p: string) => boolean;
    NEXT_OWNED_API_PATHS: string[];
};

describe("the backend-prefix rewrites", () => {
    it("are case-sensitive, so no other spelling of a backend prefix is proxied back into the listener", async () => {
        expect(nextConfig.experimental?.caseSensitiveRoutes).toBe(true);
        const rewrites = (await nextConfig.rewrites!()) as Rewrite[];
        expect(rewrites.length).toBeGreaterThan(0);
        for (const rewrite of rewrites) {
            const match = getPathMatch(rewrite.source, {
                removeUnnamedParams: true,
                strict: true,
                sensitive: nextConfig.experimental?.caseSensitiveRoutes,
            });
            const prefix = rewrite.source.replace(/\/:path\*$/, "");
            expect(match(`${prefix}/v1/settings`), rewrite.source).toBeTruthy();
            for (const other of [prefix.toUpperCase(), prefix.replace(/[a-z]/, (c) => c.toUpperCase())]) {
                expect(match(`${other}/v1/settings`), `${other} against ${rewrite.source}`).toBe(false);
            }
        }
    });

    it("never match a path the dispatchers hand to Next, except the App Router's own routes (no loop back into the listener)", async () => {
        // The dispatchers (gateway, monolith, frontend replica: backend-proxy-target isProxiedPath, which
        // gateway/test/dispatcher-parity.test.js holds the three to) send a path to Next when it is not the
        // backend's. If one of Next's rewrites then matched it, Next would proxy it to the baked
        // http://localhost:<gatewayPort> — the listener that just handed it over, which hands it over again.
        // `/api/revalidate/x` did exactly that: the Next-owned exception covered everything below the route.
        const rewrites = (await nextConfig.rewrites!()) as Rewrite[];
        const matchers = rewrites.map((r) => getPathMatch(r.source, { removeUnnamedParams: true, strict: true, sensitive: nextConfig.experimental?.caseSensitiveRoutes }));
        // A route handler wins over the rewrites, and its trailing-slash twin is redirected to it first.
        const ownedByNext = new Set(target.NEXT_OWNED_API_PATHS.flatMap((route) => [route, `${route}/`]));
        const probes = ["/api/revalidate", "/api/revalidate/", "/api/revalidate/x", "/api/revalidate/a/b", "/api/revalidateXYZ",
            "/API/v1/settings", "/Api/x", "/UPLOADS/a.png", "/Themes/x.css", "/PLUGINS/x.js", "/Public/x.css", "/.WELL-KNOWN/x",
            "/apiary", "/uploadsomething", "/about", "/", "/_next/static/x.js"];
        for (const p of probes) {
            if (target.isProxiedPath(p) || ownedByNext.has(p)) continue;
            expect(matchers.some((m) => m(p) !== false), `${p} goes to Next, and a rewrite would send it back`).toBe(false);
        }
    });
});
