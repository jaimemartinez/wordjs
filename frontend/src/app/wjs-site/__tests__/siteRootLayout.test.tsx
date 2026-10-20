/**
 * MULTISITE: EVERY SITE'S OWN DOCUMENT.
 *
 * There is no app/layout.tsx: each top-level tree's layout is a root layout and renders
 * app/_root/RootDocument.tsx, and `wjs-site/[siteHost]/layout.tsx` is the root layout of another site of
 * the network. These tests render the REAL layouts against two sites with different data, and prove:
 *
 *   · a secondary site's page gets ITS `<html lang dir>`, ITS @font-face rules and ITS name and title
 *     template (the sign-in screens' title is that default), because its root layout declares the site
 *     before the document reads anything;
 *   · the main site's trees (the public one, the sign-in screens) declare no site and render exactly the
 *     main site's document, as the single root layout did;
 *   · the proxy routes a secondary site's sign-in screens to its tree, and leaves the main site's alone.
 *
 * lib/server-api is replaced by a two-site stand-in: which site a read answers for is whatever the
 * render declared through setRequestSite — the one fact these layouts are responsible for. Its own
 * site plumbing (the forwarded host, the site-qualified cache tags) is tested in lib/__tests__/multisite.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import type { Metadata } from "next";

const MAIN = "main.example.org";
const TWO = "two.example.org";

const net = vi.hoisted(() => ({
    declared: null as string | null,
    reads: [] as Array<string | null>,
    sites: {} as Record<string, { settings: Record<string, unknown>; fonts: Array<{ family: string; variant: string; url: string }> }>,
}));

vi.mock("@/lib/server-api", async (importOriginal) => {
    const real = await importOriginal<typeof import("@/lib/server-api")>();
    const site = () => net.sites[net.declared ?? MAIN];
    return {
        normalizeSiteHost: real.normalizeSiteHost,
        setRequestSite: (raw: unknown) => {
            const host = real.normalizeSiteHost(raw);
            if (host) net.declared = host;
            return host;
        },
        requestSiteHost: () => net.declared,
        getSettings: async () => { net.reads.push(net.declared); return site().settings; },
        getFonts: async () => { net.reads.push(net.declared); return site().fonts; },
    };
});
// next/font/google runs inside the Next compiler; the shared instance is stubbed to the fields used.
vi.mock("@/app/fonts", () => ({ inter: { variable: "font-inter-var", className: "font-inter" } }));
// useSearchParams needs a router; it sits behind a Suspense that renderToStaticMarkup cannot suspend.
vi.mock("@/components/AnalyticsTracker", () => ({ AnalyticsTracker: () => null }));
// The public chrome is async and data-heavy (tested on its own); here it only has to be where it goes.
vi.mock("@/app/(public)/_chrome/PublicLayout", () => ({
    default: ({ children }: { children: React.ReactNode }) => <main data-probe="public-chrome">{children}</main>,
}));

const { default: SiteRootLayout, generateMetadata: siteRootMetadata } = await import("@/app/wjs-site/[siteHost]/layout");
const { default: SitePublicLayout } = await import("@/app/wjs-site/[siteHost]/(public)/layout");
const { default: SiteLoginLayout } = await import("@/app/wjs-site/[siteHost]/login/layout");
const { default: PublicRootLayout, generateMetadata: publicRootMetadata } = await import("@/app/(public)/layout");
const { default: LoginLayout, generateMetadata: loginMetadata } = await import("@/app/login/layout");
const { default: RegisterLayout, generateMetadata: registerMetadata } = await import("@/app/register/layout");
const { proxy } = await import("@/proxy");

const params = (siteHost: string) => ({ params: Promise.resolve({ siteHost }) });
const htmlTag = (markup: string) => /^<html\b[^>]*>/.exec(markup)?.[0] ?? "";
const serverFonts = (markup: string) => /<style id="wjs-server-fonts">([\s\S]*?)<\/style>/.exec(markup)?.[1] ?? "";
const titleOf = (meta: Metadata) => meta.title as { default: string; template: string };

beforeEach(() => {
    net.declared = null;
    net.reads = [];
    net.sites = {
        [MAIN]: {
            settings: { blogname: "Main Site", WPLANG: "en_US", siteurl: `https://${MAIN}` },
            fonts: [{ family: "Inter Tight", variant: "400", url: "/uploads/fonts/inter-tight.woff2" }],
        },
        [TWO]: {
            settings: { blogname: "Sitio Dos", WPLANG: "ar_SA", siteurl: `https://${TWO}` },
            fonts: [{ family: "Lora", variant: "700", url: "/uploads/fonts/lora-700.woff2" }],
        },
    };
});

describe("a secondary site's root layout renders that site's document", () => {
    it("its <html lang dir> come from its own locale options", async () => {
        const html = renderToStaticMarkup(await SiteRootLayout({ ...params(TWO), children: null }));
        expect(htmlTag(html)).toContain('lang="ar-SA"');
        expect(htmlTag(html)).toContain('dir="rtl"');
    });

    it("its server-rendered @font-face rules are its own fonts, not the main site's", async () => {
        const css = serverFonts(renderToStaticMarkup(await SiteRootLayout({ ...params(TWO), children: null })));
        expect(css).toContain("Lora");
        expect(css).toContain("/uploads/fonts/lora-700.woff2");
        expect(css).not.toContain("Inter Tight");
    });

    it("declares the site before the document reads anything", async () => {
        await SiteRootLayout({ ...params(TWO), children: null });
        expect(net.reads.length).toBeGreaterThan(0);
        expect(net.reads.every((site) => site === TWO)).toBe(true);
    });

    it("its metadata is its own name, title template and canonical base", async () => {
        const meta = await siteRootMetadata(params(TWO));
        expect(titleOf(meta)).toEqual({ default: "Sitio Dos", template: "%s | Sitio Dos" });
        expect(String(meta.metadataBase)).toBe(`https://${TWO}/`);
    });

    it("its sign-in screens are titled with its name, inside its document", async () => {
        // A sign-in screen has no title of its own: the browser shows the root layout's default.
        const meta = await siteRootMetadata(params(TWO));
        expect(titleOf(meta).default).toBe("Sitio Dos");
        const html = renderToStaticMarkup(await SiteRootLayout({
            ...params(TWO),
            children: SiteLoginLayout({ children: <form data-probe="login" /> }),
        }));
        expect(htmlTag(html)).toContain('lang="ar-SA"');
        expect(html).toContain('data-probe="login"');
        // No public chrome around the sign-in screen — only the public pages get it.
        expect(html).not.toContain("public-chrome");
    });

    it("its public pages get the public chrome inside its document", async () => {
        const chrome = await SitePublicLayout({ ...params(TWO), children: <p>post</p> });
        const html = renderToStaticMarkup(await SiteRootLayout({ ...params(TWO), children: chrome }));
        expect(htmlTag(html)).toContain('lang="ar-SA"');
        expect(html).toContain('data-probe="public-chrome"');
    });

    it("a siteHost that is not a hostname is a 404, never the main site's document", async () => {
        await expect(SiteRootLayout({ ...params("../etc"), children: null })).rejects.toThrow();
        await expect(siteRootMetadata(params("a b"))).rejects.toThrow();
        expect(net.reads).toEqual([]);
    });
});

describe("the main site's document is unchanged", () => {
    it("its public tree renders the main site's lang and fonts, and declares no site", async () => {
        const html = renderToStaticMarkup(await PublicRootLayout({ children: <p>home</p> }));
        expect(htmlTag(html)).toContain('lang="en-US"');
        expect(htmlTag(html)).toContain('dir="ltr"');
        expect(serverFonts(html)).toContain("Inter Tight");
        expect(serverFonts(html)).not.toContain("Lora");
        expect(html).toContain('data-probe="public-chrome"');
        expect(net.declared).toBeNull();
        expect(net.reads.every((site) => site === null)).toBe(true);
    });

    it("its sign-in screens keep the main site's document and title", async () => {
        const html = renderToStaticMarkup(await LoginLayout({ children: <form /> }));
        expect(htmlTag(html)).toContain('lang="en-US"');
        expect(html).toContain('class="font-inter"');
        for (const meta of [await loginMetadata(), await registerMetadata(), await publicRootMetadata()]) {
            expect(titleOf(meta)).toEqual({ default: "Main Site", template: "%s | Main Site" });
        }
        expect(renderToStaticMarkup(await RegisterLayout({ children: null }))).toContain('lang="en-US"');
        expect(net.declared).toBeNull();
    });

    it("a secondary site rendered earlier in the process leaves nothing behind for it", async () => {
        await SiteRootLayout({ ...params(TWO), children: null });
        net.declared = null; // a new request: the holder is request-scoped
        const html = renderToStaticMarkup(await LoginLayout({ children: null }));
        expect(htmlTag(html)).toContain('lang="en-US"');
    });
});

describe("proxy: a secondary site's sign-in screens are its tree's", () => {
    const req = (path: string, headers: Record<string, string> = {}) =>
        new NextRequest(new URL(path, "http://example.com"), { headers });
    const routedTo = (res: Response) => res.headers.get("x-middleware-request-x-wordjs-site-route");

    it("routes /login, /register, /reset-password and /verify-email of another site", () => {
        for (const p of ["/login", "/register", "/reset-password", "/verify-email", "/login/"]) {
            expect(routedTo(proxy(req(p, { "x-wordjs-site-host": TWO }))), p).toBe(TWO);
        }
    });

    it("leaves the main site's sign-in screens alone", () => {
        for (const p of ["/login", "/register", "/reset-password", "/verify-email"]) {
            const res = proxy(req(p));
            expect(routedTo(res), p).toBeNull();
            expect(res.headers.get("x-middleware-next"), p).toBeTruthy();
        }
    });

    it("routes only those exact screens, not paths under them", () => {
        for (const p of ["/login/x", "/register/2", "/admin/login"]) {
            expect(routedTo(proxy(req(p, { "x-wordjs-site-host": TWO }))), p).toBeNull();
        }
    });
});
