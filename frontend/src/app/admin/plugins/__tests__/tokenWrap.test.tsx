import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import BreakableToken, { TOKEN_WRAP_CLASS, tokenParts } from "../BreakableToken";
import DeclaredRolesList from "../DeclaredRolesList";
import { PERMISSION_DETAILS_CLASS, PERMISSION_TOGGLE_CLASS, TOKEN_CLASS } from "../PermissionRow";

/**
 * Round 2 of the live review (iPhone 13 / iPhone SE, the activation and Permissions dialogs of a plugin
 * that declares a role): the monospace identifiers broke at any letter — «conference_manage|r_team»,
 * «conferenc|e_manager_team», «conference_manager_acce|ss» — and in the Permissions dialog the text column
 * stopped ~75 px short of the card's edge (it shared the row with the switch, all the way down).
 */

const HERE = path.resolve(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(HERE, f), "utf8");
const cls = (s: string) => s.split(/\s+/).filter(Boolean);

describe("an identifier wraps only between its parts", () => {
    it("tokenParts: pieces ending at _ : . / ,", () => {
        expect(tokenParts("conference_manager_team")).toEqual(["conference_", "manager_", "team"]);
        expect(tokenParts("roles:declare")).toEqual(["roles:", "declare"]);
        expect(tokenParts("a.b/c,d")).toEqual(["a.", "b/", "c,", "d"]);
        expect(tokenParts("plain")).toEqual(["plain"]);
        expect(tokenParts("trailing_")).toEqual(["trailing_"]);
        expect(tokenParts("")).toEqual([]);
        for (const t of ["conference_manager_access", "x__y", "::", "a-b_c"]) expect(tokenParts(t).join("")).toBe(t);
    });
    it("renders a <wbr> after each separator and nowhere else", () => {
        expect(renderToStaticMarkup(<BreakableToken text="conference_manager_team" />)).toBe("conference_<wbr/>manager_<wbr/>team");
        expect(renderToStaticMarkup(<BreakableToken text="team" />)).toBe("team");
    });
    it("kept whole on its own line when it fits (inline-block), never break-all", () => {
        expect(cls(TOKEN_WRAP_CLASS)).toEqual(expect.arrayContaining(["inline-block", "max-w-full", "break-words"]));
        expect(cls(TOKEN_CLASS)).toEqual(expect.arrayContaining(["inline-block", "break-words"]));
        expect(TOKEN_CLASS).not.toContain("break-all");
        for (const f of ["DeclaredRolesList.tsx", "PermissionRow.tsx", "page.tsx"]) {
            const code = read(f).split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
            expect(code, f).not.toMatch(/\bbreak-all\b/);
        }
    });
    it("the declared role's slug and each of its permissions are wrapped tokens", () => {
        const html = renderToStaticMarkup(
            <DeclaredRolesList heading="h" state="granted" capabilitiesLabel="Role permissions:"
                roles={[{ slug: "conference_manager_team", name: "Equipo", capabilities: ["conference_manager_access", "read_x"] }]} />,
        );
        const slug = /<span class="([^"]*)" data-declared-role-slug="">([\s\S]*?)<\/span>/.exec(html)!;
        expect(cls(slug[1])).toEqual(expect.arrayContaining(cls(TOKEN_WRAP_CLASS)));
        expect(slug[2]).toBe("conference_<wbr/>manager_<wbr/>team");
        const caps = [...html.matchAll(/<span class="([^"]*)" data-declared-role-capability="">([\s\S]*?)<\/span>/g)];
        expect(caps.map((m) => m[2])).toEqual(["conference_<wbr/>manager_<wbr/>access,", "read_<wbr/>x"]);
        for (const m of caps) expect(cls(m[1])).toEqual(expect.arrayContaining(cls(TOKEN_WRAP_CLASS)));
    });
    it("every token of the plugin screens goes through BreakableToken", () => {
        const page = read("page.tsx");
        expect(page).toContain("<span className={TOKEN_CLASS}><BreakableToken text={token} /></span>");
        expect(page).not.toContain("<span className={TOKEN_CLASS}>{token}</span>");
        expect(page).toContain("<BreakableToken text={plugin.slug} />");
        expect(read("PermissionRow.tsx")).toContain("<span className={TOKEN_CLASS}><BreakableToken text={token} /></span>");
    });
});

describe("the Permissions dialog: a permission's details use the whole width on a phone", () => {
    it("a grid: title line and switch on the first row, the details under them across both columns below 640 px", () => {
        expect(cls(PERMISSION_TOGGLE_CLASS)).toEqual(expect.arrayContaining(["grid", "grid-cols-[minmax(0,1fr)_auto]", "items-start"]));
        expect(cls(PERMISSION_DETAILS_CLASS)).toEqual(expect.arrayContaining(["col-span-2", "sm:col-span-1", "min-w-0"]));
        const page = read("page.tsx");
        const row = page.slice(page.indexOf("className={PERMISSION_TOGGLE_CLASS}"), page.indexOf("</button>", page.indexOf("className={PERMISSION_TOGGLE_CLASS}")));
        expect(row).toContain("data-permission-toggle={token}");
        // The switch sits on the first row, second column, whatever the order of the markup.
        expect(row).toMatch(/inline-flex h-6 w-11[^`]*col-start-2 row-start-1/);
        // Description, reason and declared roles are inside the details cell, not the title line.
        const details = row.slice(row.indexOf("className={PERMISSION_DETAILS_CLASS}"));
        for (const piece of ["{meta.description &&", "{reason &&", "<DeclaredRolesList"]) expect(details).toContain(piece);
        expect(row.slice(0, row.indexOf("className={PERMISSION_DETAILS_CLASS}"))).not.toContain("{meta.description &&");
    });
});
