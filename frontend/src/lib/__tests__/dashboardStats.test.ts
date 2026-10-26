import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
    dashboardSections, STAT_GRID_COLS, HEALTH_GRID_CLASS, QUICK_ACTIONS_GRID_CLASS, DASHBOARD_LAYOUT,
    HEALTH_LABEL_ROW_CLASS, HEALTH_LABEL_CLASS, HEALTH_DOT_CLASS, DASHBOARD_COLUMNS_CLASS, dashboardMainSpanClass,
} from "../dashboardStats";
import { translations } from "../i18n";
import { AA, contrastOf, textClassOf } from "./helpers/tailwindContrast";

/**
 * THE DASHBOARD SHOWS ONLY WHAT ITS VIEWER CAN READ.
 *
 * Live finding: an editor's dashboard said «0 USUARIOS» — the editor cannot list users (GET /users needs
 * `list_users`), so the page never loaded them and drew its initial 0 as if it were the site's number.
 * The same held for the comments count and panel (loaded for `moderate_comments` only) and for the
 * activity chart (GET /analytics/stats is administrators-only).
 */

const can = (caps: string[], role = "") => (c: string) => role === "administrator" || caps.includes("*") || caps.includes(c);

describe("dashboardSections", () => {
    it("an editor: posts, pages and comments — no users count, no activity chart", () => {
        const caps = ["edit_posts", "edit_pages", "moderate_comments", "manage_categories"];
        const s = dashboardSections({ role: "editor" }, can(caps));
        expect(s.stats).toEqual(["posts", "pages", "comments"]);
        expect(s.recentComments).toBe(true);
        expect(s.activityChart).toBe(false);
        expect(s.systemHealth).toBe(false);
    });

    it("a contributor or author: posts and pages only, and no comments panel", () => {
        const s = dashboardSections({ role: "author" }, can(["edit_posts", "upload_files"]));
        expect(s.stats).toEqual(["posts", "pages"]);
        expect(s.recentComments).toBe(false);
        expect(s.activityChart).toBe(false);
    });

    it("an administrator keeps everything", () => {
        const s = dashboardSections({ role: "administrator" }, can([], "administrator"));
        expect(s.stats).toEqual(["posts", "pages", "comments", "users"]);
        expect(s.recentComments).toBe(true);
        expect(s.activityChart).toBe(true);
        expect(s.systemHealth).toBe(true);
    });

    it("a custom role with list_users sees the users count; the chart follows the administrator ROLE (the endpoint's gate)", () => {
        const s = dashboardSections({ role: "people_manager" }, can(["edit_posts", "list_users", "*"]));
        expect(s.stats).toContain("users");
        expect(s.activityChart).toBe(false);
    });

    it("a custom role holding manage_options does not ask for the administrators-only system health (its 403 blanked every count)", () => {
        const s = dashboardSections({ role: "site_manager" }, can(["edit_posts", "manage_options"]));
        expect(s.systemHealth).toBe(false);
    });

    it("in a network, system health is the main site's network administrators' (GET /health/details)", () => {
        const admin = can([], "administrator");
        expect(dashboardSections({ role: "administrator", network: { mainSite: true, networkAdmin: true } }, admin).systemHealth).toBe(true);
        expect(dashboardSections({ role: "administrator", network: { mainSite: true, networkAdmin: false } }, admin).systemHealth).toBe(false);
        expect(dashboardSections({ role: "administrator", network: { mainSite: false, networkAdmin: false } }, admin).systemHealth).toBe(false);
    });

    it("the dashboard page asks for system health through dashboardSections, and a failure there cannot reject the load", async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const src = fs.readFileSync(path.resolve(__dirname, "../../app/admin/page.tsx"), "utf8");
        expect(src).toContain("sections.systemHealth ? systemApi.getStatus().catch(() => null)");
        expect(src).not.toMatch(/can\('manage_options'\) \? systemApi/);
    });

    it("has a literal column class for every possible count", () => {
        for (const n of [1, 2, 3, 4]) expect(STAT_GRID_COLS[n]).toMatch(n === 1 ? /^grid-cols-1$/ : new RegExp(`@min-\\[[\\d.]+rem\\]:grid-cols-${n}$`));
    });
});

/**
 * NO DASHBOARD LABEL BREAKS INSIDE A WORD (lib/dashboardStats.ts).
 *
 * Live finding (1280x800): the system-health label «ALMACENAMIENTO» broke «ALMACENAM» / «IENTO» and its
 * green status dot touched the text. The panel is ~565 px wide there (beside the sidebar and the comments
 * column); `sm:grid-cols-3` — a WINDOW breakpoint — made three ~178 px cards with a ~72 px label line, and
 * `break-words` cut the word to fit. The stat cards (`lg:grid-cols-4`, ~134 px at 1024 px) and the quick
 * actions (`sm:grid-cols-2`, ~189 px at 1024 px) had the same flaw for «PUBLICACIONES» / «Publicación».
 *
 * Each grid now picks its columns by its OWN width (container queries). Below, every threshold is turned
 * back into the narrowest card it allows, and that card must hold the widest single word of its labels in
 * es, en and pt. Px per character: the measured widest words in the admin's Inter («ALMACENAMIENTO» 114 px
 * = 8.2/char at 10px/900/uppercase/0.1em; «Publicación» 80 px = 7.3/char at 14px/700), plus a margin.
 */
