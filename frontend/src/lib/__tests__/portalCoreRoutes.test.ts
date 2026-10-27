/**
 * The core's own paths under a plugin portal (lib/portalRoutes.ts): /portal/<slug>/file, /sw.js and
 * /app.webmanifest. Each answers only what the backend's GET /plugins/<slug>/portal says the portal declares,
 * from the backend's validated details — never a path or a type the request names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Info = Record<string, unknown> | null;
let portals: Record<string, Info> = {};
let fetched: string[] = [];
let files: Record<string, unknown> = {};
let worker: { status: number; body: string } = { status: 404, body: "" };

beforeEach(() => {
    vi.resetModules();
    portals = {};
    fetched = [];
    files = {};
    worker = { status: 404, body: "" };
    vi.doMock("@/lib/server-api", () => ({
        getPortalPage: async (slug: string) => (portals[slug] ? { status: "served", info: portals[slug] } : { status: "missing" }),
        serverFetch: async (endpoint: string) => {
            fetched.push(endpoint);
            return files[new URL(`http://x${endpoint}`).searchParams.get("d") || ""] ?? null;
        },
        serverResponse: async (endpoint: string) => {
            fetched.push(endpoint);
            return new Response(worker.body, { status: worker.status });
        },
    }));
});
afterEach(() => { vi.doUnmock("@/lib/server-api"); });

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const TICKET = "a".repeat(32);

describe("/portal/<slug>/file", () => {
    it("answers the bytes of an allowlisted type, never cached or sniffed, from the endpoint the backend names", async () => {
        portals.conference = { slug: "conference", fileEndpoint: "/plugin/conference-manager/public/badge/file" };
        files[TICKET] = { mime: "application/pdf", filename: "Escarapela María.pdf", b64: Buffer.from("%PDF-1.4 x").toString("base64") };
        const { GET } = await import("../../app/portal/[slug]/file/route");
        const ok = await GET(new Request(`http://site/portal/conference/file?d=${TICKET}`), params("conference"));
        expect(ok.status).toBe(200);
        expect(fetched).toEqual([`/plugin/conference-manager/public/badge/file?d=${TICKET}`]);
        expect(ok.headers.get("content-type")).toBe("application/pdf");
        expect(ok.headers.get("cache-control")).toBe("no-store");
        expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
        expect(ok.headers.get("content-disposition")).toBe('inline; filename="Escarapela-Mar-a.pdf"');
        expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe("%PDF-1.4 x");
    });

    it("a bad or spent ticket, or a type outside the allowlist, is a 410; no file route is a 404", async () => {
        portals.conference = { slug: "conference", fileEndpoint: "/plugin/conference-manager/public/badge/file" };
        files["b".repeat(32)] = { mime: "text/html", filename: "x.html", b64: Buffer.from("<script>").toString("base64") };
        const { GET } = await import("../../app/portal/[slug]/file/route");
        for (const d of ["b".repeat(32), "c".repeat(32), "../etc", "", "x".repeat(200)]) {
            const r = await GET(new Request(`http://site/portal/conference/file?d=${encodeURIComponent(d)}`), params("conference"));
            expect(r.status, d).toBe(410);
        }
        portals.plain = { slug: "plain" };
        portals.odd = { slug: "odd", fileEndpoint: "https://evil.example/public/x" };
        for (const slug of ["plain", "odd", "missing", "Bad_Slug"]) {
            const r = await GET(new Request(`http://site/portal/${slug}/file?d=${TICKET}`), params(slug));
            expect(r.status, slug).toBe(404);
        }
        expect(fetched.some((e) => e.includes("evil"))).toBe(false);
    });
});

describe("/portal/<slug>/sw.js", () => {
    it("serves the declared worker as JavaScript, revalidated; a portal without one is a 404", async () => {
        portals.conference = { slug: "conference", serviceWorker: true };
        portals.plain = { slug: "plain" };
        worker = { status: 200, body: "self.addEventListener('push', () => {});" };
        const { GET } = await import("../../app/portal/[slug]/sw.js/route");
        const ok = await GET(new Request("http://site/portal/conference/sw.js"), params("conference"));
        expect(ok.status).toBe(200);
        expect(fetched).toEqual(["/plugins/conference/portal/sw"]);
        expect(ok.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
        expect(ok.headers.get("cache-control")).toBe("no-cache");
        expect(await ok.text()).toBe("self.addEventListener('push', () => {});");
        for (const slug of ["plain", "missing", "Bad_Slug"]) {
            expect((await GET(new Request(`http://site/portal/${slug}/sw.js`), params(slug))).status, slug).toBe(404);
        }
        worker = { status: 404, body: "" };
        expect((await GET(new Request("http://site/portal/conference/sw.js"), params("conference"))).status).toBe(404);
    });
});

describe("/portal/<slug>/app.webmanifest", () => {
    it("builds the manifest of an installable sub-page, scoped to it; anything else is a 404", async () => {
        portals.conference = {
            slug: "conference", themeColor: "#2563eb",
            pages: {
                yo: { title: "Mi inscripción", private: true, app: { name: "Mi inscripción", description: "Tu página.", backgroundColor: "#f3f4f6", themeColor: "#111827" } },
                badge: { title: "Escarapela", private: true },
            },
        };
        const { GET } = await import("../../app/portal/[slug]/app.webmanifest/route");
        const ok = await GET(new Request("http://site/portal/conference/app.webmanifest?page=yo"), params("conference"));
        expect(ok.status).toBe(200);
        expect(ok.headers.get("content-type")).toBe("application/manifest+json; charset=utf-8");
        expect(await ok.json()).toEqual({
            name: "Mi inscripción", short_name: "Mi inscripción", description: "Tu página.",
            scope: "/portal/conference/yo", start_url: "/portal/conference/yo", display: "standalone",
            background_color: "#f3f4f6", theme_color: "#111827",
        });
        for (const page of ["badge", "nope", "constructor", "", "../x"]) {
            const r = await GET(new Request(`http://site/portal/conference/app.webmanifest?page=${encodeURIComponent(page)}`), params("conference"));
            expect(r.status, page).toBe(404);
        }
    });

    it("lists the app's icon at both home-screen sizes; without one the manifest is unchanged", async () => {
        const app = { name: "Red de cuidado", themeColor: "#111827" };
        portals.red = { slug: "red", pages: { yo: { app }, mi: { app: { ...app, icon: "/plugins/red-de-cuidado/public/icon-512.png" } } } };
        const { GET } = await import("../../app/portal/[slug]/app.webmanifest/route");
        const plain = await GET(new Request("http://site/portal/red/app.webmanifest?page=yo"), params("red"));
        expect(await plain.text()).toBe(
            '{"name":"Red de cuidado","short_name":"Red de cuidado","scope":"/portal/red/yo","start_url":"/portal/red/yo","display":"standalone","theme_color":"#111827"}',
        );
        const withIcon = await (await GET(new Request("http://site/portal/red/app.webmanifest?page=mi"), params("red"))).json();
        expect(withIcon.icons).toEqual([
            { src: "/plugins/red-de-cuidado/public/icon-512.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
            { src: "/plugins/red-de-cuidado/public/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ]);
    });
});

describe("the <head> of a portal sub-page", () => {
    it("a described sub-page gets its title, its privacy and its web app manifest; the rest keep the portal's", async () => {
        vi.doMock("../../app/portal/[slug]/[[...path]]/PluginPortal", () => ({ default: () => null }));
        portals.conference = {
            slug: "conference", title: "Portal de coordinadores",
            pages: { yo: { title: "Mi inscripción", private: true, app: { name: "Mi inscripción", shortName: "Yo" } }, badge: { title: "Escarapela", private: true } },
        };
        const { generateMetadata } = await import("../../app/portal/[slug]/[[...path]]/page");
        const meta = (path?: string[]) => generateMetadata({ params: Promise.resolve({ slug: "conference", path }) });
        const root = await meta(undefined);
        expect(root.title).toBe("Portal de coordinadores");
        expect(root.robots).toEqual({ index: false, follow: false });
        expect(root.referrer).toBeUndefined();
        expect(root.manifest).toBeUndefined();
        const yo = await meta(["yo"]);
        expect(yo.title).toBe("Mi inscripción");
        expect(yo.referrer).toBe("no-referrer");
        expect(yo.robots).toMatchObject({ index: false, follow: false, nocache: true });
        expect(yo.manifest).toBe("/portal/conference/app.webmanifest?page=yo");
        expect(yo.appleWebApp).toMatchObject({ capable: true, title: "Yo" });
        expect(yo.icons).toBeUndefined();
        const badge = await meta(["badge"]);
        expect(badge.title).toBe("Escarapela");
        expect(badge.manifest).toBeUndefined();
        expect((await meta(["constructor"])).title).toBe("Portal de coordinadores");
        vi.doUnmock("../../app/portal/[slug]/[[...path]]/PluginPortal");
    });

    it("an installable sub-page with an icon links it as apple-touch-icon", async () => {
        vi.doMock("../../app/portal/[slug]/[[...path]]/PluginPortal", () => ({ default: () => null }));
        portals.red = { slug: "red", pages: { yo: { app: { name: "Red de cuidado", icon: "/plugins/red-de-cuidado/public/icon-512.png" } } } };
        const { generateMetadata } = await import("../../app/portal/[slug]/[[...path]]/page");
        const yo = await generateMetadata({ params: Promise.resolve({ slug: "red", path: ["yo"] }) });
        expect(yo.icons).toEqual({ apple: "/plugins/red-de-cuidado/public/icon-512.png" });
        expect((await generateMetadata({ params: Promise.resolve({ slug: "red", path: undefined }) })).icons).toBeUndefined();
        vi.doUnmock("../../app/portal/[slug]/[[...path]]/PluginPortal");
    });
});
