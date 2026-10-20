import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * CORE DIALOGS STACK ABOVE THE ADMIN SHELL (components/DialogLayer.tsx, lib/adminLayers.ts).
 *
 * Live findings: on a phone the core «Nuevo usuario» dialog opened UNDER the admin's header bar (z-5000),
 * its top edge and close button cut off; on a desktop the sidebar's collapse toggle (z-5003) was drawn
 * over the dialog's corner and the backdrop did not dim the sidebar (z-5002). Every core dialog was a
 * `fixed inset-0 z-50` (or z-[100]) div inside the page. The shared confirm/alert dialog (useModal) sat at
 * z-50 under any plugin overlay as well.
 *
 * No DOM test environment in this project: the static markup answers "which layer, at which z-index",
 * and a stubbed createPortal answers "portalled to <body>".
 */

const portal = vi.hoisted(() => ({ targets: [] as unknown[] }));
vi.mock("react-dom", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-dom")>();
    return {
        ...actual,
        createPortal: (node: React.ReactNode, target: unknown) => {
            portal.targets.push(target);
            return React.createElement("wjs-test-portal", null, node);
        },
    };
});
vi.mock("@/contexts/I18nContext", () => ({ useI18n: () => ({ t: (k: string) => k, language: "es", setLanguage: () => undefined }) }));
vi.mock("@/lib/api", () => ({ usersApi: {}, rolesApi: { list: async () => ({}) } }));

import DialogLayer, { DialogDirectionContext } from "../DialogLayer";
import ConfirmationModal from "../ConfirmationModal";
import SecretRevealModal from "../SecretRevealModal";
import { ADMIN_Z } from "@/lib/adminLayers";
import { ModalProvider } from "@/contexts/ModalContext";
import UserFormModal from "@/app/admin/users/UserFormModal";

const SRC = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
const zOf = (html: string) => Number(/z-index:(\d+)/.exec(html)?.[1]);

afterEach(() => {
    portal.targets.length = 0;
    delete (globalThis as any).document;
});

describe("the admin's stacking order", () => {
    it("shell < dialog < plugin overlays < dialogOver < popover < toast — and the shell's own classes agree", () => {
        expect(ADMIN_Z.mobileHeader).toBeLessThan(ADMIN_Z.dialog);
        expect(ADMIN_Z.sidebarToggle).toBeLessThan(ADMIN_Z.dialog);
        expect(ADMIN_Z.dialog).toBeLessThan(6010); // conference-manager's overlays (client/lib/overlay.ts) start at 6010
        expect(6090).toBeLessThan(ADMIN_Z.dialogOver); // … and end at 6090
        expect(ADMIN_Z.dialogOver).toBeLessThan(ADMIN_Z.popover);
        expect(ADMIN_Z.popover).toBeLessThan(ADMIN_Z.toast);
        // The numbers the shell actually uses (Tailwind classes) must be the ones this scale assumes.
        const shell = read("app/admin/DashboardLayoutClient.tsx");
        const sidebar = read("components/Sidebar.tsx");
        expect(shell).toMatch(/<header className="lg:hidden[^"]*\bz-\[5000\]/);
        expect(shell).toMatch(/hidden lg:flex absolute top-10 z-\[5003\]/);
        expect(sidebar).toMatch(/fixed inset-y-0 left-0 z-\[5002\]/);
        expect(sidebar).toMatch(/backdrop-blur-sm z-\[5001\] lg:hidden/);
        expect(read("contexts/ToastContext.tsx")).toMatch(/data-wjs-toasts=""[^>]*\bz-\[9999\]/);
        const overlay = fs.readFileSync(path.resolve(SRC, "../../marketplace/plugins/conference-manager/client/lib/overlay.ts"), "utf8");
        expect(overlay).toMatch(/OVERLAY_BASE_Z = 6000;/);
    });
});

describe("DialogLayer", () => {
    it("is fixed over the whole viewport at the dialog layer, above the shell", () => {
        const html = renderToStaticMarkup(<DialogLayer className="bg-black/60">x</DialogLayer>);
        expect(html).toContain('data-wjs-dialog-layer="dialog"');
        expect(html).toMatch(/position:fixed;top:0;right:0;bottom:0;left:0;z-index:6000/);
        expect(html).toContain('class="bg-black/60"');
    });

    it("a caller's style cannot pull it back under the shell", () => {
        const html = renderToStaticMarkup(<DialogLayer style={{ zIndex: 50, position: "absolute" }} />);
        expect(zOf(html)).toBe(ADMIN_Z.dialog);
        expect(html).toContain("position:fixed");
    });

    it("dialogOver sits above a dialog and above the plugin overlays", () => {
        expect(zOf(renderToStaticMarkup(<DialogLayer layer="dialogOver" />))).toBe(ADMIN_Z.dialogOver);
    });

    it("is portalled to <body> in a browser, so no page ancestor's stacking context can trap it", () => {
        const body = { tag: "body" };
        (globalThis as any).document = { body };
        const html = renderToStaticMarkup(<DialogLayer>inside</DialogLayer>);
        expect(portal.targets).toEqual([body]);
        expect(html).toContain("<wjs-test-portal>");
    });

    it("keeps the admin's writing direction once out of its `dir` wrapper", () => {
        const html = renderToStaticMarkup(
            <DialogDirectionContext.Provider value="ltr"><DialogLayer /></DialogDirectionContext.Provider>,
        );
        expect(html).toContain('dir="ltr"');
        expect(renderToStaticMarkup(<DialogLayer />)).not.toContain("dir=");
    });
});

