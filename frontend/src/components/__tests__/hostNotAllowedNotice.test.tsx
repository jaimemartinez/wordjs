/**
 * The refused-address notice (SPEC §3): what a page on an address the site does not serve may show.
 *
 * The bar is the only UI such a page gets, and the page itself may be a phishing or DNS-rebinding page
 * the operator never declared. So the rule pinned here is structural: NO form, NO input, NO button —
 * one plain link to the CONFIGURED main address (never something derived from the request), and every
 * value rendered as text. The root layout is rendered for real to prove it hands the notice that
 * configured address, not the request's.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HostNotAllowedBar, type HostNoticeStrings } from "../HostNotAllowedNotice";
import { canonicalLink } from "@/lib/siteAddress";
import { translations } from "@/lib/i18n";

const strings: HostNoticeStrings = {
    title: "This site doesn't answer at {host}.",
    goTo: "Go to {canonical}",
    admins: "Administrators: run {command} on the server.",
};

const render = (host: string, configured: unknown, pathname = "/admin/posts") =>
    renderToStaticMarkup(
        <HostNotAllowedBar
            refusal={{ host, origin: `http://${host}`, link: canonicalLink(configured, { origin: `http://${host}`, pathname }) }}
            strings={strings}
        />,
    );

describe("HostNotAllowedBar", () => {
    it("has no form, no input and no button — only a link", () => {
        const html = render("evil.example:3000", "https://example.com");
        for (const tag of ["<form", "<input", "<button", "<textarea", "<select"]) expect(html).not.toContain(tag);
        expect(html.match(/<a\b/g)).toHaveLength(1);
        expect(html).toContain('role="alert"');
    });

    it("links to the configured main address with the current path", () => {
        const html = render("192.168.1.9:3000", "https://example.com/");
        expect(html).toContain('href="https://example.com/admin/posts"');
        expect(html).toContain('rel="nofollow"');
        expect(html).toContain("Go to https://example.com");
        expect(html).toContain("This site doesn&#x27;t answer at 192.168.1.9:3000.");
    });

    it("tells administrators the exact command for this address", () => {
        const html = render("blog.example.org", "https://example.com");
        expect(html).toContain("<code");
        expect(html).toContain("npm run site -- add http://blog.example.org");
        expect(html).toContain("Administrators: run ");
        expect(html).toContain(" on the server.");
    });

    it("offers no link at all when the configured value is unusable", () => {
        for (const configured of [null, "", "javascript:alert(1)", "https,https://example.com", "//evil.example"]) {
            const html = render("x.example", configured);
            expect(html, String(configured)).not.toContain("<a");
            expect(html).not.toContain("javascript:");
        }
    });

    it("renders hostile text as text", () => {
        const html = renderToStaticMarkup(
            <HostNotAllowedBar refusal={{ host: '"><img src=x onerror=alert(1)>', origin: "http://x", link: null }} strings={strings} />,
        );
        expect(html).not.toContain("<img");
        expect(html).toContain("&lt;img");
    });
});

describe("the notice's strings exist in every language, with their placeholders", () => {
    for (const lang of ["es", "en", "pt"] as const) {
        it(lang, () => {
            const t = translations[lang];
            expect(t["hostNotice.title"]).toContain("{host}");
            expect(t["hostNotice.goTo"]).toContain("{canonical}");
            expect(t["hostNotice.admins"]).toContain("{command}");
            expect(t["hostNotice.signinDisabled"]).toBeTruthy();
        });
    }
});

// ─── The root layout hands the notice the CONFIGURED address ────────────────────────────────────────

const site = vi.hoisted(() => ({ settings: null as Record<string, unknown> | null }));
vi.mock("@/lib/server-api", () => ({ getSettings: async () => site.settings, getFonts: async () => [] }));
vi.mock("@/app/fonts", () => ({ inter: { variable: "font-inter-var" } }));
vi.mock("@/components/AnalyticsTracker", () => ({ AnalyticsTracker: () => null }));
// Only the default export (the stateful wrapper) is replaced, by a probe that prints its props; the
// bar tested above stays the real one.
vi.mock("@/components/HostNotAllowedNotice", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/components/HostNotAllowedNotice")>()),
    default: ({ canonical, documentLang }: { canonical: string | null; documentLang: string | null }) => (
        <i data-probe="host-notice" data-canonical={canonical ?? "none"} data-lang={documentLang ?? "none"} />
    ),
}));

describe("RootLayout mounts the notice", () => {
    it("with the configured siteurl (falling back to home) and the document language", async () => {
        const { default: RootLayout } = await import("@/app/layout");
        site.settings = { siteurl: "https://example.com", home: "https://home.example.com", WPLANG: "pt_BR" };
        let html = renderToStaticMarkup(await RootLayout({ children: null }));
        expect(html).toContain('data-canonical="https://example.com"');
        expect(html).toContain('data-lang="pt-BR"');

        site.settings = { home: "https://home.example.com" };
        html = renderToStaticMarkup(await RootLayout({ children: null }));
        expect(html).toContain('data-canonical="https://home.example.com"');

        site.settings = null;
        html = renderToStaticMarkup(await RootLayout({ children: null }));
        expect(html).toContain('data-canonical="none"');
    });
});
