/**
 * The admin shell on a phone (iOS Safari / Brave on an iPhone).
 *
 * What a user saw: dragging anywhere in the admin moved the WHOLE page — the header slid down and
 * bounced back — and full-screen plugin UI (the conference-manager meal scanner) could not keep its
 * controls clear of the home indicator. Three causes, each pinned here:
 *   1. the shell was `h-screen` (100vh), which iOS resolves to the LARGE viewport, so the document came
 *      out taller than the screen and scrolled/rubber-banded as a whole → `h-dvh` (shell and sidebar);
 *   2. nothing stopped a scroller's overscroll from chaining to the document → `overscroll-behavior-y:
 *      none` on html/body (admin-globals.css) and on the generated plugin wrapper (its own test);
 *   3. without `viewport-fit=cover` every env(safe-area-inset-*) is 0 → the admin layout exports it, and
 *      the shell pads itself by the insets so ordinary screens stay where they were.
 * The header's `sticky` never stuck (its scroller is an overflow-hidden column); it is `relative` now,
 * which keeps the same stacking (positioned, z-5000) without pretending to pin anything.
 */
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/fonts", () => ({ inter: { className: "font-inter", variable: "font-inter-var" } }));
vi.mock("@/lib/server-api", () => ({ getSettings: async () => null, getFonts: async () => [] }));
vi.mock("@/lib/plugins", () => ({ initPlugins: () => undefined }));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, replace: () => undefined }),
    usePathname: () => "/admin/plugin/conference",
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/contexts/AuthContext", () => ({
    AuthProvider: ({ children }: { children: React.ReactNode }) => children,
    useAuth: () => ({
        // `role`, as AuthContext's user carries it: the layout's route guard (lib/adminAccess.ts) only lets
        // an administrator (or a holder of the page's capability) see a page — and the shell around it.
        user: { id: 1, username: "admin", role: "administrator", roles: ["administrator"], capabilities: [], mfa: null },
        isLoading: false,
        logout: () => undefined,
        refreshUser: async () => undefined,
        can: () => true,
    }),
}));
vi.mock("@/contexts/MenuContext", () => ({
    MenuProvider: ({ children }: { children: React.ReactNode }) => children,
    useMenu: () => ({ pluginMenus: [], refreshMenus: () => undefined }),
}));
vi.mock("@/contexts/I18nContext", () => ({
    I18nProvider: ({ children }: { children: React.ReactNode }) => children,
    useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: () => undefined }),
}));
vi.mock("@/components/NotificationCenter", () => ({ default: () => null }));

const ADMIN_DIR = path.resolve(__dirname, "..");

/** The class list of the first element in `html` that carries `marker` (an attribute or a tag name). */
function classesOf(html: string, marker: RegExp): string[] {
    const tag = html.match(marker);
    expect(tag, `no element matching ${marker} in the rendered shell`).not.toBeNull();
    const cls = /class="([^"]*)"/.exec(tag![0]);
    return cls ? cls[1].split(/\s+/).filter(Boolean) : [];
}

async function renderShell(): Promise<string> {
    const { default: DashboardLayoutClient } = await import("@/app/admin/DashboardLayoutClient");
    return renderToStaticMarkup(<DashboardLayoutClient><p>page</p></DashboardLayoutClient>);
}

describe("admin shell sizing on mobile", () => {
    it("is exactly the dynamic viewport (h-dvh), never 100vh, and pads itself by the horizontal safe area", async () => {
        const shell = classesOf(await renderShell(), /<div[^>]*data-wjs-admin-shell[^>]*>/);
        expect(shell).toContain("h-dvh");
        expect(shell).not.toContain("h-screen");
        expect(shell).toContain("overflow-hidden");
        expect(shell).toContain("pl-[env(safe-area-inset-left)]");
        expect(shell).toContain("pr-[env(safe-area-inset-right)]");
    });

    it("sizes the sidebar to the dynamic viewport too (its bottom items sat under Safari's toolbar)", async () => {
        const aside = classesOf(await renderShell(), /<aside[^>]*>/);
        expect(aside).toContain("h-dvh");
        expect(aside).not.toContain("h-screen");
    });

    it("keeps the mobile header positioned above the page without the sticky that never stuck, clear of the status bar", async () => {
        const header = classesOf(await renderShell(), /<header[^>]*>/);
        expect(header).not.toContain("sticky");
        expect(header).toContain("relative");
        expect(header).toContain("z-[5000]");
        expect(header).toContain("pt-[max(0.5rem,env(safe-area-inset-top))]");
    });

    it("moves the desktop collapse toggle with the safe-area padding so it still straddles the sidebar edge", async () => {
        const toggle = classesOf(await renderShell(), /<button[^>]*title="nav.collapseSidebar"[^>]*>/);
        expect(toggle).toContain("left-[calc(304px+env(safe-area-inset-left))]");
    });
});