describe("the core dialogs render in it", () => {
    it("ConfirmationModal (useModal confirm/alert, unsaved-changes, media, menus) — over other dialogs", () => {
        const html = renderToStaticMarkup(
            <ConfirmationModal isOpen onClose={() => undefined} onConfirm={() => undefined} title="T" message="M" />,
        );
        expect(html).toContain('data-wjs-dialog-layer="dialogOver"');
        expect(zOf(html)).toBe(ADMIN_Z.dialogOver);
        expect(html).not.toMatch(/\bz-50\b/);
    });

    it("SecretRevealModal — over the dialog that created the secret", () => {
        const html = renderToStaticMarkup(<SecretRevealModal secret="s3cr3t" title="T" onClose={() => undefined} />);
        expect(zOf(html)).toBe(ADMIN_Z.dialogOver);
    });

    it("UserFormModal («Nuevo usuario») — above the header and sidebar, its card capped by the VISIBLE height", () => {
        const html = renderToStaticMarkup(
            <ModalProvider><UserFormModal user="new" onClose={() => undefined} onSuccess={() => undefined} /></ModalProvider>,
        );
        expect(html).toContain('data-wjs-dialog-layer="dialog"');
        expect(zOf(html)).toBe(ADMIN_Z.dialog);
        expect(html).toContain("max-h-[90dvh]");
        expect(html).not.toContain("max-h-[90vh]");
    });
});

/**
 * Every core admin dialog goes through DialogLayer. A new `fixed inset-0` overlay in the admin is a dialog
 * under the shell again; the few that are not dialogs are listed with the reason.
 */
describe("no core admin overlay is left under the shell", () => {
    const ALLOWED: Record<string, string> = {
        // Decorative animated background of the plugins screen (z-0, pointer-events-none).
        "app/admin/plugins/page.tsx": "fixed inset-0 overflow-hidden z-0 pointer-events-none",
        // The Verso editor test bench: a full-screen route that bypasses the admin shell.
        "app/admin/verso-lab/page.tsx": "fixed inset-0 z-[100] flex",
        // The shell itself: the phone menu's backdrop, and the language menu's click-catcher inside the sidebar.
        "components/Sidebar.tsx": "z-[5001]|fixed inset-0 z-10",
        // The notification panel's backdrop sits above dialogs on purpose (z-9998).
        "components/NotificationCenter.tsx": "z-[9998]",
    };

    function walk(dir: string, out: string[] = []): string[] {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === "__tests__" || entry.name === "plugin") continue;
                walk(full, out);
            } else if (entry.name.endsWith(".tsx")) out.push(full);
        }
        return out;
    }

    it("scans app/admin, the shared components and contexts", () => {
        const files = [
            ...walk(path.join(SRC, "app/admin")),
            ...fs.readdirSync(path.join(SRC, "components")).filter((f) => f.endsWith(".tsx")).map((f) => path.join(SRC, "components", f)),
            ...walk(path.join(SRC, "components/ui")),
            ...walk(path.join(SRC, "contexts")),
        ];
        const offenders: string[] = [];
        for (const file of files) {
            const rel = path.relative(SRC, file).split(path.sep).join("/");
            if (rel === "components/DialogLayer.tsx") continue;
            const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
            lines.forEach((line, i) => {
                if (!/className=/.test(line) || !/\bfixed\b/.test(line) || !/\binset-0\b/.test(line)) return;
                const allowed = ALLOWED[rel];
                if (allowed && allowed.split("|").some((frag) => line.includes(frag))) return;
                offenders.push(`${rel}:${i + 1}`);
            });
        }
        expect(offenders).toEqual([]);
    });

    it("every dialog moved onto DialogLayer still uses it", () => {
        const moved: Record<string, number> = {
            "components/ConfirmationModal.tsx": 1,
            "components/SecretRevealModal.tsx": 1,
            "components/MediaPickerModal.tsx": 1,
            "app/admin/users/UserFormModal.tsx": 1,
            "app/admin/plugins/page.tsx": 7,
            "app/admin/plugins/MarketplaceTab.tsx": 1,
            "app/admin/db-migration/page.tsx": 3,
            "app/admin/media/page.tsx": 1,
            "app/admin/settings/site-address/page.tsx": 1,
        };
        for (const [rel, n] of Object.entries(moved)) {
            expect(read(rel).match(/<DialogLayer\b/g)?.length ?? 0, rel).toBe(n);
        }
    });
});
