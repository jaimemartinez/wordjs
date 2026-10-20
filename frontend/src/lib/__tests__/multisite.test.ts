import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../../proxy";
import { canOpenAdminPath, sidebarSections, type AdminAccessUser } from "../adminAccess";
import { fromRequestedSite, normalizeSiteHost, siteTags } from "../server-api";

/**
 * MULTISITE IN THE FRONTEND (documentation/multisite-design.md).
 *
 *   · src/proxy.ts routes another site's public pages to the `wjs-site/[siteHost]` tree (next.config's
 *     internal rewrite), ONLY on the edge's own header, and never lets the main site reach that tree;
 *   · the admin shell offers each site only the screens it has, and the network screen to network
 *     administrators on the main site;
 *   · another site's data-cache entries carry tags of their own.
 */

const req = (path: string, headers: Record<string, string> = {}) =>
    new NextRequest(new URL(path, "http://example.com"), { headers });

/**
 * What the proxy decided: the site a request is routed to (the internal `x-wordjs-site-route` it set on
 * the request), "next" for a request it leaves alone, or the status it answered.
 */
function outcome(res: Response): string {
    const route = res.headers.get("x-middleware-request-x-wordjs-site-route");
    if (route) return `site:${route}`;
    if (res.headers.get("x-middleware-next")) return "next";
    return String(res.status);
}

/** The request headers the proxy passes on (Next's override list), lower-case. */
function passedHeaders(res: Response): string[] {
    return String(res.headers.get("x-middleware-override-headers") || "").split(",").map((h) => h.trim()).filter(Boolean);
}

describe("proxy: another site of the network", () => {
    const site = { "x-wordjs-site-host": "two.example.org" };

    it("routes that site's public pages and documents to its tree", () => {
        for (const p of ["/", "/hello", "/category/news/2", "/feed.xml", "/sitemap/posts-1.xml", "/tag/x/feed.xml"]) {
            expect(outcome(proxy(req(p, site))), p).toBe("site:two.example.org");
        }
    });

    it("never returns a rewrite of its own: the internal rewrite is next.config's", () => {
        // A rewrite returned here is external behind the gateway's mTLS hop (lab finding, split mode).
        const res = proxy(req("/hello", site));
        expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    });

    it("leaves the admin, sign-in, API and asset paths alone", () => {
        for (const p of ["/admin", "/admin/posts", "/login", "/api/v1/settings", "/uploads/2026/10/a.png", "/install", "/portal/x", "/logo.png", "/fonts/Inter.woff2"]) {
            expect(outcome(proxy(req(p, site))), p).toBe("next");
        }
    });

    it("refuses a header that is not a hostname", () => {
        expect(outcome(proxy(req("/", { "x-wordjs-site-host": "../etc" })))).toBe("400");
        expect(outcome(proxy(req("/", { "x-wordjs-site-host": "a/b" })))).toBe("400");
    });
});

describe("proxy: the main site (and every single site)", () => {
    it("serves its pages exactly as before", () => {
        for (const p of ["/", "/hello", "/feed.xml", "/admin"]) expect(outcome(proxy(req(p))), p).toBe("next");
    });

    it("cannot reach another site's tree directly", () => {
        expect(outcome(proxy(req("/wjs-site/two.example.org")))).toBe("404");
        expect(outcome(proxy(req("/wjs-site/two.example.org/hello")))).toBe("404");
    });

    it("removes a client's own routing header, on every path", () => {
        for (const headers of [{ "x-wordjs-site-route": "two.example.org" }, { "x-wordjs-site-route": "two.example.org", "x-wordjs-site-host": "three.example.org" }] as Record<string, string>[]) {
            const res = proxy(req("/admin", headers));
            expect(passedHeaders(res)).not.toContain("x-wordjs-site-route");
        }
        expect(outcome(proxy(req("/hello", { "x-wordjs-site-route": "two.example.org" })))).toBe("next");
    });
});

