/**
 * A SQUARE ICON BOX STAYS SQUARE.
 *
 * Live review (1280 px desktop, iPhone 13, iPhone SE): icon boxes drawn as `w-14 h-14 … flex items-center
 * justify-center` inside a flex ROW were squeezed into pills next to long text, because a flex item
 * shrinks by default and an icon's min-content width is tiny:
 *   - conference-manager «Campos» publisher card 27x56 (SE) / 42x56 (desktop); «Localidades» public-link
 *     card 38x56 (SE);
 *   - the core StatCard on the plugin's «Panel» tab 18-30x56, its labels clipped («INSCRIP», «HOTELE»)
 *     because the grid was six columns by the WINDOW's width in an ~860 px panel;
 *   - the core dashboard's «Comentarios Recientes» header icon 28x40, its quick-action icons 40-47x48;
 *   - the sidebar's rocket logo, taller than wide beside a long site name.
 *
 * Pinned here: the shared cards keep their icon (`shrink-0`) and let their text wrap; the stat grid sizes
 * its columns by the room it has; and a source sweep over every admin screen, dialog and the shell, the
 * shared components, the coordinators' portal and every conference-manager screen refuses a square icon
 * box that can shrink.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { StatCard } from "@/components/ui/StatCard";
import { ActionCard } from "@/components/ui/ActionCard";
import { STAT_GRID_CLASS } from "../../../../marketplace/plugins/conference-manager/client/lib/phoneLayout";
import { AA, contrastOf, textClassOf } from "@/lib/__tests__/helpers/tailwindContrast";

const FRONTEND = path.resolve(__dirname, "../../..");
const REPO = path.resolve(FRONTEND, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const classOf = (html: string, attr: string) => {
    const m = new RegExp(`<[a-z]+ class="([^"]*)"[^>]*${attr}`).exec(html);
    expect(m, attr).toBeTruthy();
    return m![1].split(/\s+/);
};

describe("the shared cards keep their icon square and let their text wrap", () => {
    it("StatCard: the icon does not shrink, the text column may, the label wraps and meets AA", () => {
        const html = renderToStaticMarkup(<StatCard icon="fa-users" label="Hospedajes por validar" value={0} />);
        expect(classOf(html, "data-stat-icon")).toEqual(expect.arrayContaining(["w-14", "h-14", "shrink-0"]));
        expect(classOf(html, "data-stat-text")).toEqual(expect.arrayContaining(["flex-1", "min-w-0"]));
        const label = classOf(html, "data-stat-label");
        expect(label).toContain("break-words");
        expect(contrastOf(textClassOf(label.join(" ")))).toBeGreaterThanOrEqual(AA);
    });
    it("ActionCard: the description wraps instead of being cut, in a colour that meets AA", () => {
        const html = renderToStaticMarkup(<ActionCard icon="fa-bed" title="Gestionar Alojamiento" description="Agregar hoteles y asignar habitaciones" />);
        const desc = classOf(html, "data-action-description");
        expect(desc).not.toContain("truncate");
        expect(desc).toContain("break-words");
        expect(contrastOf(textClassOf(desc.join(" ")))).toBeGreaterThanOrEqual(AA);
    });
});

describe("conference-manager «Panel»: the stat grid sizes its columns by its own width", () => {
    it("auto-fills 15rem columns instead of six columns by the window's width", () => {
        expect(STAT_GRID_CLASS.split(" ")).toContain("grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]");
        expect(STAT_GRID_CLASS).not.toMatch(/xl:grid-cols-6/);
        const page = read("marketplace/plugins/conference-manager/client/admin/page.tsx");
        expect(page).toContain('<div className={STAT_GRID_CLASS} data-cm-stat-grid="">');
    });
    it("the conference status is translated (it showed the raw «ACTIVE») in AA colours", () => {
        const page = read("marketplace/plugins/conference-manager/client/admin/page.tsx");
        expect(page).toMatch(/data-cm-conference-status=\{currentConference\.status\}>\s*\{t\(currentConference\.status\)\}/);
        for (const [fg, bg] of [["text-emerald-700", "bg-emerald-50"], ["text-gray-600", "bg-gray-50"], ["text-amber-700", "bg-amber-50"]]) {
            expect(contrastOf(fg, bg), fg).toBeGreaterThanOrEqual(AA);
        }
    });
});

describe("the core dashboard", () => {
    const src = read("frontend/src/app/admin/page.tsx");
    it("the system-status values wrap instead of being cut («Conectado (…»)", () => {
        expect(src).toContain('<p className="text-xs font-bold text-gray-700 break-words" data-health-detail="">{detail}</p>');
    });
    it("a quick action's text column may shrink beside its icon", () => {
        expect(src).toContain('<div className="min-w-0" data-quick-action-text="">');
    });
    it("«Aún no hay comentarios» meets AA (it was gray-400 under opacity-50: 1.56:1)", () => {
        const block = /<div className="([^"]*)" data-dashboard-no-comments="">[\s\S]*?<p className="([^"]*)">\{t\('dashboard\.no\.comments\.yet'\)\}/.exec(src);
        expect(block).toBeTruthy();
        expect(block![1]).not.toMatch(/opacity-/);
        expect(contrastOf(textClassOf(block![2]))).toBeGreaterThanOrEqual(AA);
    });
});

// ── The sweep ─────────────────────────────────────────────────────────────────────────────────────────
const CLASS_RE = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
const SQUARE_RE = /(^|\s)(w-(\d+(?:\.\d+)?)\s+h-\3|h-(\d+(?:\.\d+)?)\s+w-\4)(?=\s|$)/;
const EXEMPT_RE = /(^|\s)(shrink-0|flex-shrink-0|flex-none|absolute|fixed)(?=\s|$)/;

/**
 * Square, fixed-size, content-centring boxes (icon boxes) that a flex row may shrink. In a template
 * literal, a size chosen inside `${cond ? "…" : "…"}` needs `shrink-0` in the static classes or in that
 * same branch: one branch carrying it does not cover the other.
 */