describe("the fullscreen editor under viewport-fit=cover", () => {
    // The editor routes bypass the shell (DashboardLayoutClient renders them bare), so the shell's padding
    // does not reach them: the workspace root has to keep itself out of the notch on its own. Read from
    // the source because the editor needs a whole document store to render; the assertion is on the one
    // element that is the fixed workspace.
    it("pads the fixed workspace root by the horizontal safe area", () => {
        const src = fs.readFileSync(path.resolve(ADMIN_DIR, "../../components/verso/editor/VersoEditor.tsx"), "utf8");
        const root = /className="(verso-container fixed inset-0[^"]*)"/.exec(src);
        expect(root, "VersoEditor no longer renders a `verso-container fixed inset-0` root").not.toBeNull();
        const classes = root![1].split(/\s+/);
        expect(classes).toContain("pl-[env(safe-area-inset-left)]");
        expect(classes).toContain("pr-[env(safe-area-inset-right)]");
    });
});

describe("fixed admin UI outside the shell under viewport-fit=cover", () => {
    // Fixed elements are placed against the viewport, not the padded shell: the toast stack keeps itself
    // clear of the home indicator and, in landscape, of the notch (env() is 0 where nothing is covered).
    it("keeps the toast stack 1rem from the edges or clear of the safe area, whichever is larger", async () => {
        const { ToastProvider } = await import("@/contexts/ToastContext");
        const stack = classesOf(renderToStaticMarkup(<ToastProvider><p>page</p></ToastProvider>), /<div[^>]*data-wjs-toasts[^>]*>/);
        expect(stack).toContain("fixed");
        expect(stack).toContain("bottom-[max(1rem,env(safe-area-inset-bottom))]");
        expect(stack).toContain("left-[max(1rem,env(safe-area-inset-left))]");
        expect(stack).toContain("right-[max(1rem,env(safe-area-inset-right))]");
        expect(stack).toContain("sm:left-auto");
        expect(stack).not.toContain("bottom-4");
    });
});

