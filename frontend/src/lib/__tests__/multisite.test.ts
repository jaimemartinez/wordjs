import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../../proxy";
import { canOpenAdminPath, sidebarSections, type AdminAccessUser } from "../adminAccess";
import { normalizeSiteHost, siteTags } from "../server-api";

/**
 * MULTISITE IN THE FRONTEND (documentation/multisite-design.md).
 *
 *   · src/proxy.ts sends another site's public pages to the `wjs-site/[siteHost]` tree, ONLY on the
 *     edge's own header, and never lets the main site reach that tree directly;
 *   · the admin shell offers each site only the screens it has, and the network screen to network
 *     administrators on the main site;
 *   · another site's data-cache entries carry tags of their own.
 */

const req = (path: string, headers: Record<string, string> = {}) =>
    new NextRequest(new URL(path, "http://example.com"), { headers });

/** Where the proxy sends a request: the rewrite target's path, "next" or the status it answers. */
function outcome(res: Response): string {
    const rewrite = res.headers.get("x-middleware-rewrite");
    if (rewrite) return new URL(rewrite).pathname;
    if (res.headers.get("x-middleware-next")) return "next";
    return String(res.status);
}

describe("proxy: another site of the network", () => {
    const site = { "x-wordjs-site-host": "two.example.org" };

    it("rewrites that site's public pages and documents to its tree", () => {
        expect(outcome(proxy(req("/", site)))).toBe("/wjs-site/two.example.org");
        expect(outcome(proxy(req("/hello", site)))).toBe("/wjs-site/two.example.org/hello");
        expect(outcome(proxy(req("/category/news/2", site)))).toBe("/wjs-site/two.example.org/category/news/2");
        expect(outcome(proxy(req("/feed.xml", site)))).toBe("/wjs-site/two.example.org/feed.xml");
        expect(outcome(proxy(req("/sitemap/posts-1.xml", site)))).toBe("/wjs-site/two.example.org/sitemap/posts-1.xml");
    });

    it("leaves the admin, sign-in, API and asset paths alone", () => {
        for (const p of ["/admin", "/admin/posts", "/login", "/api/v1/settings", "/uploads/2026/10/a.png", "/install", "/portal/x", "/logo.png"]) {
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

    it("another site offers no plugin, backup, hooks or site-address screen, even to its administrator", () => {
        const list = hrefs(otherSite);
        for (const p of ["/admin/plugins", "/admin/settings/backups", "/admin/hooks", "/admin/db-migration", "/admin/network"]) {
            expect(list, p).not.toContain(p);
        }
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

    it("accepts only hostnames as a site", () => {
        expect(normalizeSiteHost("Two.Example.org")).toBe("two.example.org");
        for (const bad of ["", "a/b", "..", "a b", "x".repeat(254), 5, null]) expect(normalizeSiteHost(bad)).toBeNull();
    });
});