function shrinkableSquareBoxes(src: string): { line: number; classes: string }[] {
    const out: { line: number; classes: string }[] = [];
    let m: RegExpExecArray | null;
    CLASS_RE.lastIndex = 0;
    while ((m = CLASS_RE.exec(src))) {
        const body = m[1] ?? m[2];
        if (!/(^|\s)justify-center(?=\s|$)/.test(body)) continue;
        const staticPart = body.replace(/\$\{[^}]*\}/g, " ");
        if (EXEMPT_RE.test(staticPart)) continue;
        const branches = (body.match(/\$\{[^}]*\}/g) || []).flatMap((e) => e.match(/"[^"]*"|'[^']*'/g) || []).map((q) => q.slice(1, -1));
        const offending = SQUARE_RE.test(staticPart) || branches.some((b) => SQUARE_RE.test(b) && !EXEMPT_RE.test(b));
        if (offending) out.push({ line: src.slice(0, m.index).split("\n").length, classes: body.replace(/\s+/g, " ").trim() });
    }
    return out;
}

function tsxUnder(rel: string): string[] {
    const dir = path.join(REPO, rel);
    const found: string[] = [];
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name === "node_modules" || e.name === "__tests__" || e.name.startsWith(".")) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(".tsx")) found.push(path.relative(REPO, p).replace(/\\/g, "/"));
        }
    };
    walk(dir);
    return found;
}

/** The .tsx files directly in `rel` (not its subdirectories). */
function tsxIn(rel: string): string[] {
    return fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".tsx"))
        .map((e) => `${rel}/${e.name}`);
}

// The whole admin (every screen, its dialogs and the shell), the shared components it is built from, the
// coordinators' portal and every conference-manager screen. Left out: the Verso editor's own UI
// (components/verso) and the public site's chrome (components/chrome), which have their own design rules.
const SWEPT = Array.from(new Set([
    ...tsxUnder("frontend/src/app/admin"),
    ...tsxIn("frontend/src/components"),
    ...tsxUnder("frontend/src/components/ui"),
    ...tsxUnder("frontend/src/components/editor"),
    ...tsxUnder("frontend/src/app/portal/conference"),
    ...tsxUnder("marketplace/plugins/conference-manager/client"),
]));

describe("sweep: no square icon box that can shrink", () => {
    it("the detector finds the live-review case and accepts the fix", () => {
        expect(shrinkableSquareBoxes('<div className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl">')).toHaveLength(1);
        expect(shrinkableSquareBoxes("<div className={`w-10 h-10 rounded-2xl ${c} flex items-center justify-center`}>")).toHaveLength(1);
        expect(shrinkableSquareBoxes('<div className="w-14 h-14 shrink-0 rounded-2xl flex items-center justify-center">')).toHaveLength(0);
        expect(shrinkableSquareBoxes('<img className="w-14 h-14 rounded-lg object-cover" />')).toHaveLength(0);
        // One branch of a conditional size does not cover the other.
        expect(shrinkableSquareBoxes('<div className={`flex justify-center ${c ? "w-9 h-9 shrink-0" : "w-10 h-10"}`}>')).toHaveLength(1);
        expect(shrinkableSquareBoxes('<div className={`shrink-0 flex justify-center ${c ? "w-9 h-9" : "w-10 h-10"}`}>')).toHaveLength(0);
    });
    it(`covers ${SWEPT.length} files, and the screens of the live review are among them`, () => {
        for (const f of ["marketplace/plugins/conference-manager/client/admin/page.tsx", "frontend/src/components/ui/StatCard.tsx", "frontend/src/app/admin/page.tsx",
            "frontend/src/components/Sidebar.tsx", "frontend/src/app/admin/users/UserFormModal.tsx", "frontend/src/app/admin/account/page.tsx"]) {
            expect(SWEPT).toContain(f);
        }
    });
    it.each(SWEPT)("%s", (file) => {
        expect(shrinkableSquareBoxes(read(file))).toEqual([]);
    });
});
