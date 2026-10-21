/**
 * Admin content table — TRASH: "Delete" must not be a silent one-way door.
 *
 * The regression this pins: the row's delete button called postsApi.delete() WITHOUT force, which the
 * backend turns into post_status='trash' — an archive, not a delete. But the table had no 'trash' tab
 * and no client ever queried that status, so the row simply vanished from every view the admin could
 * reach while the record sat intact in the database: the user confirmed "Delete" and got silent,
 * unrecoverable archiving.
 *
 * Asserted here (node environment, no jsdom — the project convention):
 *   • the Trash tab exists and filters by the REAL DB status, so the trashed row is reachable;
 *   • a 'trash' row paints a badge instead of falling back to the unknown-status neutral;
 *   • the WIRE contract of the three actions (soft delete / force delete / restore) — captured off
 *     `fetch`, so what the button sends is asserted, not what it meant to send;
 *   • the copy in all three catalogs, including that the two destructive buttons do NOT say the same
 *     thing (the point of the fix: the label has to match what the click does).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { STATUS_TABS, statusBadgeView } from "../ContentTable";
import { StatusBadge } from "@/components/ui";
import { postsApi } from "@/lib/api";
import { translations } from "@/lib/i18n";

const t = (k: string) => (translations.es as Record<string, string>)[k] || k;
const LOCALES = ["es", "en", "pt"] as const;

/** Record what api() actually puts on the wire (url + method) and answer with an empty 200 JSON. */
function captureRequests(): Array<{ url: string; method: string }> {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (url: any, init: any) => {
        calls.push({ url: String(url), method: String(init?.method || "GET") });
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("ContentTable — trash", () => {
    it("offers a Trash tab whose filter key is the real DB status ('trash')", () => {
        const tab = STATUS_TABS.find((x) => x.key === "trash");
        expect(tab).toBeTruthy();
        expect(t(tab!.labelKey)).toBe("Papelera");
        // The 'All' tab stays first — it is the privilege-scoped server-side 'any', which EXCLUDES
        // trash on purpose; the trashed rows are reachable only through this tab.
        expect(STATUS_TABS[0].key).toBe("any");
    });

    it("maps 'trash' to the deleted badge, RENDERED with the error palette (not the neutral fallback)", () => {
        expect(statusBadgeView("trash", t)).toEqual({ status: "deleted", label: "En la papelera" });
        const html = renderToStaticMarkup(<StatusBadge {...statusBadgeView("trash", t)} />);
        expect(html).toContain("En la papelera");
        expect(html).toContain("text-red-600"); // statusMap.deleted → error; neutral would mean unmapped
    });

    it("keeps the existing status mappings intact", () => {
        expect(statusBadgeView("publish", t)).toEqual({ status: "published", label: "Publicado" });
        expect(statusBadgeView("draft", t)).toEqual({ status: "draft", label: "Borrador" });
        expect(statusBadgeView("future", t)).toEqual({ status: "scheduled", label: "Programado" });
    });

    it("REGRESSION: the normal view's delete is a SOFT delete — no force flag", async () => {
        const calls = captureRequests();
        await postsApi.trash(7);
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe("DELETE");
        expect(calls[0].url).toMatch(/\/posts\/7$/);
    });

    it("the trash view's permanent action really forces the delete (?force=true)", async () => {
        const calls = captureRequests();
        await postsApi.deletePermanently(7);
        expect(calls[0].method).toBe("DELETE");
        expect(calls[0].url).toContain("/posts/7?force=true");
    });

    it("restore hits the dedicated endpoint (the backend re-reads _wp_trash_meta_status)", async () => {
        const calls = captureRequests();
        await postsApi.restore(7);
        expect(calls[0].method).toBe("POST");
        expect(calls[0].url).toContain("/posts/7/restore");
    });

    it("every locale carries the trash copy", () => {
        const keys = [
            "table.status.trash", "posts.trashed", "table.trash.empty",
            "table.trash.action", "table.trash.title", "table.trash.one", "table.trash.many", "table.trash.failed",
            "table.deleteForever.action", "table.deleteForever.title", "table.deleteForever.one", "table.deleteForever.many",
            "table.restore.action", "table.restore.failed",
        ];
        for (const locale of LOCALES) {
            const cat = translations[locale] as Record<string, string>;
            for (const key of keys) {
                expect(cat[key], `${locale} is missing ${key}`).toBeTruthy();
            }
            // Both bulk messages interpolate the count.
            expect(cat["table.trash.many"]).toContain("{n}");
            expect(cat["table.deleteForever.many"]).toContain("{n}");
        }
    });

    it("the two destructive buttons do not say the same thing (a label has to match its click)", () => {
        for (const locale of LOCALES) {
            const cat = translations[locale] as Record<string, string>;
            expect(cat["table.trash.action"]).not.toBe(cat["table.deleteForever.action"]);
            // Distinct confirmations too: one is reversible, the other is not.
            expect(cat["table.trash.one"]).not.toBe(cat["table.deleteForever.one"]);
            expect(cat["table.trash.many"]).not.toBe(cat["table.deleteForever.many"]);
        }
        expect(translations.en["table.trash.action"]).toBe("Move to trash");
        expect(translations.en["table.deleteForever.action"]).toBe("Delete permanently");
        // The reversible one says where the item goes; only the irreversible one warns.
        expect(translations.en["table.trash.one"]).toContain("Trash tab");
        expect(translations.en["table.deleteForever.one"]).toContain("cannot be undone");
    });
});
