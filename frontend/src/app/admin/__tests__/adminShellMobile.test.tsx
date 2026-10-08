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
        user: { id: 1, username: "admin", roles: ["administrator"], capabilities: [], mfa: null },
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
        expect(header).toContain("pt-[max(1rem,env(safe-area-inset-top))]");
    });

    it("moves the desktop collapse toggle with the safe-area padding so it still straddles the sidebar edge", async () => {
        const toggle = classesOf(await renderShell(), /<button[^>]*title="Collapse Sidebar"[^>]*>/);
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