describe("the dashboard's grids leave every word whole", () => {
    const LANGS = ["es", "en", "pt"] as const;
    const PX_PER_CHAR = { upperBlack10: 8.6, bold14: 7.8, upperBold10: 7.8, blackItalic20: 9.8 };
    const widestWord = (keys: string[], perChar: number) => {
        let best = { word: "", px: 0 };
        for (const lang of LANGS) for (const key of keys) {
            const text = translations[lang][key];
            expect(text, `${lang}:${key}`).toBeTruthy();
            for (const word of text.split(/\s+/)) if (word.length * perChar > best.px) best = { word, px: word.length * perChar };
        }
        return best;
    };
    // `@min-[48rem]:grid-cols-3` → 768 px container, 3 columns.
    const breakpoint = (cls: string, cols: number) => {
        const m = new RegExp(String.raw`@min-\[([\d.]+)rem\]:grid-cols-${cols}(?:\s|$)`).exec(cls);
        expect(m, `${cls} has a container breakpoint for ${cols} columns`).toBeTruthy();
        return Number(m![1]) * 16;
    };
    const narrowestCard = (containerPx: number, cols: number, gap: number) => (containerPx - (cols - 1) * gap) / cols;

    it("system health: three columns only where each label line holds «ALMACENAMIENTO»; otherwise one per row", () => {
        const word = widestWord(["dashboard.health.database", "dashboard.health.security", "dashboard.health.storage"], PX_PER_CHAR.upperBlack10);
        expect(word.word.toUpperCase()).toBe("ALMACENAMIENTO");
        const tokens = HEALTH_GRID_CLASS.split(/\s+/);
        expect(tokens).toContain("grid-cols-1");
        expect(tokens.filter((k) => /grid-cols-/.test(k))).toHaveLength(2); // one per row, or all three: never two-and-one
        const card = narrowestCard(breakpoint(HEALTH_GRID_CLASS, 3), 3, DASHBOARD_LAYOUT.healthGap);
        expect(card - DASHBOARD_LAYOUT.healthChrome).toBeGreaterThanOrEqual(word.px);
        // What the window breakpoint gave at 1280 px (565 px panel): a 72 px line, far under the word.
        expect(narrowestCard(565, 3, DASHBOARD_LAYOUT.healthGap) - DASHBOARD_LAYOUT.healthChrome).toBeLessThan(word.px);
    });

    it("stat cards: every column count keeps «PUBLICACIONES» whole", () => {
        const word = widestWord(["nav.posts", "nav.pages", "nav.comments", "nav.users"], PX_PER_CHAR.upperBlack10);
        for (const n of [2, 3, 4]) {
            for (const cols of [2, n]) {
                if (!STAT_GRID_COLS[n].includes(`grid-cols-${cols}`)) continue;
                const card = narrowestCard(breakpoint(STAT_GRID_COLS[n], cols), cols, DASHBOARD_LAYOUT.statGap);
                expect(card - DASHBOARD_LAYOUT.statChrome, `${n} cards in ${cols} columns`).toBeGreaterThanOrEqual(word.px);
            }
        }
        expect(STAT_GRID_COLS[4]).not.toMatch(/grid-cols-3/); // four cards never go three-and-one
    });

    it("quick actions: two columns only where «Publicación» and the sub-labels fit their line", () => {
        const label = widestWord(["dashboard.new.post", "dashboard.new.page", "dashboard.add.media", "dashboard.add.user"], PX_PER_CHAR.bold14);
        const sub = widestWord(["dashboard.new.post.sub", "dashboard.new.page.sub", "dashboard.add.media.sub", "dashboard.add.user.sub"], PX_PER_CHAR.upperBold10);
        const line = narrowestCard(breakpoint(QUICK_ACTIONS_GRID_CLASS, 2), 2, DASHBOARD_LAYOUT.quickGap) - DASHBOARD_LAYOUT.quickChrome;
        expect(line).toBeGreaterThanOrEqual(Math.max(label.px, sub.px));
    });

    it("the page's two columns: «Comentarios recientes» sits beside the main column only where its title fits (by the page's own width)", () => {
        // Live (1024 px): `lg:grid-cols-3` by the window left the side panel ~181 px — «Comentarios» had 65 px.
        const title = widestWord(["dashboard.recent.comments"], PX_PER_CHAR.blackItalic20);
        const panelTitleLine = (containerPx: number) => narrowestCard(containerPx, 3, DASHBOARD_LAYOUT.columnsGap) - DASHBOARD_LAYOUT.commentsChrome;
        expect(panelTitleLine(breakpoint(DASHBOARD_COLUMNS_CLASS, 3))).toBeGreaterThanOrEqual(title.px);
        expect(panelTitleLine(1024 - 320 - 2 * 48)).toBeLessThan(title.px);   // what the window breakpoint gave at 1024 px
        // 1280 px with the sidebar open, even with a 17 px scrollbar, keeps the two columns it always had.
        expect(breakpoint(DASHBOARD_COLUMNS_CLASS, 3)).toBeLessThanOrEqual(1280 - 320 - 2 * 48 - 17);
        expect(dashboardMainSpanClass(true)).toBe("@min-[50rem]:col-span-2");
        expect(dashboardMainSpanClass(false)).toBe("@min-[50rem]:col-span-3");
        const src = fs.readFileSync(path.resolve(__dirname, "../../app/admin/page.tsx"), "utf8");
        expect(src).toMatch(/<div className="@container px-4 py-6 sm:p-8 md:p-12[^"]*" data-dashboard-root="">/);
        expect(src).toContain('<div className={DASHBOARD_COLUMNS_CLASS} data-dashboard-columns="">');
        expect(src).toContain('<div className={`${dashboardMainSpanClass(sections.recentComments)} space-y-8`} data-dashboard-main="">');
        expect(src).not.toMatch(/lg:grid-cols-3|lg:col-span-[23]/);
    });

    it("the small health pill in the header never wraps its labels («SQLITE-» / «NATIVE» at 1024 px)", () => {
        const src = fs.readFileSync(path.resolve(__dirname, "../../app/admin/page.tsx"), "utf8");
        expect(src).toMatch(/className="hidden lg:flex shrink-0 [^"]*" data-dashboard-mini-pill=""/);
        expect((src.match(/whitespace-nowrap" data-dashboard-mini-health=""/g) || []).length).toBe(2);
    });

    it("a health label wraps only between words, the status dot keeps its own room, and the label meets AA on the card", () => {
        const label = HEALTH_LABEL_CLASS.split(/\s+/);
        expect(label).toContain("break-normal");
        expect(label).not.toContain("break-words");
        expect(label).not.toContain("break-all");
        expect(HEALTH_LABEL_ROW_CLASS.split(/\s+/)).toEqual(expect.arrayContaining(["flex", "gap-2"]));
        expect(HEALTH_DOT_CLASS.split(/\s+/)).toEqual(expect.arrayContaining(["shrink-0", "w-2", "h-2"]));
        expect(contrastOf(textClassOf(HEALTH_LABEL_CLASS), "gray-50")).toBeGreaterThanOrEqual(AA);
    });

    it("the dashboard page renders the three grids inside @container wrappers with these classes — no window breakpoints", () => {
        const src = fs.readFileSync(path.resolve(__dirname, "../../app/admin/page.tsx"), "utf8");
        expect(src).toMatch(/<div className="@container">\s*<div className=\{`grid \$\{STAT_GRID_COLS\[sections\.stats\.length\]/);
        expect(src).toMatch(/<div className="@container">\s*<div className=\{HEALTH_GRID_CLASS\} data-dashboard-health="">/);
        expect(src).toMatch(/<div className="@container">\s*<div className=\{QUICK_ACTIONS_GRID_CLASS\} data-dashboard-quick-actions="">/);
        expect(src).toContain('<div className={HEALTH_LABEL_ROW_CLASS}>');
        expect(src).toContain('<p className={HEALTH_LABEL_CLASS} data-health-label="">{label}</p>');
        expect(src).toContain('<span className={`${HEALTH_DOT_CLASS} ${C.dot} animate-pulse`} data-health-dot=""></span>');
        for (const old of ["sm:grid-cols-3", "md:grid-cols-2 ", "lg:grid-cols-4", 'grid grid-cols-1 sm:grid-cols-2 gap-4']) expect(src).not.toContain(old);
    });

    it("the dashboard's small grey text meets AA (header welcome line, mini health pill, chart subtitle and period buttons, comment dates)", () => {
        const src = fs.readFileSync(path.resolve(__dirname, "../../app/admin/page.tsx"), "utf8");
        const classOf = (marker: string) => {
            const m = new RegExp(`className="([^"]*)"[^>]*${marker}`).exec(src);
            expect(m, marker).toBeTruthy();
            return m![1];
        };
        expect(contrastOf(textClassOf(classOf("data-dashboard-welcome")), "gray-50")).toBeGreaterThanOrEqual(AA);
        expect(contrastOf(textClassOf(classOf("data-dashboard-mini-health")), "white")).toBeGreaterThanOrEqual(AA);
        expect(src).not.toMatch(/text-gray-400[^"]*">\{t\('dashboard\.traffic\.engagement'\)\}/);
        expect(src).toContain("'bg-gray-100 text-gray-600 hover:bg-gray-200'");
        expect(contrastOf("text-gray-600", "gray-100")).toBeGreaterThanOrEqual(AA);
        expect(src).toContain("'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'");
        expect(src).not.toMatch(/text-\[9px\][^"]*text-gray-400/);
    });
});