describe("admin document and viewport", () => {
    it("exports viewport-fit=cover from the admin layout, so env(safe-area-inset-*) is not 0 on iOS", async () => {
        const { viewport } = await import("@/app/admin/layout");
        expect(viewport).toEqual({ viewportFit: "cover" });
    });

    it("stops the admin document from rubber-banding vertically (and only vertically)", () => {
        const css = fs.readFileSync(path.join(ADMIN_DIR, "admin-globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        const rule = /html\s*,\s*body\s*\{([^}]*)\}/.exec(css);
        expect(rule, "admin-globals.css has no `html, body { … }` rule").not.toBeNull();
        expect(rule![1]).toMatch(/overscroll-behavior-y\s*:\s*none\s*;?/);
        // Never the x axis on the root: that switches off the desktop two-finger back/forward swipe.
        expect(css).not.toMatch(/overscroll-behavior(-x)?\s*:\s*none/);
    });
});

describe("the shell's edges on a phone (live review, iPhone SE / 13)", () => {
    it("the CLOSED phone menu casts no shadow (its shadow-2xl bled a grey band onto the page's left edge)", async () => {
        const aside = classesOf(await renderShell(), /<aside[^>]*>/);
        expect(aside).toContain("-translate-x-full");      // rendered closed
        expect(aside).toContain("shadow-none");
        expect(aside).not.toContain("shadow-2xl");
        expect(aside).toContain("lg:shadow-2xl");           // the desktop sidebar keeps it
        const src = fs.readFileSync(path.resolve(ADMIN_DIR, "../../components/Sidebar.tsx"), "utf8");
        expect(src).toContain('${isOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full shadow-none max-lg:invisible"}');
    });

    it("the logo keeps its square beside a long site name, and its glow is not clipped", async () => {
        const html = await renderShell();
        expect(classesOf(html, /<div[^>]*data-sidebar-logo[^>]*>/)).toContain("shrink-0");
        expect(classesOf(html, /<a[^>]*data-sidebar-home[^>]*>/)).not.toContain("overflow-hidden");
    });

    it("the phone header's rule is light grey, not Tailwind v4's currentColor default (a black line)", async () => {
        const header = classesOf(await renderShell(), /<header[^>]*>/);
        expect(header).toContain("border-b");
        expect(header).toContain("border-gray-100");
    });
});

/**
 * Plugins › Marketplace on a phone: the catalog source line printed the whole catalog URL in a mono span
 * inside an inline-block, with nothing allowed to wrap it, so the page grew a sideways scroll. Long URLs
 * wrap now, and the flex rows that hold a URL (the sources list, the add-a-source field) can shrink.
 */
describe("Plugins › Marketplace fits a phone", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../plugins/MarketplaceTab.tsx"), "utf8");

    it("the catalog source line wraps its URL and never outgrows the page", () => {
        expect(src).toMatch(/rounded-xl inline-block max-w-full break-words[^"]*">\s*\{sourcesStatus\.length/);
        expect(src).toMatch(/<span className="font-mono[^"]*break-all">\{isLocal/);
    });

    it("the rows that hold a source URL can shrink below the URL's width", () => {
        expect(src).toMatch(/<span className="flex-1 min-w-0 font-mono[^"]*truncate" title=\{u\}>/);
        expect(src).toMatch(/containerClassName="flex-1 min-w-0"\s*className="font-mono"/);
    });
});

/**
 * Typing on a phone zoomed the whole page: iOS zooms on focus when a field's text is under 16px, and
 * core and plugin fields are 14px (`text-sm`). globals.css (loaded by every tree through RootDocument)
 * lifts text fields, selects and textareas to 16px below md — unlayered, so it beats Tailwind's layered
 * utilities and plugin classes — and never locks pinch zoom.
 */
describe("Phones: focusing a field never zooms the page", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../../globals.css"), "utf8");
    const rule = css.match(/@media \(max-width: 767\.98px\) \{\s*:where\(input:not\(([^)]*)\), select, textarea\):not\(([^)]*)\) \{\s*font-size: 16px;/);

    it("text fields, selects and textareas are 16px below md, outside any @layer", () => {
        expect(rule, "the 16px phone rule").not.toBeNull();
        const before = css.slice(0, css.indexOf(rule![0]));
        const depth = before.replace(/\/\*[\s\S]*?\*\//g, "").split("").reduce((d, ch) => d + (ch === "{" ? 1 : ch === "}" ? -1 : 0), 0);
        expect(depth, "the @media block must be top-level, not nested in an @layer").toBe(0);
        expect(rule![1]).toContain('[type="checkbox"]');
        expect(rule![1]).toContain('[type="radio"]');
    });

    it("deliberately large fields keep their size", () => {
        expect(rule![2]).toContain(".text-lg");
        expect(rule![2]).toContain(".text-3xl");
    });

    it("pinch zoom is never locked", () => {
        const layout = fs.readFileSync(path.resolve(__dirname, "../layout.tsx"), "utf8");
        const root = fs.readFileSync(path.resolve(__dirname, "../../_root/RootDocument.tsx"), "utf8");
        for (const src of [layout, root, css]) {
            expect(src).not.toMatch(/maximum-scale\s*[:=]\s*["']?1|userScalable\s*:\s*false|user-scalable\s*=\s*no/);
        }
    });
});

/**
 * Admin › Auditoría on a phone: the table stacks into cards below lg, but the «Objetivo» cell kept
 * `whitespace-nowrap` at every size, so a long target (a URL, an email, an id) stretched the page sideways.
 * It wraps below lg now (no-wrap only in the desktop table), and a raw actor id can break anywhere.
 */
describe("Admin › Auditoría fits a phone", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../audit/page.tsx"), "utf8");

    it("the target cell only refuses to wrap in the desktop table", () => {
        const target = src.match(/<span className="inline-flex items-center gap-2[^"]*">\s*<i className=\{`fa-solid \$\{auditTargetIcon/);
        expect(target, "the target cell").not.toBeNull();
        expect(target![0]).toContain("lg:whitespace-nowrap");
        expect(target![0]).not.toMatch(/(^|[\s"])whitespace-nowrap/);
        expect(target![0]).toContain("break-all");
        expect(target![0]).toContain("max-w-full");
    });

    it("a raw (unnamed) actor id can break anywhere", () => {
        expect(src).toMatch(/"text-gray-500 font-mono break-all"/);
    });
});

/**
 * Cards never outgrow the screen: below `stackBelow` a DataTable row is a card in a grid. The grid had no
 * explicit column, so its implicit track sized to the longest unbreakable word in any card — a long URL
 * in an audit entry made every card ~490px at a 375px viewport and the table scrolled sideways inside its
 * card. The grid now has one minmax(0,1fr) column, a card may shrink (min-w-0), and card cells wrap
 * anywhere. The audit action chip, which kept its own `break-words`, wraps anywhere too.
 */
describe("DataTable cards fit a phone even with a long URL", () => {
    const dt = fs.readFileSync(path.resolve(__dirname, "../../../components/ui/DataTable.tsx"), "utf8");
    const audit = fs.readFileSync(path.resolve(__dirname, "../audit/page.tsx"), "utf8");

    it("the card grid has an explicit shrinkable column and cards may shrink", () => {
        expect(dt).toMatch(/tbody: "in-data-\[dt=cards\]:grid in-data-\[dt=cards\]:grid-cols-1 /);
        expect(dt).toMatch(/tr: "in-data-\[dt=cards\]:flex in-data-\[dt=cards\]:min-w-0 /);
    });

    it("card cells break a long word anywhere (desktop table unchanged)", () => {
        expect(dt).toContain('<div className="min-w-0 break-words in-data-[dt=cards]:wrap-anywhere">{c.cell(row)}</div>');
    });

    it("the audit action chip can wrap inside its card", () => {
        expect(audit).toMatch(/inline-block max-w-full text-\[11px\][^"`]*wrap-anywhere/);
        expect(audit).not.toMatch(/inline-block text-\[11px\] font-black uppercase tracking-wider px-2 py-1 rounded-md break-words/);
    });

    it("Auditoría offers the retention windows the backend accepts, through its own API", () => {
        // The window moved to AuditSettingsPanel (PUT /audit/settings, which re-authenticates a shorter one).
        const panel = fs.readFileSync(path.resolve(__dirname, "../audit/AuditSettingsPanel.tsx"), "utf8");
        for (const v of ['"90"', '"180"', '"365"', '"730"', '"0"']) expect(panel).toContain(`value: ${v}`);
        expect(panel).toContain("auditApi.saveSettings({ retentionDays: Number(value)");
        expect(audit).toContain("<AuditSettingsPanel />");
        expect(audit).not.toContain("audit_retention_days");
    });
});

/**
 * The owner's iPhone after 2.11.6: the audit cards still scrolled sideways, this time through the detail
 * summary («source: https://github.com/…»). Each pair is a `break-words` span, and overflow-wrap:
 * break-word does not shrink min-content, so one URL pill widened the card. Inside a card, `break-words`
 * now means `anywhere` (globals.css, unlayered), and the audit summary pills may shrink.
 */
describe("A long URL in a card summary never widens the card", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../../globals.css"), "utf8");
    const audit = fs.readFileSync(path.resolve(__dirname, "../audit/page.tsx"), "utf8");

    it("inside DataTable cards, break-words breaks anywhere, outside any @layer", () => {
        const rule = css.match(/\[data-dt="cards"\] \.break-words \{\s*overflow-wrap: anywhere;\s*\}/);
        expect(rule, "the card break-words rule").not.toBeNull();
        const before = css.slice(0, css.indexOf(rule![0])).replace(/\/\*[\s\S]*?\*\//g, "");
        const depth = before.split("").reduce((d, ch) => d + (ch === "{" ? 1 : ch === "}" ? -1 : 0), 0);
        expect(depth).toBe(0);
    });

    it("the audit detail summary pills may shrink", () => {
        expect(audit).toContain('<span key={pair.key} className="min-w-0 max-w-full break-words">');
    });
});