describe("next.config: the multisite rewrite", () => {
    async function rewrites(mode?: string) {
        const saved = process.env.WORDJS_MODE;
        if (mode === undefined) delete process.env.WORDJS_MODE; else process.env.WORDJS_MODE = mode;
        try {
            const { default: nextConfig } = await import("../../../next.config");
            return await (nextConfig.rewrites as () => Promise<any>)();
        } finally {
            if (saved === undefined) delete process.env.WORDJS_MODE; else process.env.WORDJS_MODE = saved;
        }
    }

    it("is a beforeFiles rule on the routing header, with an INTERNAL destination, in every mode", async () => {
        for (const mode of [undefined, "mono"]) {
            const { beforeFiles } = await rewrites(mode);
            expect(beforeFiles.map((r: any) => [r.source, r.destination]), String(mode)).toEqual([
                // '/:path+' first: Next chains matching beforeFiles rules, and '/' first had its result
                // rewritten again (the home page of another site was a 404 in a production build).
                ["/:path+", "/wjs-site/:siteHost/:path+"],
                ["/", "/wjs-site/:siteHost"],
            ]);
            for (const r of beforeFiles) {
                expect(r.destination.startsWith("/"), "relative: Next never proxies it").toBe(true);
                expect(r.has).toEqual([{ type: "header", key: "x-wordjs-site-route", value: "(?<siteHost>[a-z0-9_][a-z0-9_.-]{0,252})" }]);
            }
        }
    });
});

describe("admin shell per site", () => {
    const single: AdminAccessUser = { role: "administrator", capabilities: ["*"] };
    const mainAdmin: AdminAccessUser = { ...single, network: { mainSite: true, networkAdmin: false } };
    const networkAdmin: AdminAccessUser = { ...single, network: { mainSite: true, networkAdmin: true } };
    const otherSite: AdminAccessUser = { ...single, network: { mainSite: false, networkAdmin: false } };
    const hrefs = (u: AdminAccessUser) => {
        const s = sidebarSections(u, []);
        return [...s.core, ...s.management].map((i) => i.href);
    };

    it("a single site keeps every screen it had, and has no network screen", () => {
        expect(hrefs(single)).toContain("/admin/plugins");
        expect(hrefs(single)).not.toContain("/admin/network");
        expect(canOpenAdminPath("/admin/network", single, [])).toBe(false);
        expect(canOpenAdminPath("/admin/settings/site-address", single, [])).toBe(true);
    });

    it("another site offers no plugin-code, hooks or site-address screen, even to its administrator; its backups are its own", () => {
        const list = hrefs(otherSite);
        for (const p of ["/admin/plugins", "/admin/hooks", "/admin/db-migration", "/admin/network"]) {
            expect(list, p).not.toContain(p);
        }
        expect(list).toContain("/admin/settings/backups");
        expect(list).toContain("/admin/posts");
        expect(canOpenAdminPath("/admin/plugins", otherSite, [])).toBe(false);
        expect(canOpenAdminPath("/admin/settings/site-address", otherSite, [])).toBe(false);
        expect(canOpenAdminPath("/admin/settings", otherSite, [])).toBe(true);
    });

    it("the network screen is for network administrators on the main site only", () => {
        expect(hrefs(networkAdmin)).toContain("/admin/network");
        expect(hrefs(mainAdmin)).not.toContain("/admin/network");
        expect(canOpenAdminPath("/admin/network", networkAdmin, [])).toBe(true);
        expect(canOpenAdminPath("/admin/network", mainAdmin, [])).toBe(false);
        expect(canOpenAdminPath("/admin/network", { ...single, network: { mainSite: false, networkAdmin: true } }, [])).toBe(false);
    });
});

describe("data cache per site", () => {
    it("tags another site's reads with its host, and leaves the main site's as they were", () => {
        expect(siteTags(["posts", "settings"], "two.example.org")).toEqual(["site:two.example.org:posts", "site:two.example.org:settings"]);
        expect(siteTags(["posts"], null)).toEqual(["posts"]);
        expect(siteTags(undefined, "two.example.org")).toBeUndefined();
    });

    it("refuses another site's read that came back from a different site (fails closed)", () => {
        const answered = (host?: string) => new Response("{}", { headers: host ? { "x-wordjs-site-host": host } : {} });
        expect(fromRequestedSite(answered("two.example.org"), "two.example.org")).not.toBeNull();
        expect(fromRequestedSite(answered("main.example.org"), "two.example.org")).toBeNull();
        expect(fromRequestedSite(answered(), "two.example.org")).toBeNull();
        // The main site's reads are not checked, as before multisite.
        expect(fromRequestedSite(answered(), null)).not.toBeNull();
    });

    it("accepts only hostnames as a site", () => {
        expect(normalizeSiteHost("Two.Example.org")).toBe("two.example.org");
        for (const bad of ["", "a/b", "..", "a b", "x".repeat(254), 5, null]) expect(normalizeSiteHost(bad)).toBeNull();
    });
});
