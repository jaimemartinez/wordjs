/**
 * NO NATIVE DIALOGS, ANYWHERE A BROWSER RUNS OUR CODE.
 *
 * The browser's own alert(), confirm() and prompt() are never used: not in the core, the admin, the
 * themes, the portals or the plugins. They block the page, cannot be translated or styled, and some
 * embedders suppress them so the action silently never happens. Use useModal() (alert / confirm /
 * prompt) from @/contexts/ModalContext, or a toast.
 *
 * Scope-aware (helpers/nativeDialogScan.ts): a `confirm` destructured from useModal() is a local binding
 * and passes; a bare `confirm(…)` that resolves to the global, `window.confirm(…)` and its `globalThis` /
 * `self` / `top` / `parent` spellings, inline `onclick="return confirm(…)"` handlers and `<script>` bodies
 * in .html files do not. An `eslint-disable` comment does not hide a call. frontend/eslint.config.mjs
 * enforces the same rule while editing the frontend.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { scanRepository, scanText, countByFile } from "./helpers/nativeDialogScan";

/**
 * Plugin files that still call a native dialog on the day this gate landed. Each plugin is being moved to
 * useModal() in its own PR, and that PR REMOVES its entries here (or lowers the count, file by file). This
 * list only shrinks: the test fails on a file not listed, on a count above the one listed, and on a count
 * BELOW it (a fixed call must also be taken off the list, so it cannot quietly come back).
 */
const PENDING_PLUGIN_FILES: Record<string, number> = {
    "marketplace/plugins/auctions/client/admin/page.tsx": 4,
    "marketplace/plugins/bookings/client/admin/page.tsx": 2,
    "marketplace/plugins/conference-manager/client/admin/BadgeEditor.tsx": 1,
    "marketplace/plugins/contact-forms/client/admin/page.tsx": 2,
    "marketplace/plugins/digital-downloads/client/admin/page.tsx": 2,
    "marketplace/plugins/donations/client/admin/page.tsx": 2,
    "marketplace/plugins/event-tickets/client/admin/page.tsx": 4,
    "marketplace/plugins/events-calendar/client/admin/page.tsx": 1,
    "marketplace/plugins/faq/client/admin/page.tsx": 1,
    "marketplace/plugins/invoices/client/admin/page.tsx": 2,
    "marketplace/plugins/job-board/client/admin/page.tsx": 2,
    "marketplace/plugins/mail-server/client/admin/Composer.tsx": 1,
    "marketplace/plugins/memberships/client/admin/page.tsx": 2,
    "marketplace/plugins/newsletter/client/admin/page.tsx": 4,
    "marketplace/plugins/online-store/client/admin/page.tsx": 4,
    "marketplace/plugins/polls/client/admin/page.tsx": 1,
    "marketplace/plugins/popup-builder/client/admin/page.tsx": 1,
    "marketplace/plugins/restaurant-menu/client/admin/page.tsx": 3,
    "marketplace/plugins/restaurant-menu/client/admin/v2tabs.tsx": 6,
    "marketplace/plugins/testimonials/client/admin/page.tsx": 1,
    "marketplace/plugins/vendor-marketplace/client/admin/page.tsx": 4,
    "marketplace/plugins/vendor-marketplace/client/verso/VendorMarketplaceVerso.tsx": 1,
};

describe("the scanner (its own controls)", () => {
    const calls = (code: string, file = "x.tsx") => scanText(code, file).length;

    it("finds every spelling of the browser's dialogs", () => {
        expect(calls("if (!window.confirm('Delete?')) return;")).toBe(1);
        expect(calls("alert('saved');", "x.js")).toBe(1);
        expect(calls("const v = prompt('Name?');", "x.ts")).toBe(1);
        expect(calls("globalThis.alert('x'); self.confirm('y'); top.prompt('z'); parent.alert('w');", "x.js")).toBe(4);
        expect(calls("const ask = window.confirm; ask('x');", "x.js")).toBe(1);
        expect(calls("window['confirm']('x');", "x.js")).toBe(1);
        expect(calls("confirm\n  ('x');", "x.js")).toBe(1);
        expect(calls("// eslint-disable-next-line no-alert\nconfirm('x');", "x.js")).toBe(1);
        expect(calls('<button onclick="return confirm(\'Sure?\')">x</button>', "x.html")).toBe(1);
        expect(calls("<p>x</p><script>if (confirm('y')) go();</script>", "x.html")).toBe(1);
        // Markup a server writes as a string: the parser sees a string, the handler check sees the call.
        expect(calls("res.send(`<a onclick=\"return window.confirm('Sure?')\">x</a>`);", "x.ts")).toBe(1);
    });

    it("lets the host's dialogs and look-alikes through", () => {
        expect(calls("const { confirm, alert, prompt } = useModal(); if (!(await confirm('x'))) return; await alert('y'); await prompt('z');")).toBe(0);
        expect(calls("function f(confirm) { return confirm('x'); }", "x.js")).toBe(0);
        expect(calls("modal.confirm('x'); this.alert('y'); api.prompt('z');", "x.js")).toBe(0);
        expect(calls("const confirmDelete = () => 1; confirmed(); alerting();", "x.js")).toBe(0);
        expect(calls("const label = 'confirm(x)';", "x.js")).toBe(0);
    });

    it("an unparsable file is a finding, not a pass", () => {
        expect(scanText("const = ; confirm(1)", "x.js")[0]?.what).toMatch(/^unparsed:/);
    });
});

describe("the repository", () => {
    let counts: Record<string, number> = {};
    // A few thousand files through the parser: seconds, not the default 5 s budget of one test.
    beforeAll(() => { counts = countByFile(scanRepository()); }, 120_000);

    it("the core (frontend, backend assets and themes, gateway) has none", () => {
        const core = Object.keys(counts).filter((f) => !f.startsWith("marketplace/"));
        expect(core).toEqual([]);
    });

    it("a plugin has none, unless it is on the pending list with exactly that many", () => {
        const unexpected = Object.entries(counts)
            .filter(([file, n]) => file.startsWith("marketplace/") && n > (PENDING_PLUGIN_FILES[file] ?? 0))
            .map(([file, n]) => `${file}: ${n} (allowed ${PENDING_PLUGIN_FILES[file] ?? 0})`);
        expect(unexpected, "a native dialog was added: use useModal() or a toast").toEqual([]);
    });

    it("the pending list only shrinks: a file fixed (even in part) must be lowered or removed here", () => {
        const stale = Object.entries(PENDING_PLUGIN_FILES)
            .filter(([file, n]) => (counts[file] ?? 0) < n)
            .map(([file, n]) => `${file}: listed ${n}, found ${counts[file] ?? 0}`);
        expect(stale).toEqual([]);
    });
});
