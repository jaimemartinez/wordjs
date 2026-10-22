/**
 * The admin's own calendar (components/ui/DatePicker): the trigger, the month grid's ARIA, and that the
 * core admin no longer draws the browser's native date pickers.
 */
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { t, type Language } from "@/lib/i18n";
import { monthGrid, weekdayNames } from "@/lib/datePicker";

vi.mock("@/lib/api", () => ({ settingsApi: { get: () => new Promise(() => undefined) } }));
const { CalendarGrid, DatePicker, DateTimePicker } = await import("../DatePicker");
const { I18nProvider } = await import("@/contexts/I18nContext");

const SRC = resolve(__dirname, "../../..");
const tr = (lang: Language) => (k: string) => t(k, lang);

const grid = (lang: Language, weekStart: number, extra: Partial<React.ComponentProps<typeof CalendarGrid>> = {}) =>
    renderToStaticMarkup(
        <CalendarGrid
            titleId="ttl"
            weeks={monthGrid(2026, 10, weekStart)}
            headers={weekdayNames(lang, weekStart)}
            selected={{ y: 2026, m: 10, d: 22 }}
            focusDay={{ y: 2026, m: 10, d: 22 }}
            todayValue="2026-10-20"
            lang={lang}
            t={tr(lang)}
            {...extra}
        />,
    );

describe("the month grid (WAI-ARIA date picker dialog)", () => {
    it("a grid of 42 days, one tab stop, the selected day and today marked", () => {
        const html = grid("en", 1);
        expect(html).toContain('role="grid"');
        expect(html).toContain('aria-labelledby="ttl"');
        expect(html.match(/role="gridcell"/g)).toHaveLength(42);
        expect(html.match(/tabindex="0"/g)).toHaveLength(1);
        expect(html).toMatch(/data-dp-day="2026-10-22" tabindex="0"/);
        expect(html).toMatch(/aria-selected="true"[^>]*><button[^>]*data-dp-day="2026-10-22"/);
        expect(html).toMatch(/data-dp-day="2026-10-20"[^>]*aria-current="date"/);
    });

    it("weekday headers follow the site's first day of the week and the admin language", () => {
        expect(grid("en", 0)).toMatch(/<th[^>]*abbr="Sunday"[\s\S]*abbr="Monday"/);
        expect(grid("en", 1)).toMatch(/<th[^>]*abbr="Monday"[\s\S]*abbr="Sunday"/);
        expect(grid("es", 1).toLowerCase()).toContain('abbr="lunes"');
        expect(grid("pt", 1).toLowerCase()).toContain("segunda");
    });

    it("days outside min/max are announced and marked disabled", () => {
        const html = grid("es", 1, { min: "2026-10-10", max: "2026-10-25T12:00" });
        expect(html).toMatch(/data-dp-day="2026-10-09"[^>]*aria-label="[^"]*Fuera del rango permitido"[^>]*aria-disabled="true"/);
        expect(html).not.toMatch(/data-dp-day="2026-10-25"[^>]*aria-disabled/);
        expect(html).toMatch(/data-dp-day="2026-10-26"[^>]*aria-disabled="true"/);
    });

    it("each day is spelled out for a screen reader in the admin language", () => {
        expect(grid("es", 1)).toContain('aria-label="jueves, 22 de octubre de 2026"');
        expect(grid("en", 1)).toContain('aria-label="Thursday, October 22, 2026"');
    });
});

describe("the trigger", () => {
    const render = (el: React.ReactElement, lang: Language = "es") =>
        renderToStaticMarkup(<I18nProvider initialLanguage={lang}>{el}</I18nProvider>);

    it("is a button that opens a dialog and shows the value in the admin language", () => {
        const html = render(<DatePicker id="exp" value="2026-10-22" onChange={() => undefined} />);
        expect(html).toMatch(/<button[^>]*id="exp"[^>]*type="button"/);
        expect(html).toContain('aria-haspopup="dialog"');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('data-date-picker="date"');
        expect(html).toMatch(/id="exp-value"[^>]*>22 oct 2026</i);
        // Named by the caller's own <label htmlFor="exp">: no aria-label to replace it.
        expect(html).not.toMatch(/<button[^>]*aria-label=/);
    });

    it("a date-time picker keeps the datetime-local value and shows the time", () => {
        const html = render(<DateTimePicker ariaLabel="Publish at" value="2026-10-22T09:05" onChange={() => undefined} />, "en");
        expect(html).toContain('data-date-picker="datetime"');
        expect(html).toContain('data-value="2026-10-22T09:05"');
        expect(html).toMatch(/Oct 22, 2026, 09:05/);
        expect(html).toMatch(/aria-label="Publish at, Oct 22, 2026, 09:05"/);
    });

    it("an empty field shows its placeholder (or «Choose date»)", () => {
        expect(render(<DatePicker value="" onChange={() => undefined} />, "en")).toContain("Choose date");
        expect(render(<DatePicker value="" placeholder="No expiry" onChange={() => undefined} />, "en")).toContain("No expiry");
    });
});

describe("the core admin draws no native date picker", () => {
    it("no <input type=date|datetime-local|month|week> left in the core admin and the editor", () => {
        for (const file of [
            "app/admin/settings/site-address/page.tsx",
            "components/verso/editor/VersoEditor.tsx",
        ]) {
            // Code only: comments may still name the input they replaced.
            const src = readFileSync(resolve(SRC, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
            expect(src, file).not.toMatch(/type=["'](date|datetime-local|month|week)["']/);
            expect(src, file).toMatch(/<Date(Time)?Picker\b/);
        }
    });

    it("plugins reach it through the plugin UI kit (one host module, both lists in sync)", () => {
        const loader = readFileSync(resolve(SRC, "lib/pluginBundleLoader.ts"), "utf8");
        const build = readFileSync(resolve(SRC, "../../backend/scripts/build-plugin.js"), "utf8");
        expect(loader).toContain("'components/ui/DatePicker': h_datePicker");
        expect(build).toContain("'components/ui/DatePicker'");
    });
});
