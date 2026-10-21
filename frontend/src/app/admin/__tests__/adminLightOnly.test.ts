/**
 * The admin is a LIGHT design (white cards, gray-900 text). With the OS in dark mode it used to turn
 * half-dark: admin-globals.css flipped --foreground to #ededed, so every text that inherits its colour
 * went near-white on the white cards (1.17:1 — Media storage's options, the Network legend), and the
 * Security Center was the one screen carrying `dark:` utilities, painting white titles on its light
 * cards. These guards keep both from coming back. (The Verso editor's own dark palette lives in
 * editor-theme.css, scoped to .verso-container, and is not part of this check.)
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(__dirname, "../../..");

function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
        if (e === "__tests__" || e === "node_modules") continue;
        const f = join(dir, e);
        if (statSync(f).isDirectory()) walk(f, out);
        else if (/\.(tsx?|jsx?)$/.test(e)) out.push(f);
    }
    return out;
}

describe("admin stays light under an OS dark mode", () => {
    it("admin-globals.css does not flip the admin colours on prefers-color-scheme: dark", () => {
        const css = readFileSync(join(SRC, "app/admin/admin-globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        expect(css).not.toMatch(/prefers-color-scheme:\s*dark/);
        expect(css).toMatch(/color-scheme:\s*light/);
    });

    it("no admin screen or shared component carries `dark:` utilities", () => {
        const offenders: string[] = [];
        for (const file of [...walk(join(SRC, "app/admin")), ...walk(join(SRC, "components"))]) {
            const src = readFileSync(file, "utf8");
            // A Tailwind variant inside a class string: `dark:bg-gray-800`, never the word "dark" itself.
            const m = src.match(/["'`\s]dark:[a-z[]/);
            if (m) offenders.push(file.slice(SRC.length + 1));
        }
        expect(offenders).toEqual([]);
    });
});
